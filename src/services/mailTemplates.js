// Mail-Vorlagen: Auswahl der Vorlage je Mailtyp und Ersetzen der `%platzhalter%`. Die Vorlagen liegen in `admin_config`
// und sind unter Admin → Benachrichtigungen bearbeitbar (docs/admin-bereich.md).

import { getConfigValue } from '../db/adminConfigRepo.js';

// Mailtyp (mail_log.typ) → Schlüsselteil der Vorlagen in admin_config (`mail_vorlage_<infix>_betreff|_text`). Neuer Mailtyp: hier eintragen,
// Standardtexte in db/adminConfigRepo.js DEFAULTS ergänzen und den mail_log-CHECK in db/index.js erweitern.
export const TYP_ZU_KEY_INFIX = {
  zuweisung: 'zuweisung',
  reminder: 'reminder',
  eskalation: 'eskalation',
  ablehnung: 'ablehnung',
  'sync-fehler': 'sync_fehler',
  'auffaelligkeiten-warnung': 'auffaelligkeiten_warnung',
  'rechnungsnummer-warnung': 'rechnungsnummer_warnung',
  digest: 'digest',
  'freigabe2-reminder': 'freigabe2_reminder',
  'freigabe2-eskalation': 'freigabe2_eskalation',
  'kk-abrechnung-zugewiesen': 'kk_abrechnung_zugewiesen',
  'kk-beleg-erinnerung': 'kk_beleg_erinnerung',
  'kk-beleg-eingegangen': 'kk_beleg_eingegangen',
  'admin-umzuweisung': 'admin_umzuweisung',
  'duplikat-warnung': 'duplikat_warnung',
  'audit-pruefnummer': 'audit_pruefnummer',
  'neues-geraet': 'neues_geraet',
  fehlermeldung: 'fehlermeldung',
  kommentar: 'kommentar',
  'rapport-zuweisung': 'rapport_zuweisung',
  'rapport-reminder': 'rapport_reminder',
  'rapport-eskalation': 'rapport_eskalation',
};

// Ersetzt jedes `%name%` durch den Wert aus `variablen`; unbekannte Platzhalter bleiben unverändert stehen.
export function renderTemplate(vorlage, variablen) {
  return vorlage.replace(/%([a-zA-Z0-9_]+)%/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variablen, key) ? String(variablen[key]) : match
  );
}

// @returns {{betreff: string|null, text: string|null}} die gespeicherte Vorlage zum Mailtyp; wirft bei unbekanntem Typ
export function getVorlage(db, typ) {
  const infix = TYP_ZU_KEY_INFIX[typ];
  if (!infix) {
    throw new Error(`Unbekannter Mail-Vorlagen-Typ: ${typ}`);
  }
  return {
    betreff: getConfigValue(db, `mail_vorlage_${infix}_betreff`),
    text: getConfigValue(db, `mail_vorlage_${infix}_text`),
  };
}
