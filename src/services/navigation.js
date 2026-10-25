// Navigationsdaten für die Seitenleiste (reine Funktionen, keine Abhängigkeiten).

export function bereichFuerPfad(pfad) {
  return pfad === '/admin' || pfad.startsWith('/admin/') ? 'admin' : 'portal';
}

export function istAktiv(pfad, href) {
  return pfad === href || pfad.startsWith(href + '/');
}

// flag: Schlüssel in adminNav bzw. Portal-Option (null = immer sichtbar)
const PORTAL = [
  { titel: 'Arbeit', punkte: [
    { label: 'Aufgaben', href: '/pool', symbol: '☰', flag: null },
  ] },
  { titel: 'Spesen', punkte: [
    { label: 'Spesen einreichen', href: '/spesen/neu', symbol: '＋', flag: 'spesenModulAktiv' },
    { label: 'Meine Spesen', href: '/meine-spesen', symbol: '€', flag: null },
  ] },
  { titel: 'Belege', punkte: [
    { label: 'Abgeschlossene Rechnungen', href: '/meine-abgeschlossenen', symbol: '✓', flag: null },
    { label: 'Kreditkartenbelege', href: '/kreditkarte', symbol: '▭', flag: 'zeigeKreditkarteNav' },
  ] },
  { titel: 'Persönlich', punkte: [
    { label: 'Ferienmodus', href: '/ferienmodus', symbol: '☼', flag: null },
    { label: 'Zeitstempel prüfen', href: '/zeitstempel-pruefen', symbol: '⏱', flag: null },
    { label: 'Problem melden', href: '/fehler-melden', symbol: '!', flag: null },
    { label: 'Datenschutz', href: '/datenschutz', symbol: '§', flag: null },
  ] },
];

const ADMIN = [
  { titel: 'Vorgänge', punkte: [
    { label: 'Laufende Vorgänge', href: '/admin/vorgaenge', symbol: '▶', flag: 'vorgaenge' },
    { label: 'Abgelehnte Rechnungen', href: '/admin/abgelehnt', symbol: '✗', flag: 'abgelehnt' },
    { label: 'Altfälle', href: '/admin/altfaelle', symbol: '⌛', flag: 'altfaelle' },
  ] },
  { titel: 'Stammdaten', punkte: [
    { label: 'Konten', href: '/admin/konten', symbol: '#', flag: 'konten' },
    { label: 'Kreditoren', href: '/admin/kreditoren', symbol: '⌂', flag: 'kreditoren' },
    { label: 'Kreditkarten', href: '/admin/kreditkarten', symbol: '▭', flag: 'kreditkarten' },
    { label: 'Personen', href: '/admin/personen', symbol: '☺', flag: 'personen' },
  ] },
  { titel: 'Einstellungen', punkte: [
    { label: 'Eskalationszeiten', href: '/admin/eskalation', symbol: '⏰', flag: 'eskalation' },
    { label: 'Mail-Einstellungen', href: '/admin/mail-einstellungen', symbol: '✉', flag: 'mailEinstellungen' },
    { label: 'Erscheinungsbild', href: '/admin/erscheinungsbild', symbol: '◐', flag: 'erscheinungsbild' },
    { label: 'Module', href: '/admin/module', symbol: '❖', flag: 'module' },
    { label: 'Zeitstempel', href: '/admin/zeitstempel', symbol: '⏱', flag: 'zeitstempel' },
    { label: 'Ersteinrichtung', href: '/admin/ersteinrichtung', symbol: '✔', flag: 'ersteinrichtung' },
  ] },
  { titel: 'Betrieb', punkte: [
    { label: 'Datenbank-Backup', href: '/admin/backup', symbol: '⛁', flag: 'backup' },
    { label: 'Datei-Quarantäne', href: '/admin/dateiquarantaene', symbol: '⚠', flag: 'backup' },
    { label: 'Mail-Protokoll', href: '/admin/mails', symbol: '✉', flag: 'mails' },
    { label: 'Sync-Übersicht', href: '/admin/sync', symbol: '⟳', flag: 'sync' },
    { label: 'Geplante Jobs', href: '/admin/geplante-jobs', symbol: '⚙', flag: 'geplanteJobs' },
    { label: 'Audit-Log', href: '/admin/audit-log', symbol: '☷', flag: 'auditLog' },
    { label: 'Betrieb & Nutzung', href: '/admin/betrieb', symbol: '◔', flag: 'betrieb' },
    { label: 'Testmodus', href: '/admin/testmodus', symbol: '⚗', flag: 'testmodus' },
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
          const z = zaehlerFuer(p);
          if (z !== undefined) punkt.zaehler = z;
          return punkt;
        }),
    }))
    .filter((g) => g.punkte.length > 0);
}

export function bauePortalGruppen({ pfad, spesenModulAktiv, zeigeKreditkarteNav, offeneAufgaben }) {
  const optionen = { spesenModulAktiv, zeigeKreditkarteNav };
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
