import { listKreditkarten } from '../db/kreditkartenRepo.js';
import { bewerteAbsenderMuster } from '../db/jobsRepo.js';
import { findeEndziffern } from './kkTextAnalyse.js';

// Automatische Kartenerkennung beim n8n-Eingang (Etappe 2, Spec 6b): trifft genau eine aktive
// Karte per Absender (Absender-Muster der Karte) oder per im PDF-Text gefundenen Endziffern zu,
// wird diese Karte als Treffer zurückgegeben -- bei keinem oder mehr als einem Treffer null, damit
// der Aufrufer keine fachliche Entscheidung erzwingt (siehe kkMarkierung.js).
export function erkenneKarte(db, { absender, text }) {
  const karten = listKreditkarten(db);
  const treffer = new Map();
  for (const karte of karten) {
    if (karte.absender_muster && bewerteAbsenderMuster(absender, karte.absender_muster)) treffer.set(karte.id, { karte, grund: 'Absender' });
  }
  const ziffern = findeEndziffern(text);
  for (const karte of karten) {
    if (karte.karte_endziffern && ziffern.has(karte.karte_endziffern)) {
      const vorher = treffer.get(karte.id);
      treffer.set(karte.id, { karte, grund: vorher ? 'Absender + Endziffern' : 'Endziffern' });
    }
  }
  return treffer.size === 1 ? [...treffer.values()][0] : null;
}

// Ohne aktive Karte mit Absender-Muster oder Endziffern kann erkenneKarte nie treffen -- der
// Eingang spart sich dann die PDF-Textextraktion.
export function hatErkennbareKarten(db) {
  return listKreditkarten(db).some((karte) => karte.absender_muster || karte.karte_endziffern);
}
