CREATE TABLE IF NOT EXISTS personen (
  churchtools_person_id TEXT PRIMARY KEY,
  vorname TEXT NOT NULL,
  nachname TEXT NOT NULL,
  email TEXT NOT NULL,
  aktiv INTEGER NOT NULL DEFAULT 1,
  gruppen TEXT NOT NULL DEFAULT '[]',
  ct_person_unresolved INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_login_at TEXT
);

-- Additive Einzelrechte pro Person, unabhängig von der ChurchTools-Rolle (superadmin/manager).
-- Nur die sieben vergebbaren Rechte sind hier zulässig -- die drei hart gesperrten Admin-Bereiche
-- (Eskalationszeiten, Erscheinungsbild, Zeitstempel) sowie das Bearbeiten dieser Tabelle selbst
-- sind strukturell nicht einfügbar, unabhängig von der Anwendungslogik.
CREATE TABLE IF NOT EXISTS person_berechtigungen (
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  berechtigung TEXT NOT NULL CHECK (berechtigung IN (
    'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
    'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen'
  )),
  PRIMARY KEY (person_id, berechtigung)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gestartet_am TEXT NOT NULL,
  beendet_am TEXT,
  status TEXT NOT NULL,
  fehler_details TEXT,
  anzahl_upserted INTEGER,
  anzahl_deaktiviert INTEGER
);

CREATE TABLE IF NOT EXISTS admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Execution history for the scheduled/manually-triggered pool-erinnerungen and pdf-bereinigung
-- jobs (services/cronJobs.js) -- sync-personen keeps its own richer sync_log above (upserted/
-- deaktiviert counts), so it isn't duplicated in here.
-- beendet_am is nullable and status allows 'laufend' so a run can be recorded as started before it
-- finishes -- needed by zeitstempel-nachholen (see hasRecentRunningCronLauf in cronLogRepo.js) to
-- detect an overlapping run in progress; pool-erinnerungen and pdf-bereinigung still always write
-- both fields in one shot via logCronLauf and never use 'laufend'.
CREATE TABLE IF NOT EXISTS cron_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
  gestartet_am TEXT NOT NULL,
  beendet_am TEXT,
  status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
  details TEXT
);

CREATE TABLE IF NOT EXISTS konten (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kontonummer TEXT NOT NULL,
  bezeichnung TEXT NOT NULL,
  freigeber1_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  stellvertreter1_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  freigeber2_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  stellvertreter2_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  aktiv INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS debitoren (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  konto_id INTEGER REFERENCES konten(id),
  aktiv INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS debitor_ibans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debitor_id INTEGER NOT NULL REFERENCES debitoren(id),
  iban TEXT NOT NULL UNIQUE,
  quelle TEXT NOT NULL CHECK (quelle IN ('manuell', 'bestaetigt')) DEFAULT 'manuell',
  erstellt_am TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zuweisungsregeln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  absender_muster TEXT NOT NULL UNIQUE,
  debitor_id INTEGER NOT NULL REFERENCES debitoren(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eingang_am TEXT NOT NULL,
  quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant')),
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
  debitor_id INTEGER REFERENCES debitoren(id),
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
);

-- Manipulationsschutz: sobald ein Zeitstempel-Hash/-Zeitpunkt für einen Job gesetzt ist, darf er
-- nicht mehr auf einen ANDEREN Wert geändert werden (der eigentliche Manipulationsfall) — nur das
-- erstmalige Setzen (NULL -> Wert) und das bestehende Zurücksetzen bei fehlgeschlagenem Ablegen der
-- gestempelten Datei (Wert -> NULL, siehe freigabe2.js) bleiben erlaubt. Schützt unabhängig davon,
-- über welchen Code-Pfad ein UPDATE versucht wird (auch vor Bugs oder direkten DB-Zugriffen).
CREATE TRIGGER IF NOT EXISTS trg_zeitstempel_hash_unveraenderlich
BEFORE UPDATE OF zeitstempel_datei_hash ON jobs
WHEN OLD.zeitstempel_datei_hash IS NOT NULL
  AND NEW.zeitstempel_datei_hash IS NOT NULL
  AND NEW.zeitstempel_datei_hash <> OLD.zeitstempel_datei_hash
BEGIN
  SELECT RAISE(ABORT, 'zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
END;

CREATE TRIGGER IF NOT EXISTS trg_zeitstempel_gesetzt_am_unveraenderlich
BEFORE UPDATE OF zeitstempel_gesetzt_am ON jobs
WHEN OLD.zeitstempel_gesetzt_am IS NOT NULL
  AND NEW.zeitstempel_gesetzt_am IS NOT NULL
  AND NEW.zeitstempel_gesetzt_am <> OLD.zeitstempel_gesetzt_am
BEGIN
  SELECT RAISE(ABORT, 'zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
END;

CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_hash_unveraenderlich
BEFORE UPDATE OF gruppe_zeitstempel_datei_hash ON jobs
WHEN OLD.gruppe_zeitstempel_datei_hash IS NOT NULL
  AND NEW.gruppe_zeitstempel_datei_hash IS NOT NULL
  AND NEW.gruppe_zeitstempel_datei_hash <> OLD.gruppe_zeitstempel_datei_hash
BEGIN
  SELECT RAISE(ABORT, 'gruppe_zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
END;

CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_gesetzt_am_unveraenderlich
BEFORE UPDATE OF gruppe_zeitstempel_gesetzt_am ON jobs
WHEN OLD.gruppe_zeitstempel_gesetzt_am IS NOT NULL
  AND NEW.gruppe_zeitstempel_gesetzt_am IS NOT NULL
  AND NEW.gruppe_zeitstempel_gesetzt_am <> OLD.gruppe_zeitstempel_gesetzt_am
BEGIN
  SELECT RAISE(ABORT, 'gruppe_zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
END;

CREATE TABLE IF NOT EXISTS freigaben (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung')),
  zeitpunkt TEXT NOT NULL,
  ip TEXT NOT NULL,
  interessenskonflikt INTEGER NOT NULL DEFAULT 0,
  kommentar TEXT,
  eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
);

CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung')),
  job_id INTEGER REFERENCES jobs(id),
  empfaenger TEXT NOT NULL,
  betreff TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
  fehler_details TEXT,
  versucht_am TEXT NOT NULL
);

-- job_id is deliberately NOT a foreign key: the whole point of this table is to keep a record
-- after the jobs row it refers to has been permanently deleted (see loeschenJob). dateiname is
-- duplicated here for the same reason — it would otherwise be unrecoverable once the job is gone.
CREATE TABLE IF NOT EXISTS job_loeschungen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  dateiname TEXT NOT NULL,
  geloescht_von TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  begruendung TEXT NOT NULL,
  zeitpunkt TEXT NOT NULL
);

-- Audit-Trail für Datenbank-Wiederherstellungen (Admin -> Datenbank-Backup). Eigene, schlanke
-- Tabelle statt Zweckentfremdung von cron_log: anders als bei den geplanten Jobs muss hier
-- festgehalten werden, welche Person eine Wiederherstellung ausgelöst hat.
-- wiederhergestellt_von is deliberately NOT a foreign key (same rationale as job_loeschungen.job_id,
-- only in the other direction): this row is written into the JUST-RESTORED database, whose personen
-- table comes from the archive and may not contain the person who performed the restore at all
-- (e.g. restoring an archive that predates that admin's account). An enforced FK would make the
-- audit insert fail and report an already-successful restore as an error.
CREATE TABLE IF NOT EXISTS backup_wiederherstellungen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dateiname TEXT NOT NULL,
  wiederhergestellt_von TEXT NOT NULL,
  zeitpunkt TEXT NOT NULL
);
