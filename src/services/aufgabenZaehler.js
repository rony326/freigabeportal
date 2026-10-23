import {
  listZugewiesenJobsForPerson,
  listFreigabe2JobsForPerson,
  listSpesenFreigabe1JobsForPerson,
  listAdminEskalierteKontierungen,
  listAdminEskalierteFreigaben,
  listAdminEskalierteSpesenFreigaben,
} from '../db/jobsRepo.js';

// Offene Aufgaben einer Person: dieselben Listen wie die persönlichen Abschnitte auf /pool
// (Kontierungen, Freigaben, Spesen-Freigaben, jeweils inkl. Vertretungsfälle). Superadmins sehen
// auf /pool zusätzlich die drei Eskalations-Abschnitte; die zählen dann ebenfalls mit.
// Pool, Rückläufer und abgelehnte Jobs zählen bewusst nicht mit.
export function zaehleOffeneAufgaben(db, personId, { istSuperadmin = false } = {}) {
  let summe =
    listZugewiesenJobsForPerson(db, personId).length +
    listFreigabe2JobsForPerson(db, personId).length +
    listSpesenFreigabe1JobsForPerson(db, personId).length;
  if (istSuperadmin) {
    summe +=
      listAdminEskalierteKontierungen(db).length +
      listAdminEskalierteFreigaben(db).length +
      listAdminEskalierteSpesenFreigaben(db).length;
  }
  return summe;
}
