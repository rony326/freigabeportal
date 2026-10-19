import { getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';

export const LAUFENDE_STATUS = ['unzugewiesen', 'zugewiesen', 'freigabe2', 'abgelehnt'];

// Wer muss bei diesem Job jetzt handeln? Spiegelt die Autorisierung der Workflow-Seiten
// (kontierungZugriff.js, ablehnung.js, freigabe2.js), ohne Ferienvertretung -- die kommt additiv
// dazu und ändert die Zuständigkeit nicht.
export function ermittleZustaendigkeit(db, job) {
  if (job.status === 'unzugewiesen') return { art: 'pool', personId: null };
  if (job.status === 'zugewiesen' || job.status === 'abgelehnt') {
    if (job.freigabe1_eskaliert_an_admin) return { art: 'admin', personId: null };
    return { art: 'person', personId: job.zugewiesen_an ?? null };
  }
  if (job.status === 'freigabe2') {
    if (job.freigabe2_eskaliert_an_admin) return { art: 'admin', personId: null };
    const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
    return { art: 'person', personId: konto ? getEffectiveFreigeber2Id(job, konto) : null };
  }
  return { art: 'keine', personId: null };
}

// Kompakter Fingerabdruck des Stands, den der Admin im Formular gesehen hat. Ändert sich Status
// oder zuständige Person bis zum Absenden, passt der Token nicht mehr.
export function standToken(job, zustaendigkeit) {
  return `${job.status}|${zustaendigkeit.art}|${zustaendigkeit.personId ?? ''}`;
}
