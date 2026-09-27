import { getKreditkarteById, listKreditkarten, listErfasserIds } from '../db/kreditkartenRepo.js';
import { getJobById } from '../db/jobsRepo.js';
import { personHasRole } from '../middleware/roles.js';
import { canViewJobPdf } from './jobAuthorization.js';
import { istAktiveVertretungFuer } from './vertretung.js';

// Zentrale Rechte-Regeln für Kreditkarten-Belege (Spec Abschnitt 7) -- Routen fragen nur hier
// nach, statt die Regeln je Seite nachzubauen.

export function darfAufKarteErfassen(db, karte, personId) {
  if (!karte || !karte.aktiv) return false;
  if (karte.erfassung_offen) return true;
  if (karte.verantwortlich_id === personId) return true;
  return listErfasserIds(db, karte.id).includes(personId);
}

export function listErfassbareKarten(db, personId) {
  return listKreditkarten(db).filter((karte) => darfAufKarteErfassen(db, karte, personId));
}

export function darfBelegBearbeiten(db, beleg, personId) {
  if (!beleg || !['offen', 'entwurf'].includes(beleg.status)) return false;
  if (beleg.hochgeladen_von === personId || beleg.gekauft_von === personId) return true;
  const karte = beleg.kreditkarte_id ? getKreditkarteById(db, beleg.kreditkarte_id) : null;
  return Boolean(karte && karte.verantwortlich_id === personId);
}

export function darfBelegSehen(db, config, beleg, person) {
  if (!beleg || !person) return false;
  const personId = person.churchtools_person_id;
  if (personHasRole(person, config, 'superadmin')) return true;
  if (beleg.hochgeladen_von === personId || beleg.gekauft_von === personId) return true;
  const karte = beleg.kreditkarte_id ? getKreditkarteById(db, beleg.kreditkarte_id) : null;
  if (karte && karte.verantwortlich_id === personId) return true;
  // Wer gerade eine markierte Abrechnung dieser Karte abgleicht (auch als Ferienmodus-Vertretung),
  // muss die angebotenen offenen Belege ansehen können.
  if (beleg.status === 'offen' && karte) {
    const rows = db.prepare("SELECT zugewiesen_an FROM jobs WHERE kreditkarte_id = ? AND status = 'zugewiesen'").all(karte.id);
    if (rows.some((r) => r.zugewiesen_an === personId || istAktiveVertretungFuer(db, personId, r.zugewiesen_an))) return true;
  }
  // Nach der Zuordnung ist der Beleg Teil eines normalen Jobs -- wer den sehen darf, darf auch das Original sehen.
  if (beleg.zugeordnet_job_id) {
    const job = getJobById(db, beleg.zugeordnet_job_id);
    if (job && canViewJobPdf(db, config, person, job)) return true;
  }
  return false;
}

export function zeigeKreditkartenBereich(db, personId) {
  if (listErfassbareKarten(db, personId).length > 0) return true;
  if (db.prepare('SELECT 1 FROM kreditkarten WHERE verantwortlich_id = ? LIMIT 1').get(personId)) return true;
  return Boolean(db.prepare('SELECT 1 FROM kk_belege WHERE hochgeladen_von = ? OR gekauft_von = ? LIMIT 1').get(personId, personId));
}
