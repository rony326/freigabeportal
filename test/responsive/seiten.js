// Seitenliste für den Responsive-Browsertest (test/responsive/run.js).
//
// Jeder Eintrag: { name, view, pfad, als?, fehlerzustand? }
// - view: die gerenderte View (relativ zu views/, ohne .ejs) — test/unit/responsiveSeitenliste.test.js
//   prüft, dass jede Seiten-View (wie im layoutSweep: views/*.ejs und views/admin/*.ejs ohne
//   führenden Unterstrich) hier vorkommt oder in AUSGENOMMEN begründet ist.
// - pfad: {schluessel} wird zur Laufzeit durch die IDs aus server.js (ergaenzeDaten) ersetzt.
// - als: Beispielperson für Seiten, die eine andere Rolle als Dora (test-4, Superadmin) brauchen.
//   test-1 Anna (Freigeberin 1), test-2 Ben (Freigeber 2), test-3 Carla (Spesen).
// - fehlerzustand: Formular nach dem Laden ohne Browser-Prüfung absenden, damit die Seite mit
//   Fehlermeldungen geprüft wird (Review Focus 2). { formular, felder?, knopf?, entferneAttribute? }
//   formular/knopf sind CSS-Selektoren, felder setzt Werte per name.
//   Antwortet das Formular mit Weiterleitung (POST → 302 → GET), wird die Zielseite geprüft.
// - status: erwarteter HTTP-Status (Standard 200; bei fehlerzustand der Status der Antwortseite).
// - pdf: true für Seiten mit Beleg/Formular-Umschalter: unter 992 px darf weder der PDF.js-Viewer
//   noch das signierte PDF geladen werden, ab 992 px muss das eingebettete PDF (iframe) geladen sein.
// - modal: { knopf, modal, iframe? } nach den Seitenprüfungen den Dialog über seinen Knopf öffnen,
//   im offenen Dialog Touch/Text/Überlappung prüfen, ob der Schliessen-Knopf frei liegt (nicht vom
//   Testmodus-Band verdeckt) und — mit iframe — im Dokument des iframes alle Seitenprüfungen
//   (seitliches Scrollen, Touch …) und dass dort kein Beleg/Formular-Umschalter sichtbar ist.
//
// Neue Seite: Eintrag ergänzen; braucht sie Daten, die die Testmodus-Beispieldaten nicht haben,
// diese in server.js (ergaenzeDaten) anlegen und die ID in `ids` zurückgeben.

const LANGER_KOMMENTAR = `${'Rückfrage'.repeat(240)}x`; // > 2000 Zeichen → 422

export const SEITEN = [
  // ---------- Portal ----------
  { name: 'Aufgaben (Dora)', view: 'pool', pfad: '/pool' },
  { name: 'Aufgaben (Anna)', view: 'pool', pfad: '/pool', als: 'test-1' },
  { name: 'Aufgaben Kacheln', view: 'pool', pfad: '/pool?ansicht=kacheln', als: 'test-1' },
  { name: 'Aufgaben Tabelle', view: 'pool', pfad: '/pool?ansicht=tabelle', als: 'test-1' },
  { name: 'Kontierung', view: 'kontierung', pfad: '/kontierung/{anna}', als: 'test-1', pdf: true },
  {
    name: 'Kontierung mit Fehlern', view: 'kontierung', pfad: '/kontierung/{anna}', als: 'test-1', status: 400, pdf: true,
    fehlerzustand: { formular: '#kontierung-form', knopf: 'button[name="aktion"][value="kontieren"]', felder: { kontoId: '', betrag: 'kein-betrag', zahlungsziel: '' } },
  },
  { name: 'Aufsplitten', view: 'kontierung-aufsplitten', pfad: '/kontierung/{anna}/aufsplitten', als: 'test-1', pdf: true },
  {
    name: 'Aufsplitten im Modal', view: 'kontierung', pfad: '/kontierung/{anna}', als: 'test-1',
    modal: { knopf: '[data-bs-target="#aufsplitten-modal"]', modal: '#aufsplitten-modal', iframe: '#aufsplitten-frame' },
  },
  { name: 'KK-Abgleich', view: 'kk-abgleich', pfad: '/kontierung/{kkAbrechnung}/kk-abgleich', als: 'test-1', pdf: true },
  { name: 'Freigabe 2', view: 'freigabe2', pfad: '/freigabe2/{freigabe2}', als: 'test-2', pdf: true },
  { name: 'Spesen-Freigabe 1', view: 'spesen-freigabe1', pfad: '/spesen-freigabe1/{spesen}', als: 'test-1', pdf: true },
  { name: 'Abgelehnt', view: 'abgelehnt', pfad: '/abgelehnt/{abgelehnt}', als: 'test-1' },
  {
    name: 'Kommentar mit Fehler', view: 'kommentar-fehler', pfad: '/kontierung/{anna}', als: 'test-1', status: 422,
    fehlerzustand: { formular: '.kommentar-form', felder: { text: LANGER_KOMMENTAR } },
  },
  { name: 'Spesen einreichen', view: 'spesen-neu', pfad: '/spesen/neu', als: 'test-3' },
  { name: 'Spesen einreichen mit Fehlern', view: 'spesen-neu', pfad: '/spesen/neu', als: 'test-3', status: 400, fehlerzustand: { formular: 'form[action="/spesen"]' } },
  { name: 'Meine Spesen', view: 'meine-spesen', pfad: '/meine-spesen', als: 'test-3' },
  { name: 'Meine Abgeschlossenen', view: 'meine-abgeschlossenen', pfad: '/meine-abgeschlossenen', als: 'test-1' },
  { name: 'Meine Benachrichtigungen', view: 'meine-benachrichtigungen', pfad: '/meine-benachrichtigungen' },
  { name: 'Kreditkarte', view: 'kreditkarte', pfad: '/kreditkarte' },
  { name: 'KK-Beleg bearbeiten', view: 'kreditkarte-beleg-bearbeiten', pfad: '/kreditkarte/belege/{kkBeleg}/bearbeiten' },
  { name: 'Ferienmodus', view: 'ferienmodus', pfad: '/ferienmodus' },
  { name: 'Datenschutz', view: 'datenschutz', pfad: '/datenschutz' },
  { name: 'Fehler melden', view: 'fehler-melden', pfad: '/fehler-melden' },
  { name: 'Zeitstempel prüfen', view: 'zeitstempel-pruefen', pfad: '/zeitstempel-pruefen' },
  { name: 'Zeitstempel prüfen (Job)', view: 'zeitstempel-pruefen', pfad: '/zeitstempel-pruefen?jobId={abgeschlossen}' },
  { name: 'Prüfbescheinigung', view: 'zeitstempel-zertifikat', pfad: '/zeitstempel-pruefen/zertifikat?jobId={abgeschlossen}' },
  { name: 'Audit prüfen', view: 'audit-pruefen', pfad: '/audit-pruefen' },
  { name: 'Audit prüfen mit Fehler', view: 'audit-pruefen', pfad: '/audit-pruefen?pruefnummer=falsch', status: 400 },
  { name: 'Test-Postfach', view: 'testmodus-postfach', pfad: '/testmodus/postfach' },
  { name: 'Fehlerseite 404', view: 'error', pfad: '/gibt-es-nicht', status: 404 },
  { name: 'Fehlerseite 403', view: 'error', pfad: '/admin/backup', status: 403 },

  // ---------- Admin ----------
  { name: 'Admin Übersicht', view: 'admin/dashboard', pfad: '/admin' },
  { name: 'Admin Vorgänge', view: 'admin/vorgaenge-liste', pfad: '/admin/vorgaenge' },
  { name: 'Admin Vorgänge Tabelle', view: 'admin/vorgaenge-liste', pfad: '/admin/vorgaenge?ansicht=tabelle' },
  { name: 'Admin Vorgang', view: 'admin/vorgang-detail', pfad: '/admin/vorgaenge/{anna}' },
  { name: 'Admin Abgelehnt', view: 'admin/abgelehnt-liste', pfad: '/admin/abgelehnt' },
  { name: 'Admin Abgelehnt löschen', view: 'admin/abgelehnt-loeschen', pfad: '/admin/abgelehnt/{abgelehnt}' },
  { name: 'Admin Altfälle', view: 'admin/altfaelle-liste', pfad: '/admin/altfaelle' },
  { name: 'Admin Altfall', view: 'admin/altfall-entscheiden', pfad: '/admin/altfaelle/{abgeschlossen}' },
  { name: 'Admin Audit-Log', view: 'admin/audit-log', pfad: '/admin/audit-log' },
  { name: 'Admin Konten', view: 'admin/konten-liste', pfad: '/admin/konten' },
  { name: 'Admin Konto neu', view: 'admin/konten-form', pfad: '/admin/konten/neu' },
  { name: 'Admin Konto bearbeiten', view: 'admin/konten-form', pfad: '/admin/konten/{konto}/bearbeiten' },
  { name: 'Admin Kreditoren', view: 'admin/kreditoren-liste', pfad: '/admin/kreditoren' },
  { name: 'Admin Kreditor bearbeiten', view: 'admin/kreditoren-form', pfad: '/admin/kreditoren/{langerKreditor}/bearbeiten' },
  { name: 'Admin Zuweisungsregel', view: 'admin/kreditoren-regel-form', pfad: '/admin/kreditoren/regeln/{regel}/bearbeiten' },
  { name: 'Admin Kreditkarten', view: 'admin/kreditkarten-liste', pfad: '/admin/kreditkarten' },
  { name: 'Admin Kreditkarte neu', view: 'admin/kreditkarten-form', pfad: '/admin/kreditkarten/neu' },
  { name: 'Admin Kreditkarte bearbeiten', view: 'admin/kreditkarten-form', pfad: '/admin/kreditkarten/{karte}/bearbeiten' },
  { name: 'Admin Personen', view: 'admin/personen-liste', pfad: '/admin/personen' },
  { name: 'Admin Eskalation', view: 'admin/eskalation-form', pfad: '/admin/eskalation' },
  { name: 'Admin Erscheinungsbild', view: 'admin/erscheinungsbild-form', pfad: '/admin/erscheinungsbild' },
  { name: 'Admin Ersteinrichtung', view: 'admin/ersteinrichtung', pfad: '/admin/ersteinrichtung' },
  { name: 'Admin Zeitstempel', view: 'admin/zeitstempel-form', pfad: '/admin/zeitstempel' },
  { name: 'Admin Module', view: 'admin/module-form', pfad: '/admin/module' },
  { name: 'Admin Mail-Einstellungen', view: 'admin/mail-einstellungen-form', pfad: '/admin/mail-einstellungen' },
  { name: 'Admin Mails', view: 'admin/mails', pfad: '/admin/mails' },
  { name: 'Admin Sync', view: 'admin/sync', pfad: '/admin/sync' },
  { name: 'Admin Geplante Jobs', view: 'admin/geplante-jobs', pfad: '/admin/geplante-jobs' },
  { name: 'Admin Dateiquarantäne', view: 'admin/datei-quarantaene', pfad: '/admin/dateiquarantaene' },
  { name: 'Admin Betrieb', view: 'admin/betrieb-uebersicht', pfad: '/admin/betrieb' },
  { name: 'Admin Betrieb Status', view: 'admin/betrieb-status', pfad: '/admin/betrieb/status' },
  { name: 'Admin Betrieb Person', view: 'admin/betrieb-person', pfad: '/admin/betrieb/personen/test-1' },
  { name: 'Admin Betrieb Fehler', view: 'admin/betrieb-fehler', pfad: '/admin/betrieb/fehler' },
  { name: 'Admin Betrieb Fehler Detail', view: 'admin/betrieb-fehler', pfad: '/admin/betrieb/fehler/{fehler}' },
  { name: 'Admin Betrieb Meldungen', view: 'admin/betrieb-meldungen', pfad: '/admin/betrieb/meldungen' },
  { name: 'Admin Betrieb Meldung', view: 'admin/betrieb-meldungen', pfad: '/admin/betrieb/meldungen/{meldung}' },
  { name: 'Admin Betrieb Banner', view: 'admin/betrieb-banner', pfad: '/admin/betrieb/banner' },
  { name: 'Admin Betrieb Banner bearbeiten', view: 'admin/betrieb-banner', pfad: '/admin/betrieb/banner/{banner}' },
  { name: 'Admin Betrieb Datenschutz', view: 'admin/betrieb-datenschutz', pfad: '/admin/betrieb/datenschutz' },
];

// Seiten-Views, die der Browsertest nicht besucht (je mit Grund). Gilt nur für die Test-Instanz:
// die Seiten verwenden trotzdem das gemeinsame Seitengerüst (layoutSweep prüft das statisch).
export const AUSGENOMMEN = [
  { view: 'admin/testmodus', grund: 'Nur in der echten App: die Test-Instanz montiert /admin/testmodus nicht (Steuerung des Testmodus).' },
  { view: 'admin/backup', grund: 'Nur in der echten App: im Testmodus ist /admin/backup gesperrt (403-Fehlerseite, siehe "Fehlerseite 403").' },
  { view: 'abgemeldet', grund: 'Nur in der echten App: /auth ist in der Test-Instanz nicht montiert (keine Anmeldung im Testmodus).' },
];

export const BREITEN = [
  { breite: 360, hoehe: 740, isMobile: true, hasTouch: true, art: 'Handy' },
  { breite: 768, hoehe: 1024, isMobile: false, hasTouch: true, art: 'Tablet hoch' },
  { breite: 1024, hoehe: 768, isMobile: false, hasTouch: true, art: 'Tablet quer' },
  { breite: 1280, hoehe: 800, isMobile: false, hasTouch: false, art: 'Desktop' },
];
