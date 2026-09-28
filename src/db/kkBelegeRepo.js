const BEARBEITBAR = "status IN ('offen', 'entwurf')";

export function createKkBeleg(db, { kreditkarteId, hochgeladenVon, gekauftVon, quelle, pdfPfad, thumbnailPfad, betrag, waehrung = 'CHF', kaufdatum, beschreibung, kontoId, status }) {
  const result = db
    .prepare(
      `INSERT INTO kk_belege (kreditkarte_id, hochgeladen_von, gekauft_von, hochgeladen_am, quelle, pdf_pfad, thumbnail_pfad,
                              betrag, waehrung, kaufdatum, beschreibung, konto_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kreditkarteId ?? null, hochgeladenVon, gekauftVon ?? hochgeladenVon, new Date().toISOString(), quelle, pdfPfad, thumbnailPfad ?? null,
      betrag ?? null, waehrung || 'CHF', kaufdatum ?? null, beschreibung ?? null, kontoId ?? null, status
    );
  return Number(result.lastInsertRowid);
}

export function getKkBelegById(db, id) {
  return db.prepare('SELECT * FROM kk_belege WHERE id = ?').get(id) ?? null;
}

export function updateKkBelegDaten(db, id, { kreditkarteId, betrag, kaufdatum, beschreibung, kontoId, gekauftVon }) {
  const result = db
    .prepare(
      `UPDATE kk_belege SET kreditkarte_id = ?, betrag = ?, kaufdatum = ?, beschreibung = ?, konto_id = ?, gekauft_von = ?
       WHERE id = ? AND ${BEARBEITBAR}`
    )
    .run(kreditkarteId, betrag, kaufdatum, beschreibung, kontoId ?? null, gekauftVon, id);
  return result.changes > 0;
}

// Ein per Mail eingegangener Beleg landet als 'entwurf' (Karte/Betrag/Datum/Beschreibung ggf.
// unvollständig) und wird erst über kreditkarte.js' "Ergänzen"-Bearbeitung zu 'offen' -- die
// WHERE-Bedingung stellt sicher, dass wirklich alle Pflichtfelder gesetzt sind, bevor der Beleg
// wie ein regulär hochgeladener Beleg auf Karten-/Abgleichlisten erscheint.
export function aktiviereKkBelegEntwurf(db, id) {
  const result = db
    .prepare("UPDATE kk_belege SET status = 'offen' WHERE id = ? AND status = 'entwurf' AND kreditkarte_id IS NOT NULL AND betrag IS NOT NULL AND kaufdatum IS NOT NULL AND beschreibung IS NOT NULL")
    .run(id);
  return result.changes > 0;
}

export function ersetzeKkBelegDatei(db, id, { pdfPfad, thumbnailPfad }) {
  const result = db.prepare(`UPDATE kk_belege SET pdf_pfad = ?, thumbnail_pfad = ? WHERE id = ? AND ${BEARBEITBAR}`).run(pdfPfad, thumbnailPfad ?? null, id);
  return result.changes > 0;
}

export function verwerfeKkBeleg(db, id, { personId, grund }) {
  const result = db
    .prepare(`UPDATE kk_belege SET status = 'verworfen', verworfen_grund = ?, verworfen_von = ?, verworfen_am = ? WHERE id = ? AND ${BEARBEITBAR}`)
    .run(grund, personId, new Date().toISOString(), id);
  return result.changes > 0;
}

// Die WHERE-Bedingung ist der Schutz gegen parallele Abgleiche: nur ein offener Beleg genau dieser
// Karte lässt sich zuordnen, ein zweiter Versuch (anderer Tab, inzwischen verworfen) trifft 0 Zeilen.
export function ordneKkBelegZu(db, id, { kreditkarteId, jobId }) {
  const result = db
    .prepare("UPDATE kk_belege SET status = 'zugeordnet', zugeordnet_job_id = ?, zugeordnet_am = ? WHERE id = ? AND status = 'offen' AND kreditkarte_id = ?")
    .run(jobId, new Date().toISOString(), id, kreditkarteId);
  return result.changes > 0;
}

export function listOffeneKkBelegeFuerKarte(db, kreditkarteId) {
  return db.prepare("SELECT * FROM kk_belege WHERE kreditkarte_id = ? AND status = 'offen' ORDER BY kaufdatum, id").all(kreditkarteId);
}

export function listKkBelegeFuerPerson(db, personId) {
  return db
    .prepare(
      `SELECT b.*, k.bezeichnung AS karte_bezeichnung FROM kk_belege b LEFT JOIN kreditkarten k ON k.id = b.kreditkarte_id
       WHERE b.hochgeladen_von = ? OR b.gekauft_von = ? ORDER BY b.hochgeladen_am DESC, b.id DESC`
    )
    .all(personId, personId);
}

export function listOffeneKkBelegeFuerVerantwortlich(db, personId) {
  return db
    .prepare(
      `SELECT b.*, k.bezeichnung AS karte_bezeichnung FROM kk_belege b JOIN kreditkarten k ON k.id = b.kreditkarte_id
       WHERE k.verantwortlich_id = ? AND b.status = 'offen' ORDER BY k.bezeichnung, b.kaufdatum, b.id`
    )
    .all(personId);
}

export function getKkBelegByJobId(db, jobId) {
  return db.prepare('SELECT * FROM kk_belege WHERE zugeordnet_job_id = ?').get(jobId) ?? null;
}

export function logKkBelegEreignis(db, { belegId, personId, aktion, kommentar }) {
  db.prepare('INSERT INTO kk_beleg_ereignisse (beleg_id, person_id, aktion, zeitpunkt, kommentar) VALUES (?, ?, ?, ?, ?)').run(
    belegId, personId ?? null, aktion, new Date().toISOString(), kommentar ?? null
  );
}

// Arbeitsliste für den kk-beleg-erinnerungen Cron-Job (cronJobs.js): ein Beleg gilt als "seit
// langem offen", wenn sein Kaufdatum (status 'offen') bzw. sein Hochladezeitpunkt (status
// 'entwurf', noch kein Kaufdatum bekannt -- Mail-Eingang) die Schwelle unterschreitet, UND seit
// der letzten Erinnerung (falls je eine verschickt wurde) mindestens ein weiteres Intervall
// vergangen ist -- sonst würde jeder tägliche Lauf denselben Beleg erneut anmahnen.
export function listKkBelegeFuerErinnerung(db, schwelleIso) {
  return db
    .prepare(
      `SELECT b.*, k.bezeichnung AS karte_bezeichnung, k.verantwortlich_id AS verantwortlich_id
       FROM kk_belege b LEFT JOIN kreditkarten k ON k.id = b.kreditkarte_id
       WHERE ((b.status = 'offen' AND b.kaufdatum <= ?) OR (b.status = 'entwurf' AND b.hochgeladen_am <= ?))
         AND (b.letzte_erinnerung_am IS NULL OR b.letzte_erinnerung_am <= ?)
       ORDER BY b.kaufdatum, b.id`
    )
    .all(schwelleIso.slice(0, 10), schwelleIso, schwelleIso);
}

export function markKkBelegErinnert(db, id) {
  db.prepare('UPDATE kk_belege SET letzte_erinnerung_am = ? WHERE id = ?').run(new Date().toISOString(), id);
}
