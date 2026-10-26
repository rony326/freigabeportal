import { personHasRole } from './roles.js';
import { schreibeTestmodusAudit } from '../routes/admin/testmodus.js';

// Pfade, die auch mit eingeschaltetem Testmodus immer in der echten App laufen.
// Statische Dateien (/css, /js, /vendor …) brauchen keinen Eintrag: express.static läuft vor der
// Weiche. /branding fehlt bewusst: im Testmodus kommt das Logo aus der Branding-Kopie der Spielwiese.
// /audit-pruefen ist die öffentliche Prüfung echter Revisionspakete und antwortet immer echt.
// /zeitstempel-pruefen bleibt bewusst in der Spielwiese: es prüft Belege per Job-ID, und die Links
// dorthin kommen von Seiten der Spielwiese (Spiel-IDs); die Seite trägt das Band.
export const ECHTE_PFADE = ['/auth', '/healthz', '/admin/testmodus', '/admin/betrieb/status', '/audit-pruefen', '/api/n8n', '/internal'];

export const HINWEIS_ROLLE = 'Der Testmodus wurde beendet, weil du keine Admin-Rolle (Superadmin oder Manager) mehr hast.';
export const HINWEIS_SPIELWIESE = 'Der Testmodus wurde beendet, weil die Spielwiese nicht verfügbar ist. Du arbeitest wieder im echten Portal.';

export function istEchterPfad(pfad) {
  const p = String(pfad || '').toLowerCase();
  return ECHTE_PFADE.some((praefix) => p === praefix || p.startsWith(`${praefix}/`));
}

export function darfTestmodus(person, config) {
  return Boolean(person && person.aktiv) && (personHasRole(person, config, 'superadmin') || personHasRole(person, config, 'manager'));
}

// Beendet den Testmodus ohne Zutun der Person: echtes Audit + einmaliger Hinweis in der Sitzung.
function beende(db, req, anlass, hinweis) {
  delete req.session.testmodus;
  req.session.testmodusHinweis = hinweis;
  try {
    const person = req.currentPerson || { churchtools_person_id: req.session.personId ?? 'unbekannt', vorname: 'Unbekannte', nachname: 'Person' };
    schreibeTestmodusAudit(db, person, 'ausgeschaltet', { anlass });
  } catch (err) {
    console.error('Testmodus: Audit beim automatischen Beenden fehlgeschlagen:', err?.message || err);
  }
}

// Einmaliger Hinweis (siehe beende): auf der nächsten Seite der echten App angezeigt, dann gelöscht.
function zeigeHinweis(req, res) {
  const hinweis = req.session?.testmodusHinweis;
  if (!hinweis || req.method !== 'GET' || /^\/(api|downloads|branding|internal|healthz)(\/|$)/i.test(req.path)) return;
  delete req.session.testmodusHinweis;
  res.locals.testmodusHinweis = hinweis;
}

// Weiche direkt nach loadCurrentPerson: eine Sitzung mit req.session.testmodus und einer echten
// Superadmin-/Manager-Person geht an die Test-Instanz; sonst echte App. Verliert die Person die
// Rolle oder ist die Spielwiese nicht verfügbar, endet der Testmodus (Audit + Hinweis). Läuft vor
// Nutzungserfassung und Audit der echten App, damit Testmodus-Anfragen (auch 401/403) dort nichts
// hinterlassen.
// echterCsrfToken(req, res): Token der echten App für die Band-Formulare der Test-Instanz.
export function testmodusWeiche({ db, config, holeTestApp, echterCsrfToken }) {
  return (req, res, next) => {
    if (!req.session?.testmodus) {
      zeigeHinweis(req, res);
      return next();
    }
    if (!darfTestmodus(req.currentPerson, config)) {
      beende(db, req, 'rolle_verloren', HINWEIS_ROLLE);
      zeigeHinweis(req, res);
      return next();
    }
    if (istEchterPfad(req.path)) {
      // Kein Band auf echten Seiten: stattdessen ein Hinweis, dass hier Änderungen echt wirken.
      res.locals.testmodusEchteSeite = true;
      return next();
    }
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
        // Eigener Abschluss statt des next() der echten App: was aus der Test-Instanz entweicht,
        // erreicht weder die echten Routen noch den echten Fehler-Handler (betrieb_fehler).
        testApp(req, res, (err) => {
          if (err) console.error('Testmodus: Fehler aus der Test-Instanz:', err?.stack || err);
          if (res.headersSent) return;
          res.status(err ? 500 : 404).type('text/plain; charset=utf-8')
            .send(err ? 'Testmodus: Es ist ein unerwarteter Fehler aufgetreten.' : 'Testmodus: Seite nicht gefunden.');
        });
      }, (err) => {
        // Spielwiese nicht verfügbar: Testmodus aus, echte App weiter.
        console.error('Testmodus: Test-Instanz nicht verfügbar:', err?.message || err);
        beende(db, req, 'spielwiese_fehler', HINWEIS_SPIELWIESE);
        zeigeHinweis(req, res);
        next();
      })
      // Wirft einer der beiden Zweige selbst (DB-Fehler in beende/zeigeHinweis, synchroner Throw
      // aus testApp), darf daraus keine unhandledRejection (= Prozess-Exit) werden.
      .catch((err) => {
        if (res.headersSent) return console.error('Testmodus: Fehler nach Antwortbeginn:', err?.message || err);
        next(err);
      });
  };
}
