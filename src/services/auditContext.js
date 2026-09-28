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
