const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
  reminder_empfaenger: 'gruppe:buchhaltung',
  eskalation_empfaenger: 'gruppe:buchhaltung',
  freigabe2_reminder_stunden: '24',
  freigabe2_eskalation_stunden: '48',
  freigabe2_eskalation_empfaenger: 'gruppe:admin',
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
  iban_abweichung_empfaenger: 'gruppe:admin',
  audit_log_lokale_zeit: '0',
  cron_sync_personen_stunde: '2',
  cron_sync_personen_minute: '0',
  cron_pdf_bereinigung_stunde: '2',
  cron_pdf_bereinigung_minute: '30',
  cron_pool_erinnerungen_intervall_minuten: '60',
  cron_freigabe2_erinnerungen_intervall_minuten: '60',
  zeitstempel_tsa_url: '',
  zeitstempel_tsa_user: '',
  zeitstempel_tsa_passwort: '',
  cron_zeitstempel_nachholen_intervall_minuten: '5',
  cron_split_gruppen_nachholen_intervall_minuten: '15',
  zeitstempel_warnung_ab_stunden: '2',
  backup_cron_stunde: '3',
  backup_cron_minute: '0',
  backup_aufbewahrung_anzahl: '14',
  modul_spesen_aktiv: '1',
  kontierung_strikte_freigeber1_pruefung: '0',
  mail_vorlage_zuweisung_betreff: 'Freigabeportal: Neue Rechnung zur Bearbeitung',
  mail_vorlage_zuweisung_text: 'Hallo %empfaengerName%,\n\n%grund%\n\nBeleg: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_reminder_betreff: 'Freigabeportal: Rechnung wartet im Pool',
  mail_vorlage_reminder_text: 'Diese Rechnung ist seit mehr als %stunden% Stunden unbeansprucht im Pool: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_eskalation_betreff: 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht',
  mail_vorlage_eskalation_text: 'Diese Rechnung ist seit mehr als %stunden% Stunden unbeansprucht im Pool und wurde eskaliert: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_freigabe2_reminder_betreff: 'Freigabeportal: Offene Freigabe wartet auf Sie',
  mail_vorlage_freigabe2_reminder_text: 'Hallo %empfaengerName%,\n\ndiese Rechnung wartet seit mehr als %stunden% Stunden auf Ihre Freigabe: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_freigabe2_eskalation_betreff: 'Freigabeportal: Eskalation – Freigabe seit langem ausstehend',
  mail_vorlage_freigabe2_eskalation_text: 'Diese Rechnung wartet seit mehr als %stunden% Stunden auf Freigabe 2 und wurde an die Administration übergeben: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_ablehnung_betreff: 'Freigabeportal: Rechnung abgelehnt',
  mail_vorlage_ablehnung_text: 'Hallo %empfaengerName%,\n\n%grund% %jobDateiname%\n\nGrund: %begruendung%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_sync_fehler_betreff: 'Freigabeportal: ChurchTools-Sync fehlgeschlagen',
  mail_vorlage_sync_fehler_text: 'Der ChurchTools-Personen-Sync konnte nicht erfolgreich abgeschlossen werden (%zeitpunkt%): %fehlerDetails%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_iban_warnung_betreff: 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt',
  mail_vorlage_iban_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %debitorName%) weicht die im QR-Code gefundene IBAN (%tatsaechlicheIban%) von der hinterlegten IBAN ab.\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_rechnungsnummer_warnung_betreff: 'Freigabeportal: Doppelte Rechnungsnummer festgestellt',
  mail_vorlage_rechnungsnummer_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %debitorName%) wurde die Rechnungsnummer "%rechnungsnummer%" bereits bei einem anderen Job erfasst (%dupJobIds%).\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_digest_betreff: 'Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)',
  mail_vorlage_digest_text: 'Hallo %empfaengerName%,\n\nfolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_batching_aktiv: '0',
  mail_batching_stunde: '7',
  mail_batching_minute: '0',
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
