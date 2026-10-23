import { listFreigabenByJob, listKonfliktmelder } from '../db/freigabenRepo.js';

// Prüft, ob eine Stellvertretung als Eskalationsziel überhaupt freigeben dürfte. Wenn nicht, muss
// die Eskalation direkt an die Admin-Gruppe gehen — sonst landet der Vorgang bei einer Person, die
// ihn wegen der Sperren in kontierungZugriff.js/freigabe2.js/spesenFreigabe1.js nicht bearbeiten
// kann (Sackgasse, bisher nur per Admin-Umhängen lösbar).
// Liefert den Grund als kurzen Text oder null, wenn das Ziel in Ordnung ist.
export function ausschlussGrundFuerEskalationsziel(db, job, { stufe, zielId, meldenderId }) {
  if (!zielId) return 'keine Stellvertretung hinterlegt';
  if (zielId === meldenderId) return 'ist selbst die meldende Person';
  // Aus freigaben gelesen, nicht nur aus *_eskaliert_von: Umhängen und Pool-Rückgabe setzen diese
  // Spalten zurück, der erklärte Konflikt gehört aber weiterhin zur Rechnung.
  if (listKonfliktmelder(db, job.id, stufe).has(zielId)) return 'hat bereits einen Interessenskonflikt erklärt';
  if (stufe === 2) {
    const freigabe1 = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'freigeber1');
    if (freigabe1 && freigabe1.person_id === zielId) return 'hat bereits Freigabe 1 erteilt';
  }
  if (job.quelle === 'spesen' && job.eingereicht_von === zielId) return 'hat die Spesen selbst eingereicht';
  return null;
}

// Text für die Admin-Mail: bisher hiess es pauschal, auch die Stellvertretung habe einen Konflikt
// erklärt — bei einer ausgeschlossenen Stellvertretung stimmt das nicht.
export function adminEskalationsText(objekt, ausschlussGrund) {
  return ausschlussGrund
    ? `${objekt} wurde nach einem Interessenskonflikt an die Portal-Admin-Gruppe eskaliert, da die Stellvertretung ausgeschlossen ist (${ausschlussGrund}).`
    : `${objekt} wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.`;
}

export function grundMitAusschluss(grund, ausschlussGrund) {
  return ausschlussGrund ? `${grund} — Stellvertretung ausgeschlossen (${ausschlussGrund})` : grund;
}
