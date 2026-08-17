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
    'abgeschlossen','abgeholt','archiviert','abgelehnt','aufgesplittet'
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
  aufgesplittet_von INTEGER REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS freigaben (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung')),
  zeitpunkt TEXT NOT NULL,
  ip TEXT NOT NULL,
  interessenskonflikt INTEGER NOT NULL DEFAULT 0,
  kommentar TEXT,
  eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
);

CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler')),
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
