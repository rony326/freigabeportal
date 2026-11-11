// Zentraler Rechtekatalog: einzige Stelle, die alle Admin-Rechte, ihre Labels, ihre Gruppierung
// und die Startwerte pro Gruppe kennt. Reine Konstanten, keine Abhängigkeiten.

export const GRUPPEN = ['superadmin', 'manager', 'buchhaltung'];

// Vergebbar: pro Gruppe (gruppen_berechtigungen) und pro Person (person_berechtigungen).
export const GRANTABLE_BERECHTIGUNGEN = [
  'konten_verwalten',
  'kreditoren_verwalten',
  'geplante_jobs_verwalten',
  'abgelehnt_verwalten',
  'mails_einsehen',
  'sync_einsehen',
  'audit_log_einsehen',
  'pool_zuweisen',
  'kreditkarten_verwalten',
  'sync_verwalten',
  'workflow_eingreifen',
  'vorgaenge_einsehen',
  'betrieb_einsehen',
  'auswertung_einsehen',
  'budgets_verwalten',
  'personen_einsehen',
  'testmodus_nutzen',
  'benachrichtigungen_verwalten',
  'erscheinungsbild_verwalten',
  'ersteinrichtung_verwalten',
  'zeitstempel_verwalten',
  'backup_verwalten',
  'module_verwalten',
  'dateiquarantaene_verwalten',
  'wartungsmodus_schalten',
];

// Nur für Superadmin, fest gesetzt (Schutz vor Aussperren): nicht abschaltbar, nicht vergebbar.
export const FESTE_RECHTE = ['gruppenrechte_verwalten'];

export const BERECHTIGUNG_LABELS = {
  konten_verwalten: 'Konten verwalten',
  kreditoren_verwalten: 'Kreditoren verwalten',
  geplante_jobs_verwalten: 'Geplante Jobs verwalten',
  abgelehnt_verwalten: 'Abgelehnte Rechnungen verwalten',
  mails_einsehen: 'Mail-Protokoll einsehen',
  sync_einsehen: 'Sync-Übersicht einsehen',
  audit_log_einsehen: 'Globales Audit-Log einsehen',
  pool_zuweisen: 'Pool-Belege an Personen zuweisen',
  kreditkarten_verwalten: 'Kreditkarten verwalten',
  sync_verwalten: 'Sync konfigurieren',
  workflow_eingreifen: 'In laufende Vorgänge eingreifen',
  vorgaenge_einsehen: 'Laufende Vorgänge einsehen',
  betrieb_einsehen: 'Betrieb & Nutzung',
  auswertung_einsehen: 'Auswertung einsehen (alle Konten)',
  budgets_verwalten: 'Budgets verwalten',
  personen_einsehen: 'Personen einsehen',
  testmodus_nutzen: 'Testmodus nutzen',
  benachrichtigungen_verwalten: 'Benachrichtigungen verwalten',
  erscheinungsbild_verwalten: 'Erscheinungsbild verwalten',
  ersteinrichtung_verwalten: 'Ersteinrichtung verwalten',
  zeitstempel_verwalten: 'Zeitstempel verwalten',
  backup_verwalten: 'Datenbank-Backup verwalten',
  module_verwalten: 'Module verwalten',
  dateiquarantaene_verwalten: 'Datei-Quarantäne verwalten',
  wartungsmodus_schalten: 'Wartungsmodus schalten',
  gruppenrechte_verwalten: 'Gruppenrechte verwalten',
};

// Gruppierung für die Matrix, angelehnt an die Navigation des Admin-Bereichs.
export const BERECHTIGUNG_BEREICHE = [
  { titel: 'Vorgänge', rechte: ['vorgaenge_einsehen', 'workflow_eingreifen', 'abgelehnt_verwalten', 'pool_zuweisen', 'auswertung_einsehen'] },
  { titel: 'Stammdaten', rechte: ['konten_verwalten', 'kreditoren_verwalten', 'kreditkarten_verwalten', 'budgets_verwalten', 'personen_einsehen'] },
  { titel: 'Einstellungen', rechte: ['benachrichtigungen_verwalten', 'erscheinungsbild_verwalten', 'module_verwalten', 'zeitstempel_verwalten', 'ersteinrichtung_verwalten', 'gruppenrechte_verwalten'] },
  { titel: 'Betrieb', rechte: ['backup_verwalten', 'dateiquarantaene_verwalten', 'mails_einsehen', 'sync_einsehen', 'sync_verwalten', 'geplante_jobs_verwalten', 'audit_log_einsehen', 'betrieb_einsehen', 'testmodus_nutzen', 'wartungsmodus_schalten'] },
];

// Rechte, die der Manager bisher nicht (über das feste Bündel) hatte, plus die neuen, die nur
// Superadmin bekommen.
const NICHT_FUER_MANAGER = [
  'sync_verwalten', 'workflow_eingreifen', 'betrieb_einsehen',
  'benachrichtigungen_verwalten', 'erscheinungsbild_verwalten', 'ersteinrichtung_verwalten', 'zeitstempel_verwalten',
  'backup_verwalten', 'module_verwalten', 'dateiquarantaene_verwalten', 'wartungsmodus_schalten',
];

// Startwerte der Migration = Verhalten vor der Einführung der Gruppenrechte.
export function startwerteFuerGruppe(gruppe) {
  if (gruppe === 'superadmin') return [...GRANTABLE_BERECHTIGUNGEN, ...FESTE_RECHTE];
  if (gruppe === 'manager') return GRANTABLE_BERECHTIGUNGEN.filter((recht) => !NICHT_FUER_MANAGER.includes(recht));
  return [];
}
