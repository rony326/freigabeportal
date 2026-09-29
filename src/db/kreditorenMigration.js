import { createHash } from 'node:crypto';
import { currentAuditActor } from '../services/auditContext.js';

// Fachliche Korrektur: Rechnungssteller eingehender Rechnungen sind Kreditoren, nicht Debitoren.
// Benennt die bestehenden Tabellen/Spalten um, ohne Zeilen zu kopieren oder IDs zu aendern:
//   debitoren -> kreditoren, debitor_ibans -> kreditor_ibans,
//   kreditor_ibans.debitor_id, zuweisungsregeln.debitor_id, jobs.debitor_id -> kreditor_id.
// Muss VOR schema.sql laufen, sonst legt CREATE TABLE IF NOT EXISTS leere neue Tabellen an.
//
// Wiederholbar: bereits umbenannte Objekte werden uebersprungen. Existieren alter und neuer Name
// gleichzeitig (z.B. nach einem Downgrade mit altem Code), bricht der Start ab, statt Daten zu
// raten. Die Zuordnungen (Job->Kreditor, IBAN->Kreditor, Regel->Kreditor) werden vor und nach der
// Umbenennung als Fingerprint verglichen; bei Abweichung wird zurueckgerollt.
// Historische JSON-Inhalte (Audit vorher/nachher, Freigabe-Snapshots, Exportmanifeste) behalten
// ihre alten Schluessel und Hashes; gelesen werden sie ueber services/kreditorFelder.js.

const TABELLEN = [['debitoren', 'kreditoren'], ['debitor_ibans', 'kreditor_ibans']];
const SPALTEN = [['kreditor_ibans', 'debitor_id', 'kreditor_id'], ['zuweisungsregeln', 'debitor_id', 'kreditor_id'], ['jobs', 'debitor_id', 'kreditor_id']];
const ALTE_AUDIT_TRIGGER = ['debitoren', 'debitor_ibans'].flatMap((t) => ['INSERT', 'UPDATE', 'DELETE'].map((a) => `audit_${t}_${a}`));

function tabelleExistiert(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function spalten(db, tabelle) {
  return tabelleExistiert(db, tabelle) ? new Set(db.prepare(`PRAGMA table_info(${tabelle})`).all().map((c) => c.name)) : new Set();
}

function zuordnungen(db, namen) {
  const teile = [];
  // Stabile Rollennamen statt Tabellennamen, damit vorher/nachher vergleichbar sind.
  for (const [rolle, tabelle, spalte] of [['ibans', namen.ibans, namen.spalteIbans], ['regeln', 'zuweisungsregeln', namen.spalteRegeln], ['jobs', 'jobs', namen.spalteJobs]]) {
    if (!tabelle || !spalte || !spalten(db, tabelle).has(spalte)) continue;
    const rows = db.prepare(`SELECT id, "${spalte}" AS k FROM ${tabelle} WHERE "${spalte}" IS NOT NULL ORDER BY id`).all();
    teile.push(`${rolle}:${rows.map((r) => `${r.id}=${r.k}`).join(',')}`);
  }
  const stammdaten = namen.stamm && tabelleExistiert(db, namen.stamm)
    ? db.prepare(`SELECT id, name, konto_id, aktiv FROM ${namen.stamm} ORDER BY id`).all().map((r) => `${r.id}|${r.name}|${r.konto_id}|${r.aktiv}`).join(';')
    : '';
  return { sha256: createHash('sha256').update(`${stammdaten}\n${teile.join('\n')}`).digest('hex'), anzahlStammdaten: stammdaten ? stammdaten.split(';').length : 0 };
}

export function migrateKreditorenBezeichnung(db) {
  for (const [alt, neu] of TABELLEN) {
    if (tabelleExistiert(db, alt) && tabelleExistiert(db, neu)) {
      throw new Error(`Kreditoren-Migration: Tabellen ${alt} und ${neu} existieren beide. Start abgebrochen; Datenstand manuell pruefen (siehe docs/kreditoren-statt-debitoren.md).`);
    }
  }
  const offeneTabellen = TABELLEN.filter(([alt]) => tabelleExistiert(db, alt));
  const offeneSpalten = SPALTEN.filter(([tabelle, alt, neu]) => {
    const vorhanden = spalten(db, tabelle === 'kreditor_ibans' && tabelleExistiert(db, 'debitor_ibans') ? 'debitor_ibans' : tabelle);
    if (vorhanden.has(alt) && vorhanden.has(neu)) throw new Error(`Kreditoren-Migration: ${tabelle} hat ${alt} und ${neu}. Start abgebrochen.`);
    return vorhanden.has(alt);
  });
  if (!offeneTabellen.length && !offeneSpalten.length) return null;

  const vorher = zuordnungen(db, {
    stamm: tabelleExistiert(db, 'debitoren') ? 'debitoren' : 'kreditoren',
    ibans: tabelleExistiert(db, 'debitor_ibans') ? 'debitor_ibans' : 'kreditor_ibans',
    spalteIbans: spalten(db, tabelleExistiert(db, 'debitor_ibans') ? 'debitor_ibans' : 'kreditor_ibans').has('debitor_id') ? 'debitor_id' : 'kreditor_id',
    spalteRegeln: spalten(db, 'zuweisungsregeln').has('debitor_id') ? 'debitor_id' : 'kreditor_id',
    spalteJobs: spalten(db, 'jobs').has('debitor_id') ? 'debitor_id' : 'kreditor_id',
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    // Alte Audit-Trigger haengen nach dem Umbenennen an der neuen Tabelle und schrieben dann den
    // alten Objektnamen; migrateSecuritySchema legt die Trigger unter dem neuen Namen neu an.
    for (const trigger of ALTE_AUDIT_TRIGGER) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    for (const [alt, neu] of offeneTabellen) db.exec(`ALTER TABLE ${alt} RENAME TO ${neu}`);
    for (const [tabelle, alt, neu] of offeneSpalten) db.exec(`ALTER TABLE ${tabelle} RENAME COLUMN ${alt} TO ${neu}`);
    const nachher = zuordnungen(db, { stamm: 'kreditoren', ibans: 'kreditor_ibans', spalteIbans: 'kreditor_id', spalteRegeln: 'kreditor_id', spalteJobs: 'kreditor_id' });
    if (nachher.sha256 !== vorher.sha256) throw new Error('Kreditoren-Migration: Zuordnungen weichen nach der Umbenennung ab.');
    if (tabelleExistiert(db, 'audit_ereignisse')) {
      const actor = currentAuditActor();
      db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher, begruendung)
        VALUES (?, ?, ?, 'schema_migration', 'kreditoren_statt_debitoren', 'umbenannt', ?, ?)`).run(
        new Date().toISOString(), actor.id, actor.name,
        JSON.stringify({ tabellen: offeneTabellen, spalten: offeneSpalten, zuordnungenSha256: nachher.sha256, anzahlKreditoren: nachher.anzahlStammdaten }),
        'Fachliche Korrektur: Rechnungssteller eingehender Rechnungen sind Kreditoren.');
    }
    db.exec('COMMIT');
    return { tabellen: offeneTabellen.length, spalten: offeneSpalten.length, zuordnungenSha256: nachher.sha256 };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
