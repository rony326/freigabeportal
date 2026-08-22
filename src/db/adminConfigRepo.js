const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
  reminder_empfaenger: 'gruppe:buchhaltung',
  eskalation_empfaenger: 'gruppe:buchhaltung',
  branding_farbe_primaer: '#2f4858',
  branding_farbe_sekundaer: '#4d7ea8',
  branding_theme_default: 'system',
  branding_logo_ausrichtung: 'links',
  footer_text: 'Freigabeportal',
  seiten_titel: 'Freigabeportal',
  mail_log_aufbewahrung_tage: '90',
  sync_max_deaktivierung_prozent: '50',
  sync_max_deaktivierung_anzahl: '10',
  sync_fehler_empfaenger: 'gruppe:admin',
  audit_log_lokale_zeit: '0',
  cron_sync_personen_stunde: '2',
  cron_sync_personen_minute: '0',
  cron_pdf_bereinigung_stunde: '2',
  cron_pdf_bereinigung_minute: '30',
  cron_pool_erinnerungen_intervall_minuten: '60',
  zeitstempel_tsa_url: '',
  zeitstempel_tsa_user: '',
  zeitstempel_tsa_passwort: '',
  cron_zeitstempel_nachholen_intervall_minuten: '5',
  zeitstempel_warnung_ab_stunden: '2',
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
