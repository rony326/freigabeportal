// Navigationsdaten für die Seitenleiste (reine Funktionen, keine Abhängigkeiten).

export function bereichFuerPfad(pfad) {
  return pfad === '/admin' || pfad.startsWith('/admin/') ? 'admin' : 'portal';
}

export function istAktiv(pfad, href) {
  return pfad === href || pfad.startsWith(href + '/');
}

// Alle Symbolnamen (Bootstrap Icons 1.13.2); scripts/baueSymbole.js baut daraus das Sprite.
// Navigationspunkte tragen ihren Namen in `symbol`, die übrigen stehen hier unter "Sonstige".
export const SYMBOLE = [
  'inbox', 'plus-circle', 'wallet2', 'check2-circle', 'credit-card', 'bell', 'sun', 'patch-check', 'bug', 'shield-lock',
  'activity', 'x-circle', 'hourglass-split', 'journal-text', 'building', 'credit-card-2-front', 'people', 'alarm',
  'envelope-at', 'palette', 'grid-3x3-gap', 'clock-history', 'list-check', 'database', 'shield-exclamation',
  'envelope-paper', 'arrow-repeat', 'calendar-check', 'card-list', 'speedometer2', 'cone-striped', 'piggy-bank',
  'bar-chart-line',
  // Sonstige: Menü, Farbmodus, Neu laden, Tabelle, Kacheln, Empfänger-Kärtchen (Person)
  'list', 'circle-half', 'arrow-clockwise', 'table', 'grid', 'person',
];

// flag: Schlüssel in adminNav bzw. Portal-Option (null = immer sichtbar)
const PORTAL = [
  { titel: 'Arbeit', punkte: [
    { label: 'Aufgaben', href: '/pool', symbol: 'inbox', flag: null },
    { label: 'Auswertung', href: '/auswertung', symbol: 'bar-chart-line', flag: 'auswertungSichtbar' },
  ] },
  { titel: 'Spesen', punkte: [
    { label: 'Spesen einreichen', href: '/spesen/neu', symbol: 'plus-circle', flag: 'spesenModulAktiv' },
    { label: 'Meine Spesen', href: '/meine-spesen', symbol: 'wallet2', flag: null },
  ] },
  { titel: 'Belege', punkte: [
    { label: 'Abgeschlossene Rechnungen', href: '/meine-abgeschlossenen', symbol: 'check2-circle', flag: null },
    { label: 'Kreditkartenbelege', href: '/kreditkarte', symbol: 'credit-card', flag: 'zeigeKreditkarteNav' },
  ] },
  { titel: 'Persönlich', punkte: [
    // trennung: Label mit weichem Trennstrich (\u00AD) an der richtigen Stelle, falls es in der
    // 210-px-Leiste umbrechen muss (fett beim aktiven Punkt). Nur für die Anzeige.
    { label: 'Benachrichtigungen', trennung: 'Benachrich\u00ADtigungen', href: '/meine-benachrichtigungen', symbol: 'bell', flag: null },
    { label: 'Ferienmodus', href: '/ferienmodus', symbol: 'sun', flag: null },
    { label: 'Zeitstempel prüfen', href: '/zeitstempel-pruefen', symbol: 'patch-check', flag: null },
    { label: 'Problem melden', href: '/fehler-melden', symbol: 'bug', flag: null },
    { label: 'Datenschutz', href: '/datenschutz', symbol: 'shield-lock', flag: null },
  ] },
];

const ADMIN = [
  { titel: 'Vorgänge', punkte: [
    { label: 'Laufende Vorgänge', href: '/admin/vorgaenge', symbol: 'activity', flag: 'vorgaenge' },
    { label: 'Abgelehnte Rechnungen', href: '/admin/abgelehnt', symbol: 'x-circle', flag: 'abgelehnt' },
    { label: 'Altfälle', href: '/admin/altfaelle', symbol: 'hourglass-split', flag: 'altfaelle' },
  ] },
  { titel: 'Stammdaten', punkte: [
    { label: 'Konten', href: '/admin/konten', symbol: 'journal-text', flag: 'konten' },
    { label: 'Kreditoren', href: '/admin/kreditoren', symbol: 'building', flag: 'kreditoren' },
    { label: 'Kreditkarten', href: '/admin/kreditkarten', symbol: 'credit-card-2-front', flag: 'kreditkarten' },
    { label: 'Budgets', href: '/admin/budgets', symbol: 'piggy-bank', flag: 'budgets' },
    { label: 'Personen', href: '/admin/personen', symbol: 'people', flag: 'personen' },
  ] },
  { titel: 'Einstellungen', punkte: [
    { label: 'Benachrichtigungen', href: '/admin/benachrichtigungen', symbol: 'envelope-at', flag: 'benachrichtigungen' },
    { label: 'Erscheinungsbild', href: '/admin/erscheinungsbild', symbol: 'palette', flag: 'erscheinungsbild' },
    { label: 'Module', href: '/admin/module', symbol: 'grid-3x3-gap', flag: 'module' },
    { label: 'Zeitstempel', href: '/admin/zeitstempel', symbol: 'clock-history', flag: 'zeitstempel' },
    { label: 'Ersteinrichtung', href: '/admin/ersteinrichtung', symbol: 'list-check', flag: 'ersteinrichtung' },
  ] },
  { titel: 'Betrieb', punkte: [
    { label: 'Datenbank-Backup', href: '/admin/backup', symbol: 'database', flag: 'backup' },
    { label: 'Datei-Quarantäne', href: '/admin/dateiquarantaene', symbol: 'shield-exclamation', flag: 'backup' },
    { label: 'Mail-Protokoll', href: '/admin/mails', symbol: 'envelope-paper', flag: 'mails' },
    { label: 'Sync-Übersicht', href: '/admin/sync', symbol: 'arrow-repeat', flag: 'sync' },
    { label: 'Geplante Jobs', href: '/admin/geplante-jobs', symbol: 'calendar-check', flag: 'geplanteJobs' },
    { label: 'Audit-Log', href: '/admin/audit-log', symbol: 'card-list', flag: 'auditLog' },
    { label: 'Betrieb & Nutzung', href: '/admin/betrieb', symbol: 'speedometer2', flag: 'betrieb' },
    { label: 'Testmodus', href: '/admin/testmodus', symbol: 'cone-striped', flag: 'testmodus' },
  ] },
];

function baue(definition, pfad, sichtbar, zaehlerFuer = () => undefined) {
  return definition
    .map((g) => ({
      titel: g.titel,
      punkte: g.punkte
        .filter((p) => p.flag === null || sichtbar(p.flag))
        .map((p) => {
          const punkt = { label: p.label, href: p.href, aktiv: istAktiv(pfad, p.href), symbol: p.symbol };
          if (p.trennung) punkt.trennung = p.trennung;
          const z = zaehlerFuer(p);
          if (z !== undefined) punkt.zaehler = z;
          return punkt;
        }),
    }))
    .filter((g) => g.punkte.length > 0);
}

export function bauePortalGruppen({ pfad, spesenModulAktiv, zeigeKreditkarteNav, offeneAufgaben, auswertungSichtbar = false }) {
  const optionen = { spesenModulAktiv, zeigeKreditkarteNav, auswertungSichtbar };
  return baue(
    PORTAL,
    pfad,
    (flag) => Boolean(optionen[flag]),
    (p) => (p.href === '/pool' && offeneAufgaben > 0 ? offeneAufgaben : undefined),
  );
}

export function baueAdminGruppen({ pfad, adminNav }) {
  return baue(ADMIN, pfad, (flag) => Boolean(adminNav?.[flag]));
}
