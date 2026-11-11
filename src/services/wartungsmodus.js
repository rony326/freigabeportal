import { getConfigValue, setConfigValue } from '../db/adminConfigRepo.js';

const HINWEIS_MAX = 200;

// Zustand des Wartungsmodus (admin_config). Änderungen an admin_config protokolliert ein
// Datenbank-Trigger im Audit-Log (wer, wann, alter und neuer Wert, auch der Hinweistext).
export function istWartungsmodusAktiv(db) {
  return getConfigValue(db, 'wartungsmodus_aktiv') === '1';
}

export function wartungsHinweis(db) {
  return getConfigValue(db, 'wartungsmodus_hinweis') ?? '';
}

// Schreibt nur bei tatsächlicher Änderung, damit kein Rauschen im Audit-Log entsteht.
export function setzeWartungsmodus(db, aktiv, hinweis = '') {
  const neuerHinweis = aktiv ? String(hinweis ?? '').trim().slice(0, HINWEIS_MAX) : '';
  const neuerWert = aktiv ? '1' : '0';
  if (getConfigValue(db, 'wartungsmodus_aktiv') !== neuerWert) setConfigValue(db, 'wartungsmodus_aktiv', neuerWert);
  if ((getConfigValue(db, 'wartungsmodus_hinweis') ?? '') !== neuerHinweis) setConfigValue(db, 'wartungsmodus_hinweis', neuerHinweis);
}
