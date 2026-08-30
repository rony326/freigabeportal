import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

export const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1 erteilt',
  freigeber2: 'Freigabe 2 erteilt',
  ablehnung: 'Abgelehnt',
  freigabe1_eskalation: 'Freigabe 1: Interessenskonflikt gemeldet',
  freigabe2_eskalation: 'Freigabe 2: Interessenskonflikt gemeldet',
  iban_abweichung: 'IBAN-Abweichung festgestellt',
  loeschung: 'Job gelöscht',
};

// Swiss org, hardcoded rather than derived from the server's OS timezone — Infomaniak's hosting
// runs in UTC, and "lokale Zeit" here always means Europe/Zurich regardless of where the process
// happens to run.
const LOKALE_ZEITZONE = 'Europe/Zurich';

export function personName(db, personId) {
  const person = getPersonById(db, personId);
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// zeitpunkt is always stored as a UTC ISO string (see freigabenRepo.js) — this only affects how
// it's displayed. Formatted manually via formatToParts rather than a locale string so the output
// (DD.MM.YYYY HH:MM) is deterministic and doesn't depend on the Intl locale data installed on
// whatever machine renders the page.
export function formatZeitpunkt(iso, lokaleZeit) {
  if (!lokaleZeit) return iso;
  const teile = new Intl.DateTimeFormat('de-CH', {
    timeZone: LOKALE_ZEITZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const teil = (typ) => teile.find((t) => t.type === typ).value;
  return `${teil('day')}.${teil('month')}.${teil('year')} ${teil('hour')}:${teil('minute')}`;
}

// The freigaben table is the system's only per-action record (who, when, from which IP) — it
// already exists for the Vier-Augen-Prinzip lookups in kontierung.js/freigabe2.js/ablehnung.js.
// This turns those same rows into the human-readable timeline shown under the Freigabe section
// on every Rechnung, without every route re-implementing person-name lookups and event labels.
export function buildAuditLog(db, jobId) {
  const lokaleZeit = getConfigValue(db, 'audit_log_lokale_zeit') === '1';
  return listFreigabenByJob(db, jobId).map((eintrag) => ({
    zeitpunkt: formatZeitpunkt(eintrag.zeitpunkt, lokaleZeit),
    ereignis: EREIGNIS_LABEL[eintrag.rolle] || eintrag.rolle,
    person: personName(db, eintrag.person_id),
    interessenskonflikt: Boolean(eintrag.interessenskonflikt),
    kommentar: eintrag.kommentar,
    eskaliertVonPerson: eintrag.eskaliert_von ? personName(db, eintrag.eskaliert_von) : null,
  }));
}
