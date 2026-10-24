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
  modul_kreditkarten_aktiv: '0',
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
  mail_vorlage_iban_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %kreditorName%) weicht die im QR-Code gefundene IBAN (%tatsaechlicheIban%) von der hinterlegten IBAN ab.\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_rechnungsnummer_warnung_betreff: 'Freigabeportal: Doppelte Rechnungsnummer festgestellt',
  mail_vorlage_rechnungsnummer_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %kreditorName%) wurde die Rechnungsnummer "%rechnungsnummer%" bereits bei einem anderen Job erfasst (%dupJobIds%).\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_digest_betreff: 'Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)',
  mail_vorlage_digest_text: 'Hallo %empfaengerName%,\n\nfolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_batching_aktiv: '0',
  mail_batching_stunde: '7',
  mail_batching_minute: '0',
  mail_vorlage_kk_abrechnung_zugewiesen_betreff: 'Freigabeportal: Kreditkartenabrechnung zum Abgleich',
  mail_vorlage_kk_abrechnung_zugewiesen_text: 'Hallo %empfaengerName%,\n\neine Abrechnung der Karte "%karte%" wartet auf deinen Abgleich (%jobDateiname%). Zu dieser Karte sind aktuell %anzahlBelege% offene Belege erfasst.\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  kk_beleg_erinnerungen_aktiv: '1',
  kk_beleg_erinnerung_tage: '45',
  cron_kk_beleg_erinnerungen_stunde: '8',
  cron_kk_beleg_erinnerungen_minute: '0',
  mail_vorlage_kk_beleg_erinnerung_betreff: 'Freigabeportal: Offene Kreditkartenbelege',
  mail_vorlage_kk_beleg_erinnerung_text: 'Hallo %empfaengerName%,\n\nfolgende Kreditkartenbelege bzw. -abrechnungen sind seit mehr als %tage% Tagen offen (%anzahl%):\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_kk_beleg_eingegangen_betreff: 'Freigabeportal: Kreditkartenbeleg eingegangen – bitte ergänzen',
  mail_vorlage_kk_beleg_eingegangen_text: 'Hallo %empfaengerName%,\n\ndein per Mail eingereichter Kreditkartenbeleg ist im Portal eingegangen. Bitte ergänze Karte, Betrag, Kaufdatum und Beschreibung: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_duplikat_warnung_betreff: 'Freigabeportal: Mögliche doppelte Rechnung festgestellt',
  mail_vorlage_duplikat_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %kreditorName%) wurde ein anderer Vorgang mit gleichem Betrag (%betrag%) und gleichem Zahlungsziel (%zahlungsziel%) gefunden, der innerhalb von %tage% Tagen eingegangen ist (%dupJobIds%). Möglicherweise wurde dieselbe Rechnung zweimal erfasst.\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_audit_pruefnummer_betreff: 'Freigabeportal: Audit-Prüfnummer für die Revision',
  mail_vorlage_audit_pruefnummer_text: 'Guten Tag\n\ndies ist die regelmässige Prüfnummer des Audit-Protokolls des %portalName%. Bitte diese Mail aufbewahren.\n\nPaketnummer: %paketNr%\nPrüfnummer: %pruefnummer%\nZeitraum: %vonZeit% bis %bisZeit%\nProtokollierte Ereignisse insgesamt: %anzahlEreignisse%\nZeitstempel: %zeitstempelZeit%\nPakete noch ohne Zeitstempel: %ohneZeitstempel%\n\nBei der Prüfung: Link öffnen oder Paketnummer und Prüfnummer auf %pruefseite% eingeben. Stimmt alles, wurde das Protokoll seit dieser Mail nicht verändert.\n\n%link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_neues_geraet_betreff: 'Freigabeportal: Neue Anmeldung von einem unbekannten Gerät',
  mail_vorlage_neues_geraet_text: 'Hallo %empfaengerName%,\n\nam %zeitpunkt% wurde eine Anmeldung in deinem Konto im %portalName% von einem neuen Gerät festgestellt.\n\nGerät: %geraet%\nIP-Adresse: %ip%\n\nWarst du das nicht? Melde dich bei %kontakt%.\n\nWenn du deine Browserdaten gelöscht oder ein privates Fenster benutzt hast, kann auch das der Grund sein.\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_fehlermeldung_betreff: 'Freigabeportal: Neue Fehlermeldung von %meldendePerson%',
  mail_vorlage_fehlermeldung_text: 'Hallo %empfaengerName%,\n\n%meldendePerson% hat im %portalName% ein Problem gemeldet.\n\nSeite: %seite%\nFehler-ID: %fehlerId%\nBeschreibung: %beschreibung%\n\nZur Meldung: %link%\n\nFreundliche Grüsse\n%portalName%',
  betrieb_kontakt_email: '',
  datenschutz_text: 'Das Portal speichert Nutzungsdaten, damit es zuverlässig läuft, weiterentwickelt werden kann und sicher bleibt.\n\nWelche Daten: Seitenaufrufe (wer wann welche Seite aufgerufen hat, mit Gerät, Browser und Betriebssystem), Anmeldungen (mit IP-Adresse und Gerät), die Geräte, mit denen du dich angemeldet hast, aufgetretene Fehler sowie Fehlermeldungen, die du über "Problem melden" abschickst. Nicht gespeichert werden Formularinhalte und Suchbegriffe.\n\nCookie: Das Portal setzt das Cookie "fp_geraet" mit einer zufälligen Geräte-ID. Es dient der Erkennung neuer Geräte.\n\nZweck: Wartung, Weiterentwicklung und Sicherheit (zum Beispiel Warnung bei Anmeldung von einem neuen Gerät).\n\nAufbewahrung: Seitenaufrufe 90 Tage; Anmeldungen, Fehler und Fehlermeldungen 1 Jahr; Geräte 1 Jahr nach der letzten Nutzung. Danach werden die Daten automatisch gelöscht.\n\nZugriff: Nur Personen mit dem Recht "Betrieb & Nutzung" können diese Daten einsehen.\n\nKontakt bei Fragen: %kontakt%.',
  audit_revision_empfaenger: '',
  modul_audit_nachweis_aktiv: '1',
  audit_pruefnummer_rhythmus: 'monatlich',
  audit_pruefnummer_tag: '1',
  cron_audit_export_stunde: '3',
  cron_audit_export_minute: '15',
  cron_audit_pruefnummer_stunde: '7',
  cron_audit_pruefnummer_minute: '0',
  cron_nutzungsdaten_bereinigung_stunde: '3',
  cron_nutzungsdaten_bereinigung_minute: '45',
  audit_zeitstempel_alarm_tage: '3',
  mail_vorlage_admin_umzuweisung_betreff: 'Freigabeportal: Vorgang durch Administration übergeben',
  mail_vorlage_admin_umzuweisung_text: 'Hallo %empfaengerName%,\n\n%grund%\n\nVorgang: %jobDateiname%\nBemerkung von %adminName%: %bemerkung%\n\n%link%\n\nFreundliche Grüsse\n%portalName%',
  kk_beleg_verworfen_loeschen_tage: '90',
  verwaiste_dateien_mindestalter_stunden: '24',
  sicherheitsalarm_empfaenger: 'gruppe:admin',
  sicherheitsalarm_wiederholung_stunden: '24',
  cron_sicherheitsalarme_intervall_minuten: '30',
  cron_mail_zustellung_intervall_minuten: '5',
  mail_zustellung_max_versuche: '8',
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

export function deleteConfigValue(db, key) {
  db.prepare('DELETE FROM admin_config WHERE key = ?').run(key);
}
