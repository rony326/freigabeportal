const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
  reminder_empfaenger: 'gruppe:buchhaltung',
  eskalation_empfaenger: 'gruppe:buchhaltung',
  branding_farbe_primaer: '#2f4858',
  branding_farbe_sekundaer: '#4d7ea8',
  branding_theme_default: 'system',
  visum_seite_position: 'letzte',
  mail_log_aufbewahrung_tage: '90',
  sync_max_deaktivierung_prozent: '50',
  sync_max_deaktivierung_anzahl: '10',
  sync_fehler_empfaenger: 'gruppe:admin',
};

export function seedDefaults(db) {
  const insert = db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    insert.run(key, value);
  }
}

export function getConfigValue(db, key) {
  const row = db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfigValue(db, key, value) {
  db.prepare(
    'INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
