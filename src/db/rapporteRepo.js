// Rapporte: Dokumente, die nur zur Kenntnis gehen (kein Rechnungsweg). Reine SQL-Schicht.
// kenntnisnahmen ist append-only: bestaetigte Zeilen sind per Trigger unveraenderlich, DELETE ist
// verboten -- Entfernen/Ersetzen markiert Zeilen daher nur mit entfernt_am.
import { getJobById } from './jobsRepo.js';

// Eine Kenntnisnahme ist "offen", solange sie weder bestätigt noch entfernt/ersetzt wurde.
const OFFEN = 'bestaetigt_am IS NULL AND entfernt_am IS NULL';

// Geschachtelt aufrufbar: in einer bereits offenen Transaktion (z. B. Service, der zusaetzlich
// freigaben und Mails schreibt) wird ein SAVEPOINT statt eines zweiten BEGIN verwendet.
// Führt `fn` atomar aus: eigene Transaktion, oder SAVEPOINT, falls der Aufrufer schon eine offen hat.
function inTransaktion(db, fn) {
  const verschachtelt = db.isTransaction;
  db.exec(verschachtelt ? 'SAVEPOINT rapport_tx' : 'BEGIN IMMEDIATE');
  try {
    const ergebnis = fn();
    db.exec(verschachtelt ? 'RELEASE rapport_tx' : 'COMMIT');
    return ergebnis;
  } catch (err) {
    if (verschachtelt) db.exec('ROLLBACK TO rapport_tx; RELEASE rapport_tx');
    else db.exec('ROLLBACK');
    throw err;
  }
}

// Wandelt einen zugewiesenen Vorgang in einen Rapport um (Typ 'rapport', Status 'kenntnisnahme'), leert die
// Rechnungsfelder und legt je Empfänger:in eine Kenntnisnahme-Zeile an. @returns {boolean} false, wenn der Vorgang
// nicht (mehr) im Status 'zugewiesen' war.
export function markiereAlsRapport(db, jobId, { markiertVon, empfaengerIds, bemerkung, zeitpunkt }) {
  const empfaenger = [...new Set(empfaengerIds.map(String))];
  return inTransaktion(db, () => {
    const result = db
      .prepare(
        `UPDATE jobs
         SET typ = 'rapport', status = 'kenntnisnahme', rapport_markiert_von = ?, rapport_markiert_am = ?,
             rapport_bemerkung = ?, rapport_eskaliert_am = NULL,
             konto_id = NULL, hinweis_konto_id = NULL, kreditor_id = NULL, lieferant = NULL, betrag = NULL,
             zahlungsziel = NULL, rechnungsnummer = NULL,
             freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0,
             freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL, freigabe2_eskaliert_an_admin = 0
         WHERE id = ? AND status = 'zugewiesen'`
      )
      .run(markiertVon, zeitpunkt, bemerkung ?? null, jobId);
    if (result.changes === 0) return false;
    const insert = db.prepare('INSERT INTO kenntnisnahmen (job_id, person_id, zugeteilt_am) VALUES (?, ?, ?)');
    for (const personId of empfaenger) insert.run(jobId, personId, zeitpunkt);
    return true;
  });
}

// Alle Zeilen (auch bestätigte, entfernte, ersetzte) – Grundlage für Verlauf und Sichtrecht.
export function listKenntnisnahmen(db, jobId) {
  return db.prepare('SELECT * FROM kenntnisnahmen WHERE job_id = ? ORDER BY id').all(jobId);
}

// Nur noch offene Zeilen.
export function listOffeneKenntnisnahmen(db, jobId) {
  return db.prepare(`SELECT * FROM kenntnisnahmen WHERE job_id = ? AND ${OFFEN} ORDER BY id`).all(jobId);
}

// @returns {'bestaetigt'|'bereits'|'nicht_berechtigt'}
export function bestaetigeKenntnisnahme(db, jobId, personId, zeitpunkt) {
  const result = db
    .prepare(`UPDATE kenntnisnahmen SET bestaetigt_am = ? WHERE job_id = ? AND person_id = ? AND ${OFFEN}`)
    .run(zeitpunkt, jobId, personId);
  if (result.changes > 0) return 'bestaetigt';
  const bereits = db
    .prepare('SELECT 1 FROM kenntnisnahmen WHERE job_id = ? AND person_id = ? AND bestaetigt_am IS NOT NULL')
    .get(jobId, personId);
  return bereits ? 'bereits' : 'nicht_berechtigt';
}

// Setzt den Rapport auf 'abgeschlossen', wenn niemand mehr offen und mindestens eine Person bestätigt hat.
export function schliesseRapportAbWennVollstaendig(db, jobId, zeitpunkt) {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'abgeschlossen', abgeschlossen_am = ?
       WHERE id = ? AND status = 'kenntnisnahme'
         AND NOT EXISTS (SELECT 1 FROM kenntnisnahmen k WHERE k.job_id = jobs.id AND k.bestaetigt_am IS NULL AND k.entfernt_am IS NULL)
         AND EXISTS (SELECT 1 FROM kenntnisnahmen k WHERE k.job_id = jobs.id AND k.bestaetigt_am IS NOT NULL)`
    )
    .run(zeitpunkt, jobId);
  return result.changes > 0;
}

// Macht die Rapport-Markierung rückgängig (zurück auf 'zugewiesen'); nur solange noch niemand bestätigt hat.
export function hebeRapportMarkierungAuf(db, jobId) {
  return inTransaktion(db, () => {
    const bestaetigt = db.prepare('SELECT 1 FROM kenntnisnahmen WHERE job_id = ? AND bestaetigt_am IS NOT NULL').get(jobId);
    if (bestaetigt) return false;
    const result = db
      .prepare(
        `UPDATE jobs
         SET status = 'zugewiesen', zugewiesen_an = rapport_markiert_von, typ = NULL,
             rapport_markiert_von = NULL, rapport_markiert_am = NULL, rapport_bemerkung = NULL, rapport_eskaliert_am = NULL
         WHERE id = ? AND status = 'kenntnisnahme'`
      )
      .run(jobId);
    if (result.changes === 0) return false;
    db.prepare(`UPDATE kenntnisnahmen SET entfernt_am = ?, begruendung = 'Markierung aufgehoben' WHERE job_id = ? AND ${OFFEN}`)
      .run(new Date().toISOString(), jobId);
    return true;
  });
}

// Tauscht eine offene Empfänger:in aus (Admin): alte Zeile wird als ersetzt markiert, neue angelegt. @returns {number|null} neue id
export function ersetzeEmpfaenger(db, kenntnisnahmeId, { neuePersonId, von, begruendung, zeitpunkt }) {
  return inTransaktion(db, () => {
    const alt = db.prepare(`SELECT * FROM kenntnisnahmen WHERE id = ? AND ${OFFEN}`).get(kenntnisnahmeId);
    if (!alt) return null;
    const neu = db
      .prepare('INSERT INTO kenntnisnahmen (job_id, person_id, zugeteilt_am) VALUES (?, ?, ?)')
      .run(alt.job_id, String(neuePersonId), zeitpunkt);
    const neuId = Number(neu.lastInsertRowid);
    db.prepare('UPDATE kenntnisnahmen SET entfernt_am = ?, entfernt_von = ?, begruendung = ?, ersetzt_durch_id = ? WHERE id = ?')
      .run(zeitpunkt, von, begruendung ?? null, neuId, kenntnisnahmeId);
    db.prepare('UPDATE jobs SET rapport_eskaliert_am = NULL WHERE id = ?').run(alt.job_id);
    return neuId;
  });
}

// Entfernt eine offene Empfänger:in. @returns {'entfernt'|'nicht_offen'|'letzter_offen_ohne_bestaetigung'}
export function entferneEmpfaenger(db, kenntnisnahmeId, { von, begruendung, zeitpunkt }) {
  return inTransaktion(db, () => {
    const zeile = db.prepare(`SELECT * FROM kenntnisnahmen WHERE id = ? AND ${OFFEN}`).get(kenntnisnahmeId);
    if (!zeile) return 'nicht_offen';
    const weitereOffene = db
      .prepare(`SELECT COUNT(*) AS n FROM kenntnisnahmen WHERE job_id = ? AND ${OFFEN} AND id <> ?`)
      .get(zeile.job_id, kenntnisnahmeId).n;
    if (weitereOffene === 0) {
      const bestaetigt = db.prepare('SELECT 1 FROM kenntnisnahmen WHERE job_id = ? AND bestaetigt_am IS NOT NULL').get(zeile.job_id);
      if (!bestaetigt) return 'letzter_offen_ohne_bestaetigung';
    }
    db.prepare('UPDATE kenntnisnahmen SET entfernt_am = ?, entfernt_von = ?, begruendung = ? WHERE id = ?')
      .run(zeitpunkt, von, begruendung ?? null, kenntnisnahmeId);
    return 'entfernt';
  });
}

// Rapporte, die die Person noch bestätigen muss ("Zur Kenntnis" im Dashboard).
export function listOffeneRapporteForPerson(db, personId) {
  return db
    .prepare(
      `SELECT DISTINCT j.* FROM jobs j JOIN kenntnisnahmen k ON k.job_id = j.id
       WHERE j.status = 'kenntnisnahme' AND k.person_id = ? AND k.bestaetigt_am IS NULL AND k.entfernt_am IS NULL
       ORDER BY j.rapport_markiert_am`
    )
    .all(personId);
}

// Offene Zeilen, die seit mehr als `stunden` zugeteilt und noch nie erinnert wurden (Cron `rapport-erinnerungen`).
export function listRapporteFuerErinnerung(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT k.* FROM kenntnisnahmen k JOIN jobs j ON j.id = k.job_id
       WHERE j.status = 'kenntnisnahme' AND k.bestaetigt_am IS NULL AND k.entfernt_am IS NULL
         AND k.erinnert_am IS NULL AND k.zugeteilt_am < ? ORDER BY k.id`
    )
    .all(schwelle);
  return rows.map((kenntnisnahme) => ({ kenntnisnahme, job: getJobById(db, kenntnisnahme.job_id) }));
}

// Nur setzen, wenn noch nicht gesetzt: false, wenn ein paralleler Lauf schneller war.
export function markErinnert(db, kenntnisnahmeId) {
  return db
    .prepare('UPDATE kenntnisnahmen SET erinnert_am = ? WHERE id = ? AND erinnert_am IS NULL')
    .run(new Date().toISOString(), kenntnisnahmeId).changes > 0;
}

// Rapporte mit überfälliger, deaktivierter oder nicht mehr auflösbarer Empfänger:in, noch nicht eskaliert.
export function listRapporteFuerEskalation(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT j.* FROM jobs j
       WHERE j.status = 'kenntnisnahme' AND j.rapport_eskaliert_am IS NULL
         AND EXISTS (
           SELECT 1 FROM kenntnisnahmen k JOIN personen p ON p.churchtools_person_id = k.person_id
           WHERE k.job_id = j.id AND k.bestaetigt_am IS NULL AND k.entfernt_am IS NULL
             AND (k.zugeteilt_am < ? OR p.aktiv = 0 OR p.ct_person_unresolved = 1)
         )
       ORDER BY j.rapport_markiert_am`
    )
    .all(schwelle);
}

// Rapporte, die abgeschlossen werden könnten, es aber nicht sind (0 offen, ≥1 bestätigt): z. B. wenn
// Stempel/TSA beim letzten Versuch scheiterten oder der letzte offene Empfänger entfernt wurde.
export function listRapportIdsZumAbschliessen(db) {
  return db
    .prepare(
      `SELECT j.id FROM jobs j
       WHERE j.status = 'kenntnisnahme'
         AND NOT EXISTS (SELECT 1 FROM kenntnisnahmen k WHERE k.job_id = j.id AND k.bestaetigt_am IS NULL AND k.entfernt_am IS NULL)
         AND EXISTS (SELECT 1 FROM kenntnisnahmen k WHERE k.job_id = j.id AND k.bestaetigt_am IS NOT NULL)
       ORDER BY j.id`
    )
    .all()
    .map((r) => r.id);
}

// Setzt die Eskalationsmarke nur einmal. @returns {boolean} false, wenn schon gesetzt (paralleler Lauf)
export function markRapportEskaliert(db, jobId, zeitpunkt) {
  return db
    .prepare('UPDATE jobs SET rapport_eskaliert_am = ? WHERE id = ? AND rapport_eskaliert_am IS NULL')
    .run(zeitpunkt, jobId).changes > 0;
}

// Auch entfernte/ersetzte Zeilen zählen: wer je Empfänger war, darf den Rapport weiter ansehen.
export function hatKenntnisnahmeZeile(db, jobId, personId) {
  return Boolean(db.prepare('SELECT 1 FROM kenntnisnahmen WHERE job_id = ? AND person_id = ? LIMIT 1').get(jobId, personId));
}
