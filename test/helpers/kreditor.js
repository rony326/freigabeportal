import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';

// Vollständiger Kreditor (Standard: Überweisung) mit manuell hinterlegter IBAN.
export function kreditorMitIban(db, { name, kontoId = null, iban = 'CH9300762011623852957', zahlungsart = 'ueberweisung' }) {
  const id = createKreditor(db, { name, kontoId, zahlungsart });
  createKreditorIban(db, { kreditorId: id, iban, quelle: 'manuell' });
  return id;
}

// Kreditor, der keine IBAN braucht (Lastschrift) und damit auch ohne sofort vollständig ist.
export function kreditorOhneIbanPflicht(db, { name, kontoId = null }) {
  return createKreditor(db, { name, kontoId, zahlungsart: 'lastschrift' });
}
