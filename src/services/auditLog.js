import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';

const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1 erteilt',
  freigeber2: 'Freigabe 2 erteilt',
  ablehnung: 'Abgelehnt',
};

function personName(db, personId) {
  const person = getPersonById(db, personId);
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// The freigaben table is the system's only per-action record (who, when, from which IP) — it
// already exists for the Vier-Augen-Prinzip lookups in kontierung.js/freigabe2.js/ablehnung.js.
// This turns those same rows into the human-readable timeline shown under the Freigabe section
// on every Rechnung, without every route re-implementing person-name lookups and event labels.
export function buildAuditLog(db, jobId) {
  return listFreigabenByJob(db, jobId).map((eintrag) => ({
    zeitpunkt: eintrag.zeitpunkt,
    ereignis: EREIGNIS_LABEL[eintrag.rolle] || eintrag.rolle,
    person: personName(db, eintrag.person_id),
    interessenskonflikt: Boolean(eintrag.interessenskonflikt),
    kommentar: eintrag.kommentar,
    eskaliertVonPerson: eintrag.eskaliert_von ? personName(db, eintrag.eskaliert_von) : null,
  }));
}
