// Wartungsmodus-Zustand (admin_config); die Sperre selbst steckt in middleware/wartungsmodus.js. Während er aktiv ist, versenden weder die
// Mailzustellung noch die Sicherheitsalarme, und die geplanten Jobs pausieren (ausser der Sicherung).

import { getConfigValue, setConfigValue } from '../db/adminConfigRepo.js';

const HINWEIS_MAX = 200;

// Zustand des Wartungsmodus (admin_config). Änderungen an admin_config protokolliert ein
// Datenbank-Trigger im Audit-Log (wer, wann, alter und neuer Wert, auch der Hinweistext).
// true, wenn der Wartungsmodus eingeschaltet ist.
export function istWartungsmodusAktiv(db) {
  return getConfigValue(db, 'wartungsmodus_aktiv') === '1';
}

// Hinweistext auf der Wartungsseite (höchstens 200 Zeichen).
export function wartungsHinweis(db) {
  return getConfigValue(db, 'wartungsmodus_hinweis') ?? '';
}

// Schreibt nur bei tatsächlicher Änderung, damit kein Rauschen im Audit-Log entsteht.
// Schaltet den Modus ein/aus und setzt Hinweis und Startzeit.
export function setzeWartungsmodus(db, aktiv, hinweis = '') {
  const neuerHinweis = aktiv ? String(hinweis ?? '').trim().slice(0, HINWEIS_MAX) : '';
  const neuerWert = aktiv ? '1' : '0';
  if (getConfigValue(db, 'wartungsmodus_aktiv') !== neuerWert) {
    setConfigValue(db, 'wartungsmodus_aktiv', neuerWert);
    setConfigValue(db, 'wartungsmodus_seit', aktiv ? new Date().toISOString() : '');
  }
  if ((getConfigValue(db, 'wartungsmodus_hinweis') ?? '') !== neuerHinweis) setConfigValue(db, 'wartungsmodus_hinweis', neuerHinweis);
}

// Ab dieser Dauer weist das Banner die Berechtigten darauf hin, dass der Modus vielleicht vergessen
// wurde: im Wartungsmodus gehen auch Sicherheitsalarme nicht raus.
export const WARTUNG_LANG_STUNDEN = 4;

export function wartungsmodusLaeuftLange(db, jetzt = Date.now()) {
  const seit = Date.parse(getConfigValue(db, 'wartungsmodus_seit') || '');
  return Number.isFinite(seit) && jetzt - seit > WARTUNG_LANG_STUNDEN * 3600 * 1000;
}
