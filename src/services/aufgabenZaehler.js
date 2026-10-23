import {
  listZugewiesenJobsForPerson,
  listFreigabe2JobsForPerson,
  listSpesenFreigabe1JobsForPerson,
} from '../db/jobsRepo.js';

// Offene Aufgaben einer Person: dieselben Listen wie "Meine Kontierungen/Freigaben" auf /pool.
// Pool, Rückläufer, Eskalationen und abgelehnte Jobs zählen bewusst nicht mit.
export function zaehleOffeneAufgaben(db, personId) {
  return (
    listZugewiesenJobsForPerson(db, personId).length +
    listFreigabe2JobsForPerson(db, personId).length +
    listSpesenFreigabe1JobsForPerson(db, personId).length
  );
}
