// Datenbank-Einstieg: öffnet die SQLite-Datei (`node:sqlite`) und bringt sie auf den aktuellen Stand.
//
// Schema-Strategie (wichtig für jede Änderung am Datenmodell, Übersicht: docs/datenmodell.md):
//   1. `schema.sql` legt auf einer FRISCHEN Datenbank alle Tabellen an (`CREATE TABLE IF NOT EXISTS`).
//   2. Bestehende Datenbanken (Live, Backups, Tests) erreichen neue Spalten/Tabellen NUR über die
//      idempotenten `migrate*`-Funktionen in diesem Verzeichnis, die bei jedem Start laufen.
//      Neue Spalte → Eintrag in der passenden `*_TABLE_MIGRATIONS`-Liste (UND in schema.sql).
//   3. SQLite kann CHECK-Bedingungen nicht per ALTER erweitern. Neue erlaubte Werte (Status, Rollen, Mailtypen,
//      Cron-Jobnamen) brauchen deshalb einen Tabellen-Neuaufbau (`erweitereCheckPerRebuild`); der erkennt am
//      "Marker" (dem neuesten Wert), ob er schon gelaufen ist.
//   4. Die Reihenfolge in `openDatabase()` ist bindend: CHECK-Rebuilds löschen die Trigger der alten Tabelle,
//      deshalb läuft `migrateSecuritySchema` (legt die Audit-Trigger neu an) NACH allen Rebuilds.
// Migrationen laufen bei jedem Start und müssen darum immer wiederholbar sein, ohne Daten zu verändern.

import { DatabaseSync } from 'node:sqlite';
import { seedGruppenBerechtigungen } from './gruppenBerechtigungenRepo.js';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { currentAuditActor, currentAuditRequestId, currentAuditOperation } from '../services/auditContext.js';
import { migrateAuditRequestSchema } from './auditRequestSchema.js';
import { migrateSecuritySchema } from './securitySchema.js';
import { migrateBetriebSchema } from './betriebSchema.js';
import { migrateExportIntegritaetSchema } from './exportIntegritaetSchema.js';
import { migrateZugriffsAuditSchema } from './zugriffsAuditSchema.js';
import { migrateKreditorenBezeichnung } from './kreditorenMigration.js';
import { migrateDateiQuarantaeneSchema } from './dateiQuarantaeneSchema.js';
import { migrateSicherheitsalarmSchema } from './sicherheitsalarmSchema.js';
import { migrateTsaNachweisSchema } from './tsaNachweisSchema.js';
import { migrateAuditExportSchema } from './auditExportSchema.js';
import { getDefaultConfigValue } from './adminConfigRepo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `CREATE TABLE IF NOT EXISTS` in schema.sql erreicht nur eine frische bzw. In-Memory-Datenbank — sobald eine
// Datenbankdatei einmal angelegt wurde (Testdaten, ein früher Betrieb, egal was), läuft diese Anweisung dort ins Leere,
// und neue jobs-Spalten kommen nie an. Neue Spalten gehören deshalb auch hierher, damit eine bestehende Datenbank sie
// beim nächsten Start bekommt. Jeder Eintrag ist idempotent: er wird übersprungen, wenn die Spalte schon existiert
// (entweder durch einen früheren Lauf dieser Migration oder von Anfang an über schema.sql in einer neuen Datenbank).
const JOBS_TABLE_MIGRATIONS = [
  { column: 'betrag', ddl: 'ALTER TABLE jobs ADD COLUMN betrag TEXT' },
  { column: 'zahlungsziel', ddl: 'ALTER TABLE jobs ADD COLUMN zahlungsziel TEXT' },
  { column: 'rechnungsnummer', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsnummer TEXT' },
  { column: 'lieferant', ddl: 'ALTER TABLE jobs ADD COLUMN lieferant TEXT' },
  { column: 'kreditor_id', ddl: 'ALTER TABLE jobs ADD COLUMN kreditor_id INTEGER REFERENCES kreditoren(id)' },
  { column: 'aufgesplittet_von', ddl: 'ALTER TABLE jobs ADD COLUMN aufgesplittet_von INTEGER REFERENCES jobs(id)' },
  { column: 'datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN datei_hash TEXT' },
  { column: 'hinweis_konto_id', ddl: 'ALTER TABLE jobs ADD COLUMN hinweis_konto_id INTEGER REFERENCES konten(id)' },
  { column: 'zeitstempel_gesetzt_am', ddl: 'ALTER TABLE jobs ADD COLUMN zeitstempel_gesetzt_am TEXT' },
  { column: 'zeitstempel_datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN zeitstempel_datei_hash TEXT' },
  { column: 'abgeschlossen_am', ddl: 'ALTER TABLE jobs ADD COLUMN abgeschlossen_am TEXT' },
  { column: 'qr_iban', ddl: 'ALTER TABLE jobs ADD COLUMN qr_iban TEXT' },
  { column: 'qr_referenz', ddl: 'ALTER TABLE jobs ADD COLUMN qr_referenz TEXT' },
  { column: 'qr_betrag', ddl: 'ALTER TABLE jobs ADD COLUMN qr_betrag TEXT' },
  { column: 'qr_waehrung', ddl: 'ALTER TABLE jobs ADD COLUMN qr_waehrung TEXT' },
  { column: 'qr_creditor_name', ddl: 'ALTER TABLE jobs ADD COLUMN qr_creditor_name TEXT' },
  { column: 'qr_erkannt_am', ddl: 'ALTER TABLE jobs ADD COLUMN qr_erkannt_am TEXT' },
  { column: 'typ', ddl: 'ALTER TABLE jobs ADD COLUMN typ TEXT' },
  { column: 'rechnungsposition', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsposition TEXT' },
  { column: 'gruppe_pdf_pfad', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_pdf_pfad TEXT' },
  { column: 'gruppe_zeitstempel_gesetzt_am', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_gesetzt_am TEXT' },
  { column: 'gruppe_zeitstempel_datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_datei_hash TEXT' },
  { column: 'beleg_seitenzahl', ddl: 'ALTER TABLE jobs ADD COLUMN beleg_seitenzahl INTEGER' },
  { column: 'gruppe_abgeholt_am', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_abgeholt_am TEXT' },
  { column: 'eingereicht_von', ddl: 'ALTER TABLE jobs ADD COLUMN eingereicht_von TEXT REFERENCES personen(churchtools_person_id)' },
  { column: 'auslage_datum', ddl: 'ALTER TABLE jobs ADD COLUMN auslage_datum TEXT' },
  { column: 'beschreibung', ddl: 'ALTER TABLE jobs ADD COLUMN beschreibung TEXT' },
  { column: 'spesenabrechnung_id', ddl: 'ALTER TABLE jobs ADD COLUMN spesenabrechnung_id INTEGER REFERENCES spesenabrechnungen(id)' },
  { column: 'rechnungsdatum', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsdatum TEXT' },
  { column: 'pool_rueckgesendet_bemerkung', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_bemerkung TEXT' },
  { column: 'pool_rueckgesendet_von', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_von TEXT REFERENCES personen(churchtools_person_id)' },
  { column: 'pool_rueckgesendet_am', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_am TEXT' },
  { column: 'freigabe2_seit', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_seit TEXT' },
  { column: 'freigabe2_reminder_gesendet_at', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_reminder_gesendet_at TEXT' },
  { column: 'freigabe2_eskalation_gesendet_at', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_eskalation_gesendet_at TEXT' },
  { column: 'kreditkarte_id', ddl: 'ALTER TABLE jobs ADD COLUMN kreditkarte_id INTEGER REFERENCES kreditkarten(id)' },
  { column: 'kk_eigenbeleg_grund', ddl: 'ALTER TABLE jobs ADD COLUMN kk_eigenbeleg_grund TEXT' },
  { column: 'kk_markiert_am', ddl: 'ALTER TABLE jobs ADD COLUMN kk_markiert_am TEXT' },
  { column: 'kk_erinnert_am', ddl: 'ALTER TABLE jobs ADD COLUMN kk_erinnert_am TEXT' },
  { column: 'kk_text_betraege', ddl: 'ALTER TABLE jobs ADD COLUMN kk_text_betraege TEXT' },
  // Admin-Umhängen bei Freigabe 2 (/admin/vorgaenge): hat Vorrang vor Stellvertreter2/Freigeber2.
  { column: 'freigabe2_umgeleitet_an', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_umgeleitet_an TEXT REFERENCES personen(churchtools_person_id)' },
  // Dateiname des PDF-Teils beim n8n-Eingang (services/belegName.js: Anzeige statt Bild-Anhangname).
  { column: 'pdf_dateiname', ddl: 'ALTER TABLE jobs ADD COLUMN pdf_dateiname TEXT' },
  // Rapporte (nur zur Kenntnis): Markierung, Bemerkung und Eskalationszeitpunkt.
  { column: 'rapport_markiert_von', ddl: 'ALTER TABLE jobs ADD COLUMN rapport_markiert_von TEXT' },
  { column: 'rapport_markiert_am', ddl: 'ALTER TABLE jobs ADD COLUMN rapport_markiert_am TEXT' },
  { column: 'rapport_bemerkung', ddl: 'ALTER TABLE jobs ADD COLUMN rapport_bemerkung TEXT' },
  { column: 'rapport_eskaliert_am', ddl: 'ALTER TABLE jobs ADD COLUMN rapport_eskaliert_am TEXT' },
];

// Nachträgliche Spalten der Tabelle `personen`.
const PERSONEN_TABLE_MIGRATIONS = [
  { column: 'ferienmodus_von', ddl: 'ALTER TABLE personen ADD COLUMN ferienmodus_von TEXT' },
  { column: 'ferienmodus_bis', ddl: 'ALTER TABLE personen ADD COLUMN ferienmodus_bis TEXT' },
  { column: 'ferienmodus_stellvertreter_id', ddl: 'ALTER TABLE personen ADD COLUMN ferienmodus_stellvertreter_id TEXT REFERENCES personen(churchtools_person_id)' },
  // Personen-Sync (services/sync.js): wann und warum der Portalzugang entzogen wurde.
  { column: 'deaktiviert_am', ddl: 'ALTER TABLE personen ADD COLUMN deaktiviert_am TEXT' },
  { column: 'deaktivierungsgrund', ddl: 'ALTER TABLE personen ADD COLUMN deaktivierungsgrund TEXT' },
  // Persönliche Bündelung (services/benachrichtigung.js): 'sofort'|'taeglich'|'woechentlich', NULL = Standard.
  { column: 'benachrichtigung', ddl: 'ALTER TABLE personen ADD COLUMN benachrichtigung TEXT' },
];

// Ergänzt fehlende `personen`-Spalten (idempotent; gleiches Muster bei den Funktionen darunter).
function migratePersonenTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(personen)').all().map((col) => col.name));
  for (const { column, ddl } of PERSONEN_TABLE_MIGRATIONS) {
    if (!existing.has(column)) db.exec(ddl);
  }
}

// Zahlungsart und "Beträge schwanken" am Lieferanten. ADD COLUMN erlaubt NOT NULL mit Default und CHECK.
const KREDITOREN_TABLE_MIGRATIONS = [
  { column: 'zahlungsart', ddl: "ALTER TABLE kreditoren ADD COLUMN zahlungsart TEXT NOT NULL DEFAULT 'ueberweisung' CHECK (zahlungsart IN ('ueberweisung', 'dauerauftrag', 'lastschrift', 'kreditkarte'))" },
  { column: 'betrag_schwankt', ddl: 'ALTER TABLE kreditoren ADD COLUMN betrag_schwankt INTEGER NOT NULL DEFAULT 0' },
];

function migrateKreditorenTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(kreditoren)').all().map((col) => col.name));
  for (const { column, ddl } of KREDITOREN_TABLE_MIGRATIONS) {
    if (!existing.has(column)) db.exec(ddl);
  }
}

// Buchungsart pro Konto (Rechnung/Gutschrift/beides); bestehende Konten bleiben 'beides'.
const KONTEN_TABLE_MIGRATIONS = [
  { column: 'buchungsart', ddl: "ALTER TABLE konten ADD COLUMN buchungsart TEXT NOT NULL DEFAULT 'beides' CHECK (buchungsart IN ('rechnung', 'gutschrift', 'beides'))" },
];

function migrateKontenTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(konten)').all().map((col) => col.name));
  for (const { column, ddl } of KONTEN_TABLE_MIGRATIONS) {
    if (!existing.has(column)) db.exec(ddl);
  }
}

const FREIGABEN_TABLE_VERTRETUNG_MIGRATIONS = [
  { column: 'vertretung_fuer', ddl: 'ALTER TABLE freigaben ADD COLUMN vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)' },
];

function migrateFreigabenTableVertretung(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(freigaben)').all().map((col) => col.name));
  for (const { column, ddl } of FREIGABEN_TABLE_VERTRETUNG_MIGRATIONS) {
    if (!existing.has(column)) db.exec(ddl);
  }
}

// SQLite-CHECK-Bedingungen lassen sich nicht per ALTER TABLE erweitern — gleicher Neuaufbau in einer Transaktion
// wie bei migrateFreigabenTable weiter unten. Der Marker, auf den diese Funktion prüft, ist `'spesen'` (der neueste
// quelle-Wert); was der CHECK aktuell erlaubt, steht im CREATE TABLE der Tabelle jobs in schema.sql, nicht in diesem Kommentar.
//
// Muss in openDatabase() VOR migrateJobsTable(db) laufen: Beim Beiseiteschieben von jobs (und dem späteren Löschen der
// umbenannten Kopie) gehen auch alle Trigger und Indizes der Tabelle mit, denn SQLites ALTER TABLE RENAME schreibt deren
// ON-Klausel auf die umbenannte Tabelle um und DROP TABLE nimmt abhängige Trigger mit. migrateJobsTable(db) legt direkt
// danach idx_jobs_datei_hash und alle vier Zeitstempel-Schutz-Trigger bedingungslos neu an (eigene CREATE INDEX/TRIGGER
// IF NOT EXISTS), was hier verloren ging, heilt also wieder. Diese Funktion ergänzt bewusst NICHT auch die vier neuen
// Spesen-Spalten — die einfachen ADD-COLUMN-Einträge in JOBS_TABLE_MIGRATIONS (die ein fremder CHECK nicht stört)
// decken das schon ab, genau wie jede andere jobs-Spalte seit dem ursprünglichen schema.sql.
function migrateJobsTableQuelleCheck(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
  if (!tableSql || tableSql.sql.includes("'spesen'")) return;

  // Die Migration nur ausführen, wenn die alte jobs-Tabelle die Spalten hat, die sie aus dem ursprünglichen schema.sql
  // und JOBS_TABLE_MIGRATIONS haben muss. Fehlen sie, ergänzt migrateJobsTable sie zuerst per ALTER TABLE; ein späterer
  // Neustart führt diese Migration dann auf der vollständigen Tabelle aus. Geprüft werden konto_id (ursprüngliches
  // Schema) und beleg_seitenzahl (jüngste Migration), das deckt den ganzen Bereich ab.
  const cols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  if (!cols.has('konto_id') || !cols.has('beleg_seitenzahl') || !cols.has('gruppe_abgeholt_am')) {
    console.warn(
      "migrateJobsTableQuelleCheck: jobs table is missing one or more expected columns (konto_id/beleg_seitenzahl/gruppe_abgeholt_am) — skipping the 'spesen' CHECK-widening migration for now. This self-heals on the next restart, once migrateJobsTable(db) has added the missing columns via ALTER TABLE."
    );
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE jobs RENAME TO jobs_pre_spesen_quelle');
    db.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eingang_am TEXT NOT NULL,
        quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant', 'spesen')),
        absender TEXT,
        dateiname TEXT NOT NULL,
        pdf_pfad TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'unzugewiesen','zugewiesen','kontiert','freigabe1','freigabe2',
          'abgeschlossen','abgeholt','archiviert','abgelehnt','aufgesplittet','geloescht'
        )) DEFAULT 'unzugewiesen',
        konto_id INTEGER REFERENCES konten(id),
        zugewiesen_an TEXT REFERENCES personen(churchtools_person_id),
        abgelehnt_von TEXT REFERENCES personen(churchtools_person_id),
        ablehnungsgrund TEXT,
        fetched_by_n8n_at TEXT,
        thumbnail_pfad TEXT,
        freigabe1_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
        freigabe1_eskalationsgrund TEXT,
        freigabe2_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
        freigabe2_eskalationsgrund TEXT,
        reminder_gesendet_at TEXT,
        eskalation_gesendet_at TEXT,
        archiviert_am TEXT,
        freigabe1_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
        freigabe2_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
        betrag TEXT,
        zahlungsziel TEXT,
        rechnungsnummer TEXT,
        lieferant TEXT,
        kreditor_id INTEGER REFERENCES kreditoren(id),
        aufgesplittet_von INTEGER REFERENCES jobs(id),
        datei_hash TEXT,
        hinweis_konto_id INTEGER REFERENCES konten(id),
        zeitstempel_gesetzt_am TEXT,
        zeitstempel_datei_hash TEXT,
        abgeschlossen_am TEXT,
        qr_iban TEXT,
        qr_referenz TEXT,
        qr_betrag TEXT,
        qr_waehrung TEXT,
        qr_creditor_name TEXT,
        qr_erkannt_am TEXT,
        typ TEXT,
        rechnungsposition TEXT,
        gruppe_pdf_pfad TEXT,
        gruppe_zeitstempel_gesetzt_am TEXT,
        gruppe_zeitstempel_datei_hash TEXT,
        beleg_seitenzahl INTEGER,
        gruppe_abgeholt_am TEXT
      )
    `);
    db.exec(`
      INSERT INTO jobs (
        id, eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an,
        abgelehnt_von, ablehnungsgrund, fetched_by_n8n_at, thumbnail_pfad, freigabe1_eskaliert_von,
        freigabe1_eskalationsgrund, freigabe2_eskaliert_von, freigabe2_eskalationsgrund,
        reminder_gesendet_at, eskalation_gesendet_at, archiviert_am, freigabe1_eskaliert_an_admin,
        freigabe2_eskaliert_an_admin, betrag, zahlungsziel, rechnungsnummer, lieferant, kreditor_id,
        aufgesplittet_von, datei_hash, hinweis_konto_id, zeitstempel_gesetzt_am,
        zeitstempel_datei_hash, abgeschlossen_am, qr_iban, qr_referenz, qr_betrag, qr_waehrung,
        qr_creditor_name, qr_erkannt_am, typ, rechnungsposition, gruppe_pdf_pfad,
        gruppe_zeitstempel_gesetzt_am, gruppe_zeitstempel_datei_hash, beleg_seitenzahl, gruppe_abgeholt_am
      )
      SELECT
        id, eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an,
        abgelehnt_von, ablehnungsgrund, fetched_by_n8n_at, thumbnail_pfad, freigabe1_eskaliert_von,
        freigabe1_eskalationsgrund, freigabe2_eskaliert_von, freigabe2_eskalationsgrund,
        reminder_gesendet_at, eskalation_gesendet_at, archiviert_am, freigabe1_eskaliert_an_admin,
        freigabe2_eskaliert_an_admin, betrag, zahlungsziel, rechnungsnummer, lieferant, kreditor_id,
        aufgesplittet_von, datei_hash, hinweis_konto_id, zeitstempel_gesetzt_am,
        zeitstempel_datei_hash, abgeschlossen_am, qr_iban, qr_referenz, qr_betrag, qr_waehrung,
        qr_creditor_name, qr_erkannt_am, typ, rechnungsposition, gruppe_pdf_pfad,
        gruppe_zeitstempel_gesetzt_am, gruppe_zeitstempel_datei_hash, beleg_seitenzahl, gruppe_abgeholt_am
      FROM jobs_pre_spesen_quelle
    `);
    db.exec('DROP TABLE jobs_pre_spesen_quelle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Rapporte: neuer jobs-Status 'kenntnisnahme'. Bewusst NICHT das Rename-alt-Muster von
// migrateJobsTableQuelleCheck: modernes SQLite (legacy_alter_table=OFF) schreibt beim Umbenennen
// von jobs die FK-Verweise aller anderen Tabellen (freigaben, mail_log, kommentare, …) auf den
// alten Namen um, und nach dem DROP zeigten sie ins Leere. Stattdessen das «12-Schritte»-Verfahren
// aus der SQLite-Doku: neue Tabelle anlegen, kopieren, alte löschen, neue umbenennen. Die Kopie
// übernimmt alle Spalten generisch (PRAGMA table_info), also auch solche, die erst später per
// ALTER TABLE hinzukamen. Indizes und Trigger von jobs verschwinden mit DROP TABLE und werden aus
// dem vorher gemerkten SQL neu angelegt. Der AUTOINCREMENT-Zähler wird übernommen, damit einmal
// vergebene ids (auch endgültig gelöschter Jobs, siehe job_loeschungen) nie wieder vergeben werden.
function migrateJobsStatusKenntnisnahme(db) {
  const tabelle = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
  if (!tabelle || tabelle.sql.includes("'kenntnisnahme'")) return;
  // Sehr alte Tabellen ohne status-CHECK erlauben 'kenntnisnahme' bereits: nichts zu erweitern.
  if (!/\bstatus\s+IN\s*\(/i.test(tabelle.sql)) return;

  const neuSql = ersetzeGenauEinmal(
    ersetzeGenauEinmal(tabelle.sql, /^CREATE TABLE\s+("?)jobs\1\s*\(/, 'CREATE TABLE jobs_neu ('),
    /'geloescht'/,
    "'geloescht','kenntnisnahme'"
  );
  const abhaengige = db
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'jobs' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all()
    .map((r) => r.sql);
  const spalten = db.prepare('PRAGMA table_info(jobs)').all().map((c) => `"${c.name}"`).join(', ');
  const sequenz = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get();
  // Bereits vorhandene Verwaiste (z. B. mail_log-Zeilen endgültig gelöschter Jobs) dürfen den Start
  // nicht verhindern; abgebrochen wird nur, wenn der Neuaufbau selbst neue Verletzungen erzeugt.
  const fkSchluessel = () => new Set(db.prepare('PRAGMA foreign_key_check').all().map((v) => `${v.table}|${v.rowid}|${v.parent}|${v.fkid}`));
  const fkVorher = fkSchluessel();

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(neuSql);
    db.exec(`INSERT INTO jobs_neu (${spalten}) SELECT ${spalten} FROM jobs`);
    db.exec('DROP TABLE jobs');
    db.exec('ALTER TABLE jobs_neu RENAME TO jobs');
    if (sequenz) {
      // Bei leerer jobs-Tabelle legt der INSERT ... SELECT keine sqlite_sequence-Zeile an: dann neu eintragen.
      const geaendert = db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'jobs'").run(sequenz.seq).changes;
      if (geaendert === 0 && sequenz.seq > 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', ?)").run(sequenz.seq);
    }
    for (const sql of abhaengige) db.exec(sql);
    const verletzungen = [...fkSchluessel()].filter((v) => !fkVorher.has(v));
    if (verletzungen.length > 0) {
      throw new Error(`migrateJobsStatusKenntnisnahme: foreign_key_check meldet ${verletzungen.length} Verletzung(en)`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Ersetzt ein Muster im SQL-Text und bricht ab, wenn es nicht GENAU einmal vorkommt – verhindert, dass ein
// Neuaufbau der Tabelle `jobs` stillschweigend ein verändertes CREATE-Statement erzeugt.
function ersetzeGenauEinmal(text, muster, ersatz) {
  const treffer = text.match(new RegExp(muster.source, 'g')) || [];
  if (treffer.length !== 1) {
    throw new Error(`migrateJobsStatusKenntnisnahme: ${muster} kommt ${treffer.length}-mal statt genau einmal im jobs-SQL vor`);
  }
  return text.replace(muster, ersatz);
}

// Ergänzt fehlende `jobs`-Spalten, den Hash-Index und die Manipulationsschutz-Trigger für Zeitstempel.
function migrateJobsTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((col) => col.name));
  for (const { column, ddl } of JOBS_TABLE_MIGRATIONS) {
    if (!existing.has(column)) {
      db.exec(ddl);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_datei_hash ON jobs(datei_hash)');

  // Manipulationsschutz für bereits bestehende Datenbanken — siehe schema.sql für die
  // ausführliche Begründung. Beide Trigger sind CREATE TRIGGER IF NOT EXISTS, also idempotent wie
  // der Rest dieser Funktion.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_zeitstempel_hash_unveraenderlich
    BEFORE UPDATE OF zeitstempel_datei_hash ON jobs
    WHEN OLD.zeitstempel_datei_hash IS NOT NULL
      AND NEW.zeitstempel_datei_hash IS NOT NULL
      AND NEW.zeitstempel_datei_hash <> OLD.zeitstempel_datei_hash
    BEGIN
      SELECT RAISE(ABORT, 'zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_zeitstempel_gesetzt_am_unveraenderlich
    BEFORE UPDATE OF zeitstempel_gesetzt_am ON jobs
    WHEN OLD.zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.zeitstempel_gesetzt_am <> OLD.zeitstempel_gesetzt_am
    BEGIN
      SELECT RAISE(ABORT, 'zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_hash_unveraenderlich
    BEFORE UPDATE OF gruppe_zeitstempel_datei_hash ON jobs
    WHEN OLD.gruppe_zeitstempel_datei_hash IS NOT NULL
      AND NEW.gruppe_zeitstempel_datei_hash IS NOT NULL
      AND NEW.gruppe_zeitstempel_datei_hash <> OLD.gruppe_zeitstempel_datei_hash
    BEGIN
      SELECT RAISE(ABORT, 'gruppe_zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_gesetzt_am_unveraenderlich
    BEFORE UPDATE OF gruppe_zeitstempel_gesetzt_am ON jobs
    WHEN OLD.gruppe_zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.gruppe_zeitstempel_gesetzt_am IS NOT NULL
      AND NEW.gruppe_zeitstempel_gesetzt_am <> OLD.gruppe_zeitstempel_gesetzt_am
    BEGIN
      SELECT RAISE(ABORT, 'gruppe_zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
    END
  `);

  // Läuft strikt nach der Schleife oben, die Spalte abgeschlossen_am existiert hier also garantiert (entweder aus
  // schema.sql in einer frischen Datenbank oder aus dem ALTER-TABLE-Eintrag).
  //
  // Nachtrag (Backfill): Wird die RFC3161-Funktion auf einer Datenbank mit bereits 'abgeschlossenen' Jobs eingespielt,
  // haben diese Jobs kein abgeschlossen_am (die Spalte ist neu). Ohne diese Korrektur würden sie von der n8n-Abholsperre
  // erfasst (jobsRepo.listAbholbereitJobs/confirmAbholung blockieren jeden abgeschlossenen Job ohne Zeitstempel), wären
  // aber für den Admin-Warnbanner unsichtbar (countZeitstempelUeberfaellig überspringt abgeschlossen_am IS NULL) — nicht
  // abholbar, ohne dass das Dashboard den Grund nennt. Mit "jetzt" gestempelt laufen sie auf derselben Uhr wie frisch
  // abgeschlossene Jobs: der Nachhol-Job holt sie, und bleibt die TSA unerreichbar, warnt der Banner nach Ablauf der
  // Schwelle auch vor ihnen.
  //
  // Von Natur aus idempotent, ohne Schutz-Flag: Es betrifft nur Zeilen mit abgeschlossen_am IS NULL, und jede betroffene
  // Zeile bekommt einen Wert, ein zweiter Lauf findet also nichts mehr.
  db.prepare("UPDATE jobs SET abgeschlossen_am = ? WHERE status = 'abgeschlossen' AND abgeschlossen_am IS NULL").run(
    new Date().toISOString()
  );

  // Nachtrag (Backfill): Wird diese Funktion auf einer Datenbank mit Jobs im Status 'freigabe2' eingespielt, haben diese
  // Jobs kein freigabe2_seit (die Spalte ist neu) und sind für listFreigabe2JobsForReminder/listFreigabe2JobsForEskalation
  // dauerhaft unsichtbar (NULL < ? ist in SQLite NULL/falsch). Sie mit "jetzt" (Einspielzeitpunkt) statt mit eingang_am zu
  // stempeln, ist Absicht: eingang_am kann Monate alt sein, wodurch jeder bereits hängende Job beim allerersten Cron-Lauf
  // nach dem Einspielen gleichzeitig eskalierbar würde — ein Mailsturm und eine massenhafte, undifferenzierte Übergabe an
  // die Admin-Gruppe. Beginnt ihre Uhr zum Einspielzeitpunkt, folgen sie demselben Rhythmus aus Erinnerung und Eskalation
  // wie ein Job, der heute in freigabe2 eintritt.
  //
  // Von Natur aus idempotent, ohne Schutz-Flag: Es betrifft nur Zeilen mit freigabe2_seit IS NULL, und jede betroffene
  // Zeile bekommt einen Wert, ein zweiter Lauf findet also nichts mehr.
  db.prepare("UPDATE jobs SET freigabe2_seit = ? WHERE status = 'freigabe2' AND freigabe2_seit IS NULL").run(
    new Date().toISOString()
  );
}

// SQLite-CHECK-Bedingungen lassen sich nicht per ALTER TABLE erweitern — anders als die einfachen ADD-COLUMN-Einträge in
// JOBS_TABLE_MIGRATIONS behält eine bereits bestehende Tabelle freigaben (jede Datenbank, deren rolle-CHECK älter ist als
// der unten geprüfte Marker) ihren ursprünglichen, engeren CHECK für immer, weil `CREATE TABLE IF NOT EXISTS` in
// schema.sql dort nichts bewirkt. Ein CHECK lässt sich in SQLite nur durch einen Tabellen-Neuaufbau erweitern: beiseite
// umbenennen, frisch aus dem aktuellen Schema anlegen, alle Zeilen kopieren, die alte löschen — alles in einer Transaktion,
// damit ein Absturz mitten in der Migration die Datenbank nicht ganz ohne Tabelle freigaben zurücklässt. Der Marker,
// auf den diese Funktion prüft (derzeit 'freigabe1_weiterleitung'), rückt bei jeder weiteren Erweiterung vor — er ist
// einfach "der neueste rolle-Wert", nicht an ein einzelnes Feature gebunden; was der CHECK aktuell erlaubt, steht im
// CREATE TABLE weiter unten, nicht in diesem Kommentar.
function migrateFreigabenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'freigaben'").get();
  if (!tableSql || tableSql.sql.includes('freigabe1_weiterleitung')) return;

  // node:sqlite erzwingt `PRAGMA foreign_keys` standardmässig, und es muss ausserhalb jeder Transaktion abgeschaltet
  // werden (innerhalb ist das Pragma laut Dokumentation wirkungslos). Ohne das bräche eine einzige freigaben-Zeile, die
  // auf eine nicht mehr existierende jobs.id oder personen.churchtools_person_id verweist, das INSERT unten ab, das catch
  // rollt zurück, und der Fehler wandert aus openDatabase heraus — die ganze App startet nicht. Das Wiederherstellen im
  // `finally` (nicht nur nach COMMIT) ist wichtig: eine Migration, die wirft, darf die FK-Prüfung nicht dauerhaft abgeschaltet lassen.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE freigaben RENAME TO freigaben_pre_freigabe1_weiterleitung_rolle');
    db.exec(`
      CREATE TABLE freigaben (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung')),
        zeitpunkt TEXT NOT NULL,
        ip TEXT NOT NULL,
        interessenskonflikt INTEGER NOT NULL DEFAULT 0,
        kommentar TEXT,
        eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
      )
    `);
    db.exec(`
      INSERT INTO freigaben (id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von FROM freigaben_pre_freigabe1_weiterleitung_rolle
    `);
    db.exec('DROP TABLE freigaben_pre_freigabe1_weiterleitung_rolle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Gleiche Begründung wie bei migrateFreigabenTable oben: der CHECK von mail_log.typ lässt sich nicht per ALTER TABLE
// erweitern. Eine laufende Datenbank, die älter ist als 'rechnungsnummer-warnung', braucht deshalb einen Neuaufbau ihrer
// Tabelle mail_log an Ort und Stelle, um den neuen Wert zu akzeptieren.
function migrateMailLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('rechnungsnummer-warnung')) return;

  // Siehe den passenden Kommentar in migrateFreigabenTable oben: node:sqlite erzwingt `PRAGMA foreign_keys` standardmässig,
  // eine einzige mail_log-Zeile mit Verweis auf eine nicht mehr existierende jobs.id würde sonst dieses INSERT abbrechen
  // und den App-Start ganz verhindern.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_rechnungsnummer_warnung_typ');
    db.exec(`
      CREATE TABLE mail_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung')),
        job_id INTEGER REFERENCES jobs(id),
        empfaenger TEXT NOT NULL,
        betreff TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
        fehler_details TEXT,
        versucht_am TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_rechnungsnummer_warnung_typ
    `);
    db.exec('DROP TABLE mail_log_pre_rechnungsnummer_warnung_typ');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Gleiche Begründung wie bei migrateFreigabenTable oben: eine bereits bestehende Tabelle cron_log (jede Datenbank, die älter
// ist als der Jobname 'datenbank-sicherung') behielte sonst ihr ursprüngliches, engeres Schema für immer, und
// startCronLauf('datenbank-sicherung', ...) würde darauf fehlschlagen. Der Marker, auf den diese Funktion prüft, rückt bei
// jeder weiteren Erweiterung des CHECK vor — was er aktuell erlaubt, steht im CREATE TABLE unten, nicht in diesem Kommentar.
function migrateCronLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('datenbank-sicherung')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_datenbank_sicherung');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_datenbank_sicherung
    `);
    db.exec('DROP TABLE cron_log_pre_datenbank_sicherung');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Gleiche Begründung wie bei migrateFreigabenTable oben: eine bereits bestehende Tabelle person_berechtigungen (jede Datenbank,
// deren berechtigung-CHECK älter ist als 'pool_zuweisen') behielte sonst ihren ursprünglichen, engeren CHECK für immer, weil
// `CREATE TABLE IF NOT EXISTS` in schema.sql dort nichts bewirkt.
function migratePersonBerechtigungenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get();
  if (!tableSql || tableSql.sql.includes('pool_zuweisen')) return;

  // Siehe den passenden Kommentar in migrateFreigabenTable oben: node:sqlite erzwingt `PRAGMA foreign_keys` standardmässig,
  // eine einzige person_berechtigungen-Zeile mit Verweis auf eine nicht mehr existierende personen.churchtools_person_id
  // würde sonst dieses INSERT abbrechen.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE person_berechtigungen RENAME TO person_berechtigungen_pre_pool_zuweisen');
    db.exec(`
      CREATE TABLE person_berechtigungen (
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        -- Historischer Zwischenstand: 'debitoren_verwalten' wird erst in migrateSecuritySchema
        -- auf 'kreditoren_verwalten' abgebildet.
        berechtigung TEXT NOT NULL CHECK (berechtigung IN (
          'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
          'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen', 'pool_zuweisen'
        )),
        PRIMARY KEY (person_id, berechtigung)
      )
    `);
    db.exec(`
      INSERT INTO person_berechtigungen (person_id, berechtigung)
      SELECT person_id, berechtigung FROM person_berechtigungen_pre_pool_zuweisen
    `);
    db.exec('DROP TABLE person_berechtigungen_pre_pool_zuweisen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Gleiches Muster wie migrateCronLogTable oben, eine weitere CHECK-Erweiterung, hier für den neuen Cron-Job
// 'split-gruppen-nachholen'. Der Marker rückt beim nächsten Erweitern des CHECK wieder vor — was er aktuell erlaubt, steht
// im CREATE TABLE unten, nicht in diesem Kommentar.
function migrateCronLogTableSplitGruppen(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('split-gruppen-nachholen')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_split_gruppen_nachholen');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_split_gruppen_nachholen
    `);
    db.exec('DROP TABLE cron_log_pre_split_gruppen_nachholen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Gleiches Muster wie migrateMailLogTable oben: eine laufende Datenbank aus der Zeit vor der Bündelung hat mail_log.status
// nur auf 'versendet'/'fehlgeschlagen' eingeschränkt — sendNotification braucht jetzt einen dritten Wert, 'geplant', für
// Zeilen, die für die tägliche Zusammenfassung vorgemerkt statt sofort gesendet werden.
function migrateMailLogTableGeplantStatus(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('geplant')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_geplant_status');
    db.exec(`
      CREATE TABLE mail_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung')),
        job_id INTEGER REFERENCES jobs(id),
        empfaenger TEXT NOT NULL,
        betreff TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
        fehler_details TEXT,
        versucht_am TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_geplant_status
    `);
    db.exec('DROP TABLE mail_log_pre_geplant_status');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Gleiches Muster wie migrateCronLogTableSplitGruppen oben, eine weitere CHECK-Erweiterung, hier für den neuen Cron-Job
// 'mail-digest' (die tägliche Sammelmail je Empfänger:in).
function migrateCronLogTableMailDigest(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('mail-digest')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_mail_digest');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_mail_digest
    `);
    db.exec('DROP TABLE cron_log_pre_mail_digest');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Gleiches Muster wie migrateMailLogTableGeplantStatus oben, eine weitere CHECK-Erweiterung, hier für die zwei neuen
// Mailtypen 'freigabe2-reminder'/'freigabe2-eskalation' (Cron-Job freigabe2-erinnerungen).
function migrateMailLogTableFreigabe2(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('freigabe2-reminder')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_freigabe2');
    db.exec(`
      CREATE TABLE mail_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation')),
        job_id INTEGER REFERENCES jobs(id),
        empfaenger TEXT NOT NULL,
        betreff TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
        fehler_details TEXT,
        versucht_am TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_freigabe2
    `);
    db.exec('DROP TABLE mail_log_pre_freigabe2');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Gleiches Muster wie migrateCronLogTableMailDigest oben, eine weitere CHECK-Erweiterung, hier für den neuen Cron-Job
// 'freigabe2-erinnerungen' (Erinnerung + Eskalation bei hängenden freigabe2-Vorgängen).
function migrateCronLogTableFreigabe2Erinnerungen(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('freigabe2-erinnerungen')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_freigabe2_erinnerungen');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_freigabe2_erinnerungen
    `);
    db.exec('DROP TABLE cron_log_pre_freigabe2_erinnerungen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Gemeinsamer Helfer für die Kreditkarten-CHECK-Erweiterungen unten -- gleiches Rebuild-Muster wie
// migrateFreigabenTable & Co. oben (rename aside, create fresh, copy, drop, alles in einer
// Transaktion, FK-Enforcement währenddessen aus). `marker` ist der neueste erlaubte Wert: steht er
// schon im CREATE-Statement der Tabelle, ist nichts zu tun.
// Gemeinsamer Helfer: baut `tabelle` mit dem neuen `createSql` neu auf, wenn `marker` noch nicht im
// bestehenden CREATE-Statement steht. `spalten` sind die zu kopierenden Spalten.
function erweitereCheckPerRebuild(db, { tabelle, marker, createSql, spalten }) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabelle);
  if (!tableSql || tableSql.sql.includes(marker)) return;
  const altName = `${tabelle}_pre_${marker.replace(/[^a-z0-9]/gi, '_')}`;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE ${tabelle} RENAME TO ${altName}`);
    db.exec(createSql);
    const liste = spalten.join(', ');
    db.exec(`INSERT INTO ${tabelle} (${liste}) SELECT ${liste} FROM ${altName}`);
    db.exec(`DROP TABLE ${altName}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Muss NACH migrateFreigabenTableVertretung laufen: die neu erstellte Tabelle enthält
// vertretung_fuer bereits, und die Kopie übernimmt die Spalte.
function migrateKreditkartenChecks(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'freigaben',
    marker: 'kk_markierung_aufgehoben',
    createSql: `CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)
    )`,
    spalten: ['id', 'job_id', 'person_id', 'rolle', 'zeitpunkt', 'ip', 'interessenskonflikt', 'kommentar', 'eskaliert_von', 'vertretung_fuer'],
  });
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'kk-beleg-eingegangen',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am'],
  });
  erweitereCheckPerRebuild(db, {
    tabelle: 'cron_log',
    marker: 'kk-beleg-erinnerungen',
    createSql: `CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen', 'kk-beleg-erinnerungen')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
      details TEXT
    )`,
    spalten: ['id', 'job', 'gestartet_am', 'beendet_am', 'status', 'details'],
  });
}

// Sicherheitsalarme (services/sicherheitsalarme.js) protokollieren ihren Versand im bestehenden
// mail_log; dafuer wird der typ-CHECK um 'sicherheitsalarm' erweitert (gleiches Rebuild-Muster).
function migrateMailLogSicherheitsalarm(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'sicherheitsalarm',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am'],
  });
}

// Persistente Mail-Zustellung (services/mailZustellung.js): neuer Status 'eingereiht' plus
// Zustellspalten (Versuche, nächster Versuch, befristete Sperre). Gleiches Rebuild-Muster; bereits
// protokollierte Zeilen behalten ihren Status ('versendet'/'fehlgeschlagen'/'geplant'). Der Index
// entsteht erst hier, weil schema.sql auf einer alten Tabelle ohne diese Spalten laufen kann.
function migrateMailZustellung(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'eingereiht',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
  erweitereCheckPerRebuild(db, {
    tabelle: 'cron_log',
    marker: 'mail-zustellung',
    createSql: `CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen', 'kk-beleg-erinnerungen', 'mail-zustellung')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
      details TEXT
    )`,
    spalten: ['id', 'job', 'gestartet_am', 'beendet_am', 'status', 'details'],
  });
}

// Admin-Umhängen (/admin/vorgaenge): neue freigaben-Rolle 'admin_umzuweisung' plus zwei Spalten
// (vorher zuständige Person, Zielperson) und neuer Mail-Typ 'admin-umzuweisung'. Gleiches
// Rebuild-Muster wie oben. Muss VOR migrateSecuritySchema laufen, damit die dort neu erzeugten
// Audit-Trigger die neuen freigaben-Spalten in ihren Snapshot aufnehmen.
function migrateAdminUmzuweisung(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'freigaben',
    marker: 'admin_umzuweisung',
    createSql: `CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich', 'admin_umzuweisung')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id),
      vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),
      ziel_person_id TEXT REFERENCES personen(churchtools_person_id)
    )`,
    spalten: ['id', 'job_id', 'person_id', 'rolle', 'zeitpunkt', 'ip', 'interessenskonflikt', 'kommentar', 'eskaliert_von', 'vertretung_fuer'],
  });
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'admin-umzuweisung',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  // Der Index verschwindet mit der alten Tabelle beim Rebuild.
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Duplikaterkennung Szenario 2 (gleicher Kreditor/Betrag/Zahlungsziel binnen 14 Tagen): neue
// freigaben-Rolle 'duplikat_verdacht' und Mail-Typ 'duplikat-warnung'. Gleiches Rebuild-Muster wie
// migrateAdminUmzuweisung, läuft danach und vor migrateSecuritySchema (Audit-Trigger neu).
function migrateDuplikatVerdacht(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'freigaben',
    marker: 'duplikat_verdacht',
    createSql: `CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich', 'admin_umzuweisung', 'duplikat_verdacht')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id),
      vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),
      ziel_person_id TEXT REFERENCES personen(churchtools_person_id)
    )`,
    spalten: ['id', 'job_id', 'person_id', 'rolle', 'zeitpunkt', 'ip', 'interessenskonflikt', 'kommentar', 'eskaliert_von', 'vertretung_fuer', 'vorher_zustaendig', 'ziel_person_id'],
  });
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'duplikat-warnung',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Audit-Nachweis für die Revision: neuer Mail-Typ 'audit-pruefnummer'. Gleiches Rebuild-Muster wie
// migrateDuplikatVerdacht (mail_log-Hälfte), läuft danach und vor migrateSecuritySchema.
function migrateAuditPruefnummerMailTyp(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'audit-pruefnummer',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung', 'audit-pruefnummer')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Betrieb & Nutzung: neue Mail-Typen 'neues-geraet' und 'fehlermeldung'. Gleiches Rebuild-Muster wie
// migrateAuditPruefnummerMailTyp, läuft danach und vor migrateSecuritySchema.
function migrateBetriebMailTypen(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'neues-geraet',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Mailtyp 'testmail' (Testversand aus den Admin-Seiten) im mail_log-CHECK ergänzen.
function migrateTestmailTyp(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'testmail',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung', 'testmail')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Kommentare an Rechnungen: neuer Mail-Typ 'kommentar'. Gleiches Rebuild-Muster wie
// migrateTestmailTyp, läuft danach und vor migrateSecuritySchema.
function migrateKommentarMailTyp(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: "'kommentar'",
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung', 'testmail', 'kommentar')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Kommentare an Rechnungen (docs/superpowers/specs/2026-10-25-kommentare-design.md). kommentare ist
// append-only (Trigger) und bekommt in migrateSecuritySchema die zentralen Audit-Trigger;
// kommentar_gelesen ist reiner Lesestand pro Person und darf überschrieben werden.
function migrateKommentareSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kommentare (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    person_id TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    erwaehnt TEXT NOT NULL DEFAULT '[]',
    erstellt_am TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS kommentare_job_idx ON kommentare(job_id);
  CREATE TRIGGER IF NOT EXISTS kommentare_no_update BEFORE UPDATE ON kommentare
  BEGIN SELECT RAISE(ABORT, 'kommentare ist unveraenderlich'); END;
  CREATE TRIGGER IF NOT EXISTS kommentare_no_delete BEFORE DELETE ON kommentare
  BEGIN SELECT RAISE(ABORT, 'kommentare ist unveraenderlich'); END;
  CREATE TABLE IF NOT EXISTS kommentar_gelesen (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    person_id TEXT NOT NULL,
    zuletzt_am TEXT NOT NULL,
    PRIMARY KEY (job_id, person_id)
  );`);
}

// Rapporte (nur zur Kenntnis), docs/superpowers/specs/2026-11-06-rapporte-kenntnisnahme-design.md.
// Eine Zeile pro zugeteilter Person; bestätigte Zeilen sind unveränderlich, gelöscht wird nie
// (Entfernen/Ersetzen setzt entfernt_am bzw. ersetzt_durch_id). Audit-Trigger: migrateSecuritySchema.
function migrateRapporteSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kenntnisnahmen (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
    zugeteilt_am TEXT NOT NULL,
    bestaetigt_am TEXT,
    entfernt_am TEXT,
    entfernt_von TEXT,
    begruendung TEXT,
    ersetzt_durch_id INTEGER REFERENCES kenntnisnahmen(id),
    erinnert_am TEXT
  );
  CREATE INDEX IF NOT EXISTS kenntnisnahmen_job_idx ON kenntnisnahmen(job_id);
  CREATE UNIQUE INDEX IF NOT EXISTS kenntnisnahmen_offen_eindeutig ON kenntnisnahmen(job_id, person_id)
    WHERE bestaetigt_am IS NULL AND entfernt_am IS NULL;
  CREATE TRIGGER IF NOT EXISTS kenntnisnahmen_bestaetigt_unveraenderlich BEFORE UPDATE ON kenntnisnahmen
  WHEN OLD.bestaetigt_am IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'bestaetigte kenntnisnahme ist unveraenderlich'); END;
  CREATE TRIGGER IF NOT EXISTS kenntnisnahmen_no_delete BEFORE DELETE ON kenntnisnahmen
  BEGIN SELECT RAISE(ABORT, 'kenntnisnahmen ist unveraenderlich'); END;`);
}

// Betrugserkennung: manuelle IBAN-Kontrolle und bestätigte Auffälligkeiten als freigaben-Rollen, dazu der
// Mailtyp auffaelligkeiten-warnung.
// Läuft nach migrateRapportChecks und vor migrateSecuritySchema (das die Audit-Trigger neu anlegt).
function migrateBetrugserkennungChecks(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'freigaben',
    marker: 'auffaelligkeiten_bestaetigt',
    createSql: `CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich', 'admin_umzuweisung', 'duplikat_verdacht', 'rapport_markiert', 'rapport_bestaetigt', 'rapport_empfaenger_ersetzt', 'rapport_empfaenger_entfernt', 'rapport_markierung_aufgehoben', 'iban_manuell_geprueft', 'auffaelligkeiten_bestaetigt')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id),
      vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),
      ziel_person_id TEXT REFERENCES personen(churchtools_person_id)
    )`,
    spalten: ['id', 'job_id', 'person_id', 'rolle', 'zeitpunkt', 'ip', 'interessenskonflikt', 'kommentar', 'eskaliert_von', 'vertretung_fuer', 'vorher_zustaendig', 'ziel_person_id'],
  });
  // Mailtyp auffaelligkeiten-warnung (ersetzt iban-warnung; der alte Wert bleibt für bestehende Zeilen erlaubt).
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'auffaelligkeiten-warnung',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung', 'testmail', 'kommentar', 'rapport-zuweisung', 'rapport-reminder', 'rapport-eskalation', 'auffaelligkeiten-warnung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}

// Rapporte: neue freigaben-Rollen, Mail-Typen und cron_log-Job. Gleiches Rebuild-Muster wie
// migrateKommentarMailTyp/migrateDuplikatVerdacht, läuft danach und vor migrateSecuritySchema.
function migrateRapportChecks(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'freigaben',
    marker: 'rapport_markierung_aufgehoben',
    createSql: `CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich', 'admin_umzuweisung', 'duplikat_verdacht', 'rapport_markiert', 'rapport_bestaetigt', 'rapport_empfaenger_ersetzt', 'rapport_empfaenger_entfernt', 'rapport_markierung_aufgehoben')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id),
      vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),
      ziel_person_id TEXT REFERENCES personen(churchtools_person_id)
    )`,
    spalten: ['id', 'job_id', 'person_id', 'rolle', 'zeitpunkt', 'ip', 'interessenskonflikt', 'kommentar', 'eskaliert_von', 'vertretung_fuer', 'vorher_zustaendig', 'ziel_person_id'],
  });
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'rapport-eskalation',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung', 'duplikat-warnung', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung', 'testmail', 'kommentar', 'rapport-zuweisung', 'rapport-reminder', 'rapport-eskalation')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
  erweitereCheckPerRebuild(db, {
    tabelle: 'cron_log',
    marker: 'rapport-erinnerungen',
    createSql: `CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen', 'kk-beleg-erinnerungen', 'mail-zustellung', 'rapport-erinnerungen')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
      details TEXT
    )`,
    spalten: ['id', 'job', 'gestartet_am', 'beendet_am', 'status', 'details'],
  });
}

// Persönliche Benachrichtigungen: der globale Schalter mail_batching_aktiv wird zum Standard
// mail_standard_benachrichtigung (einmalig: nur wenn der neue Schlüssel fehlt), und die Digest-
// Vorlage wird auf den neuen Standard gehoben, sofern sie noch exakt dem alten entspricht.
const ALTE_DIGEST_VORLAGE = {
  mail_vorlage_digest_betreff: ['Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)', 'Freigabeportal: %zusammenfassung% Zusammenfassung (%anzahl% Ereignisse)'],
  mail_vorlage_digest_text: ['Hallo %empfaengerName%,\n\nfolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
    // Zwischenstand aus der Entwicklung (nie ausgeliefert)
    'Hallo %empfaengerName%,\n\n%zusammenfassung% Zusammenfassung (Einstellung ändern: %einstellungenLink%)\n\nFolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%'],
};

function migrateBenachrichtigungEinstellung(db) {
  const wert = (key) => db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key)?.value ?? null;
  if (wert('mail_standard_benachrichtigung') === null) {
    const standard = wert('mail_batching_aktiv') === '1' ? 'taeglich' : 'sofort';
    db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?)').run('mail_standard_benachrichtigung', standard);
  }
  for (const [key, alt] of Object.entries(ALTE_DIGEST_VORLAGE)) {
    const aktuell = wert(key);
    // Browser senden Textareas mit CRLF: Zeilenenden und Rand-Leerraum vor dem Vergleich vereinheitlichen.
    if (aktuell !== null && alt.includes(aktuell.replace(/\r\n?/g, '\n').trim())) {
      db.prepare('UPDATE admin_config SET value = ? WHERE key = ?').run(getDefaultConfigValue(key), key);
    }
  }
}

/**
 * Öffnet (und erstellt bei Bedarf) die Datenbank, registriert die Audit-SQL-Funktionen, führt
 * schema.sql und alle Migrationen aus und sät die Gruppenrechte.
 * @param {string} dbPath Dateipfad oder `:memory:` (Tests)
 * @returns {DatabaseSync} offene Datenbank; der Aufrufer schliesst sie
 */
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // SQL-Funktionen für die Audit-Trigger: sie lesen Handelnde, Request-ID und Lauf aus dem aktuellen
  // AsyncLocalStorage-Kontext (services/auditContext.js), damit jedes protokollierte Ereignis weiss, wer es auslöste.
  db.function('audit_actor_id', () => currentAuditActor().id);
  db.function('audit_actor_name', () => currentAuditActor().name);
  db.function('audit_request_id', currentAuditRequestId);
  db.function('audit_operation_id', () => currentAuditOperation()?.id || null);
  db.function('audit_operation_kind', () => currentAuditOperation()?.kind || null);
  // Vor schema.sql: benennt debitoren/debitor_* in bestehenden Datenbanken um (siehe Datei).
  migrateKreditorenBezeichnung(db);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrateJobsTableQuelleCheck(db);
  migrateJobsStatusKenntnisnahme(db);
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  migrateMailLogTable(db);
  migrateCronLogTable(db);
  migratePersonBerechtigungenTable(db);
  migrateCronLogTableSplitGruppen(db);
  migrateMailLogTableGeplantStatus(db);
  migrateCronLogTableMailDigest(db);
  migrateMailLogTableFreigabe2(db);
  migrateCronLogTableFreigabe2Erinnerungen(db);
  migratePersonenTable(db);
  migrateKreditorenTable(db);
  migrateKontenTable(db);
  migrateFreigabenTableVertretung(db);
  migrateKreditkartenChecks(db);
  migrateMailLogSicherheitsalarm(db);
  migrateMailZustellung(db);
  migrateAdminUmzuweisung(db);
  migrateDuplikatVerdacht(db);
  migrateAuditPruefnummerMailTyp(db);
  migrateBetriebMailTypen(db);
  migrateTestmailTyp(db);
  migrateKommentarMailTyp(db);
  migrateKommentareSchema(db);
  migrateRapporteSchema(db);
  migrateRapportChecks(db);
  migrateBetrugserkennungChecks(db);
  migrateBenachrichtigungEinstellung(db);
  migrateBetriebSchema(db);
  // Muss NACH migrateKreditkartenChecks laufen: die CHECK-Rebuilds (freigaben, mail_log, cron_log)
  // verwerfen die Trigger der alten Tabelle, und migrateSecuritySchema legt die Audit-Trigger mit
  // der aktuellen Spaltenliste neu an. person_berechtigungen gehört allein migrateSecuritySchema.
  migrateExportIntegritaetSchema(db);
  migrateSecuritySchema(db);
  migrateAuditRequestSchema(db);
  migrateZugriffsAuditSchema(db);
  migrateDateiQuarantaeneSchema(db);
  migrateSicherheitsalarmSchema(db);
  migrateTsaNachweisSchema(db);
  migrateAuditExportSchema(db);
  seedGruppenBerechtigungen(db);
  return db;
}
