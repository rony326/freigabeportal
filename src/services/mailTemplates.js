import { getConfigValue } from '../db/adminConfigRepo.js';

const TYP_ZU_KEY_INFIX = {
  zuweisung: 'zuweisung',
  reminder: 'reminder',
  eskalation: 'eskalation',
  ablehnung: 'ablehnung',
  'sync-fehler': 'sync_fehler',
  'iban-warnung': 'iban_warnung',
  'rechnungsnummer-warnung': 'rechnungsnummer_warnung',
  digest: 'digest',
  'freigabe2-reminder': 'freigabe2_reminder',
  'freigabe2-eskalation': 'freigabe2_eskalation',
};

export function renderTemplate(vorlage, variablen) {
  return vorlage.replace(/%([a-zA-Z0-9_]+)%/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variablen, key) ? String(variablen[key]) : match
  );
}

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
