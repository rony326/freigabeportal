// Betrieb & Nutzung: Nutzungsdaten (ohne Audit-Trigger, Massendaten), Fehler, Fehlermeldungen, Banner.
// Läuft VOR migrateSecuritySchema, damit banner und betrieb_fehlermeldungen dort Audit-Trigger bekommen.
export function migrateBetriebSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nutzung_seitenaufrufe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zeitpunkt TEXT NOT NULL,
      person_id TEXT NOT NULL,
      methode TEXT,
      pfad TEXT NOT NULL,
      pfad_muster TEXT NOT NULL,
      status INTEGER,
      dauer_ms INTEGER,
      geraet_id TEXT,
      geraet_typ TEXT,
      browser TEXT,
      betriebssystem TEXT,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS nutzung_seitenaufrufe_zeit_idx ON nutzung_seitenaufrufe(zeitpunkt);
    CREATE INDEX IF NOT EXISTS nutzung_seitenaufrufe_person_idx ON nutzung_seitenaufrufe(person_id, zeitpunkt);

    CREATE TABLE IF NOT EXISTS nutzung_geraete (
      geraet_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      erstmals_am TEXT,
      zuletzt_am TEXT,
      user_agent TEXT,
      geraet_typ TEXT,
      browser TEXT,
      betriebssystem TEXT,
      PRIMARY KEY (geraet_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS nutzung_anmeldungen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zeitpunkt TEXT,
      person_id TEXT,
      erfolg INTEGER NOT NULL,
      grund TEXT,
      ip TEXT,
      geraet_id TEXT,
      user_agent TEXT,
      neues_geraet INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS betrieb_fehler (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT UNIQUE NOT NULL,
      zeitpunkt TEXT,
      person_id TEXT,
      methode TEXT,
      pfad TEXT,
      status INTEGER,
      meldung TEXT,
      stack TEXT,
      user_agent TEXT,
      geraet_id TEXT
    );

    CREATE TABLE IF NOT EXISTS betrieb_fehlermeldungen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zeitpunkt TEXT,
      person_id TEXT NOT NULL,
      request_id TEXT,
      beschreibung TEXT CHECK (length(beschreibung) <= 2000),
      seite TEXT,
      user_agent TEXT,
      status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'in_arbeit', 'erledigt')),
      notiz TEXT,
      bearbeitet_von TEXT,
      bearbeitet_am TEXT
    );

    CREATE TABLE IF NOT EXISTS banner (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      art TEXT NOT NULL CHECK (art IN ('info', 'wartung', 'warnung')),
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
      link TEXT,
      von TEXT NOT NULL,
      bis TEXT NOT NULL CHECK (bis >= von),
      erstellt_von TEXT,
      erstellt_am TEXT,
      aktiv INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS banner_ausgeblendet (
      banner_id INTEGER NOT NULL,
      person_id TEXT NOT NULL,
      zeitpunkt TEXT,
      PRIMARY KEY (banner_id, person_id)
    );
  `);

  // Einmaliger Hinweis auf die Nutzungsdaten; das Marker-Flag verhindert Neuanlage nach Löschen/Deaktivieren.
  const marker = db.prepare("SELECT 1 FROM admin_config WHERE key = 'betrieb_datenschutz_banner_angelegt'").get();
  if (!marker) {
    const jetzt = new Date();
    const bis = new Date(jetzt.getTime() + 60 * 24 * 3600 * 1000);
    db.prepare("INSERT INTO banner (art, text, link, von, bis, erstellt_von, erstellt_am, aktiv) VALUES ('info', ?, '/datenschutz', ?, ?, NULL, ?, 1)")
      .run('Neu: Das Portal speichert Nutzungsdaten zur Wartung, Weiterentwicklung und Sicherheit. Details unter Datenschutz.', jetzt.toISOString(), bis.toISOString(), jetzt.toISOString());
    db.prepare("INSERT INTO admin_config (key, value) VALUES ('betrieb_datenschutz_banner_angelegt', '1')").run();
  }
}
