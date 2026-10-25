import { personHasRole } from './roles.js';

// Pfade, die auch mit eingeschaltetem Testmodus immer in der echten App laufen.
export const ECHTE_PFADE = ['/auth', '/healthz', '/admin/testmodus', '/admin/betrieb/status', '/api/n8n', '/internal', '/static', '/branding'];

export function istEchterPfad(pfad) {
  const p = String(pfad || '').toLowerCase();
  return ECHTE_PFADE.some((praefix) => p === praefix || p.startsWith(`${praefix}/`));
}

export function darfTestmodus(person, config) {
  return Boolean(person && person.aktiv) && (personHasRole(person, config, 'superadmin') || personHasRole(person, config, 'manager'));
}

// Weiche direkt nach loadCurrentPerson: eine Sitzung mit req.session.testmodus und einer echten
// Superadmin-/Manager-Person geht an die Test-Instanz; sonst echte App. Verliert die Person die
// Rolle, wird das Flag gelöscht. Läuft vor Nutzungserfassung und Audit der echten App, damit
// Testmodus-Anfragen (auch 401/403) dort nichts hinterlassen.
// echterCsrfToken(req, res): Token der echten App für die Band-Formulare der Test-Instanz.
export function testmodusWeiche({ config, holeTestApp, echterCsrfToken }) {
  return (req, res, next) => {
    if (!req.session?.testmodus) return next();
    if (!darfTestmodus(req.currentPerson, config)) {
      delete req.session.testmodus;
      return next();
    }
    if (istEchterPfad(req.path)) return next();
    let token;
    try {
      token = echterCsrfToken(req, res);
    } catch (err) {
      return next(err);
    }
    Promise.resolve()
      .then(holeTestApp)
      .then((testApp) => {
        req.testmodusEchterCsrfToken = token;
        // Nichts aus der echten App (Person, Branding, Token) in die Views der Test-Instanz tragen.
        res.locals = Object.create(null);
        req.currentPerson = null;
        testApp(req, res, next);
      }, (err) => {
        // Spielwiese nicht verfügbar: Testmodus aus, echte App weiter.
        console.error('Testmodus: Test-Instanz nicht verfügbar:', err?.message || err);
        delete req.session.testmodus;
        next();
      });
  };
}
