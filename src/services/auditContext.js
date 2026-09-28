import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

export function currentAuditActor() {
  return context.getStore() || { id: 'system', name: 'System' };
}

export function machineAuditContext(id, name) {
  return (req, res, next) => context.run({ id, name }, next);
}

export function withAuditActor(actor, action) {
  return context.run(actor, action);
}

export function auditContext(req, res, next) {
  const person = req.currentPerson;
  context.run(person ? {
    id: person.churchtools_person_id,
    name: `${person.vorname} ${person.nachname}`,
  } : { id: 'anonymous', name: 'Anonymous' }, next);
}

// Multer (busboy) ruft seinen Callback aus Stream-Ereignissen auf, deren asynchroner Kontext nicht
// der des Requests ist: ohne diesen Wrapper landen Audit-Ereignisse im Callback als 'system'.
// Der Wrapper merkt sich den aktuellen Akteur beim Aufruf und führt den Callback darin aus.
export function mitAuditKontext(middleware) {
  return (req, res, callback) => {
    const store = context.getStore();
    middleware(req, res, (...args) => (store ? context.run(store, () => callback(...args)) : callback(...args)));
  };
}
