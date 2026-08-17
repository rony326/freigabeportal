import { getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { personHasRole } from '../middleware/roles.js';

// Mirrors the per-page authorization each job-detail route already enforces (loadAuthorizedJob
// in kontierung.js/ablehnung.js, loadAuthorized in freigabe2.js, the Pool gate in poolPage.js) —
// used to decide whether a given session may see a job's PDF/thumbnail (preview refresh,
// thumbnail image), not as a replacement for those routes' own checks.
export function canViewJobPdf(db, config, currentPerson, job) {
  if (personHasRole(currentPerson, config, 'portal-admin')) return true;
  if (job.status === 'unzugewiesen') return personHasRole(currentPerson, config, 'buchhaltung');
  const personId = currentPerson.churchtools_person_id;
  if (job.zugewiesen_an === personId) return true;
  if (job.konto_id) {
    const konto = getKontoById(db, job.konto_id);
    if (konto && getEffectiveFreigeber2Id(job, konto) === personId) return true;
  }
  return false;
}
