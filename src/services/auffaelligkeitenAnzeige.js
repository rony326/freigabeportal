// Aufbereitung der bestätigten Auffälligkeiten für die Anzeige (Freigabe 2, Kontierung, Admin-Vorgang).
// Zeigt immer die jüngste Bestätigung des Jobs; null, wenn es keine gibt.
import { letzteBestaetigung } from '../db/auffaelligkeitenRepo.js';
import { personName, zeitpunktAnzeige } from './auditLog.js';

// @returns {{befunde: object[], vonName: string, zeitpunkt: string, bemerkung: string|null}|null}
export function auffaelligkeitenKasten(db, jobId) {
  const zeile = letzteBestaetigung(db, jobId);
  if (!zeile || zeile.befunde.length === 0) return null;
  return {
    befunde: zeile.befunde,
    vonName: personName(db, zeile.person_id),
    // zeitpunktAnzeige liefert "TT.MM.JJJJ HH:MM" in Ortszeit; im Kasten steht ein Komma dazwischen.
    zeitpunkt: zeitpunktAnzeige(zeile.zeitpunkt).replace(' ', ', '),
    bemerkung: zeile.bemerkung || null,
  };
}
