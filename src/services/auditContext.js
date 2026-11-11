// Audit-Kontext: wer handelt gerade und in welcher Anfrage/welchem Lauf? Drei AsyncLocalStorage-Speicher tragen diese
// Angaben durch asynchrone Aufrufketten, damit die Audit-Trigger der Datenbank (db/index.js: audit_actor_id() usw.) sie
// bei jeder Änderung mitschreiben können, ohne dass jede Funktion die Person durchreichen muss.
//   - Akteur: angemeldete Person (`auditContext`), Maschine (`machineAuditContext`) oder `withAuditActor`
//   - Request-ID: pro HTTP-Anfrage (`auditRequestContext`)
//   - Lauf: zusammengehörige Operation wie Backup/Wiederherstellung (`withAuditOperation`)

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
const requestContext = new AsyncLocalStorage();
const operationContext = new AsyncLocalStorage();

// Der aktuelle Lauf `{id, kind}` oder null.
export function currentAuditOperation() { return operationContext.getStore() || null; }

// Führt `action` in einem neuen Lauf (eigene UUID) mit der Art `kind` aus, z. B. 'backup-restore'.
export function withAuditOperation(kind, action) {
  return operationContext.run({ id: randomUUID(), kind }, action);
}

// Stellt einen zuvor festgehaltenen Laufkontext wieder her (null = keiner).
export function withAuditOperationContext(operation, action) {
  return operationContext.run(operation, action);
}

// Die Request-ID der laufenden Anfrage oder null (ausserhalb einer Anfrage, z. B. im Scheduler).
export function currentAuditRequestId() {
  return requestContext.getStore() || null;
}

// Stellt eine zuvor festgehaltene Request-ID wieder her, z.B. in 'finish'-Callbacks, die
// ausserhalb des asynchronen Request-Kontexts laufen.
export function withAuditRequest(requestId, action) {
  return requestContext.run(requestId, action);
}

// Express-Middleware: vergibt pro Anfrage eine serverseitige UUID und gibt sie als Header `X-Request-ID` zurück.
export function auditRequestContext(req, res, next) {
  // Vom Client gelieferte Kennungen dürfen weder unabhängige Anfragen zusammenführen noch Inhalt ins Log einschleusen.
  const requestId = randomUUID();
  res.setHeader('X-Request-ID', requestId);
  return requestContext.run(requestId, next);
}

// Der aktuell Handelnde `{id, name}`; ohne Kontext 'system' (Scheduler, Startup).
export function currentAuditActor() {
  return context.getStore() || { id: 'system', name: 'System' };
}

// Middleware für Maschinenrouten: ordnet alle Änderungen einem festen Akteur zu (z. B. 'n8n').
export function machineAuditContext(id, name) {
  return (req, res, next) => context.run({ id, name }, next);
}

// Führt `action` als der angegebene Akteur aus (für Systemaktionen im Namen einer Person).
export function withAuditActor(actor, action) {
  return context.run(actor, action);
}

// Express-Middleware: macht die angemeldete Person zum Akteur (ohne Anmeldung 'anonymous').
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
// (Siehe Kommentar oben) Umhüllt eine Middleware wie multer, damit deren Callback im Audit-Kontext der Anfrage läuft.
export function mitAuditKontext(middleware) {
  return (req, res, callback) => {
    const store = context.getStore();
    const requestId = currentAuditRequestId();
    const operation = currentAuditOperation();
    middleware(req, res, (...args) => operationContext.run(operation, () => requestContext.run(requestId, () =>
      store ? context.run(store, () => callback(...args)) : callback(...args))));
  };
}
