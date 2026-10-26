// Express 4 leitet abgelehnte Promises aus async-Handlern NICHT an den Fehler-Handler weiter: ein
// Fehler (auch ein synchron werfender DB-Aufruf wie SQLITE_FULL/BUSY in einem async-Handler) würde
// zur unhandledRejection und damit zum Prozess-Exit (Review Task 5, Fund 1). Jeder async-Handler
// in src/routes/** wird deshalb mit asyncHandler registriert; der Sweep-Test
// test/sicherheit/asyncHandlerSweep.test.js verhindert, dass ein neuer Handler das vergisst.
//
// Gibt die Promise zurück, damit Tests (und Aufrufer) auf das Ende warten können; Express ignoriert
// den Rückgabewert.
export function asyncHandler(fn) {
  return function asyncRouteHandler(req, res, next) {
    return Promise.resolve()
      .then(() => fn.call(this, req, res, next))
      .catch(next);
  };
}

// Gleiches für async-Rückrufe innerhalb eines Handlers, z.B. der next-Rückruf von multer oder
// csrfProtection: `csrfProtection(req, res, asyncCallback(next, async (csrfErr) => { ... }))`.
export function asyncCallback(next, fn) {
  return function asyncNextCallback(...args) {
    return Promise.resolve()
      .then(() => fn.apply(this, args))
      .catch(next);
  };
}
