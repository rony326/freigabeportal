import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
const requestContext = new AsyncLocalStorage();
const operationContext = new AsyncLocalStorage();

export function currentAuditOperation() { return operationContext.getStore() || null; }

export function withAuditOperation(kind, action) {
  return operationContext.run({ id: randomUUID(), kind }, action);
}

export function currentAuditRequestId() {
  return requestContext.getStore() || null;
}

export function auditRequestContext(req, res, next) {
  // Client-supplied identifiers must not merge unrelated requests or inject log content.
  const requestId = randomUUID();
  res.setHeader('X-Request-ID', requestId);
  return requestContext.run(requestId, next);
}

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
    const requestId = currentAuditRequestId();
    const operation = currentAuditOperation();
    middleware(req, res, (...args) => operationContext.run(operation, () => requestContext.run(requestId, () =>
      store ? context.run(store, () => callback(...args)) : callback(...args))));
  };
}
