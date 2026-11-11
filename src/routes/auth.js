// Anmeldung per ChurchTools-OAuth2 (`/auth/*`, docs/auth-und-rechte.md): siehe Kommentar bei `createAuthRouter`.

import { Router } from 'express';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchPerson, resolveMemberGroupIds } from '../services/churchtools.js';
import { upsertPerson, getPersonById } from '../db/personenRepo.js';
import { erfasseAnmeldung, sendeNeuesGeraetMail } from '../services/nutzung.js';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';
import { schreibeTestmodusAudit } from './admin/testmodus.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Meldung, wenn ChurchTools bei der Anmeldung nicht antwortet (503).
export const CT_ZEITLIMIT_MELDUNG = 'ChurchTools antwortet gerade nicht. Bitte in ein paar Minuten erneut versuchen.';

// fetch() mit AbortSignal.timeout lehnt mit einem DOMException 'TimeoutError' ab ('AbortError' bei
// einem manuell abgebrochenen Signal).
function istZeitlimit(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

// Anmeldung per ChurchTools-OAuth2 (docs/auth-und-rechte.md): `/auth/login` (Weiterleitung), `/auth/callback` (Rückkehr), `/auth/logout`, `/auth/abgemeldet`.
// Öffentlich (nur der öffentliche Rate-Limiter, kein Login nötig).
export function createAuthRouter({ db, config, mailer = null, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /auth/login – erzeugt den `state` (CSRF-Schutz des OAuth-Ablaufs) und leitet zu ChurchTools.
  router.get('/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(buildAuthorizeUrl(config.churchtools, state));
  });

  // GET /auth/callback – prüft `state`, tauscht den Code gegen ein Token, legt/aktualisiert die Person (mit Gruppen) an, erfasst die Anmeldung (neues Gerät → Mail),
  // erneuert die Session und leitet auf /pool.
  router.get('/callback', asyncHandler(async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (!state || state !== req.session.oauthState) {
        // Weder state noch code werden protokolliert.
        meldeZugriffVerweigert(req, { grund: 'anmeldung_ungueltig', status: 400 });
        erfasseAnmeldung(db, { req, res, personId: null, erfolg: false, grund: 'state_ungueltig' });
        return res.status(400).render('error', { message: 'Ungültiger Login-Vorgang. Bitte erneut versuchen.' });
      }
      delete req.session.oauthState;

      let token;
      try {
        token = await exchangeCodeForToken(config.churchtools, code);
      } catch (err) {
        erfasseAnmeldung(db, { req, res, personId: null, erfolg: false, grund: 'token_fehler' });
        throw err;
      }
      let profile;
      try {
        profile = await fetchPerson(config.churchtools, token.access_token);
      } catch (err) {
        erfasseAnmeldung(db, { req, res, personId: null, erfolg: false, grund: 'profil_fehler' });
        throw err;
      }
      const candidateGroupIds = [config.churchtools.groupIdBuchhaltung, config.churchtools.groupIdAdmin, config.churchtools.groupIdManager].filter(Boolean);
      // AUTH-WIDEN-1: Die Anmeldung verlangt keine Mitgliedschaft in Buchhaltung/Admin mehr — Freigeber 1/2 und ihre Stellvertretungen sind kontobasierte Rollen
      // (AUTHZ-3), die in keiner der beiden Gruppen sein müssen. `gruppen` wird weiter genau wie bisher aufgelöst und gespeichert; nur die Ablehnung bei leerem
      // Array entfällt. Jede wichtige Route ist weiter hinten durch eine eigene Prüfung je Vorgang oder je Gruppe abgesichert (requireRole/requireAnyRole für /pool
      // und /admin, Prüfungen je Vorgang andernorts).
      //
      // Verwendet das Login-Token des Sync-Dienstkontos, nicht das frisch erhaltene OAuth-Zugriffstoken: OAuth2-Zugriffstoken von ChurchTools gelten nur für die
      // eigenen /oauth/*-Endpunkte (authorize, access_token, userinfo) — /api/groups/*/members antwortet dafür mit 403, an der Live-Instanz bestätigt. Das Feld
      // `groups` von /oauth/userinfo gibt es zwar, es listet aber nur Gruppen*namen*, nach denen diese App nie abgleichen darf (siehe die ausdrückliche Vorgabe des
      // Lastenhefts "nach Gruppen-ID abgleichen, nie nach Namen" — Umbenennungen in ChurchTools dürfen den Zugang nicht still brechen). Das Login-Token hat den
      // API-Zugriff, von dem der nächtliche Sync abhängt, schon; es wird hier für dieselbe Abfrage bei der Anmeldung wiederverwendet.
      const gruppen = await resolveMemberGroupIds(config.churchtools, config.churchtools.syncServiceToken, profile.id, candidateGroupIds);

      upsertPerson(db, {
        id: String(profile.id),
        vorname: profile.firstName,
        nachname: profile.lastName,
        email: profile.email,
        gruppen,
        loggedInNow: true,
      });

      const anmeldung = erfasseAnmeldung(db, { req, res, personId: String(profile.id), erfolg: true });
      if (anmeldung.neuesGeraet && mailer) {
        // Im Hintergrund und wirft nie: die Anmeldung wartet nicht auf den Mailserver.
        void sendeNeuesGeraetMail(db, mailer, { req, person: getPersonById(db, String(profile.id)) });
      }

      // /pool ist jetzt das Dashboard jeder angemeldeten Person, nicht nur der Buchhaltung/des Portal-Admins (siehe die Einbindung von /pool in app.js) — jede Anmeldung
      // landet direkt dort, ohne Startseite dazwischen.
      //
      // Die Session wird bei der Anmeldung erneuert (nicht die Session vor der Anmeldung weiterverwendet), um Session-Fixation zu verhindern: Eine vor der
      // Authentifizierung ausgestellte Session-ID darf danach nie eine gültige, authentifizierte Session-ID werden. Aus der Session vor der Anmeldung wird ab hier nichts
      // mehr gebraucht — oauthState wurde oben schon verbraucht.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.personId = String(profile.id);
        res.redirect('/pool');
      });
      return;
    } catch (err) {
      // Review Task 5, Fund 4: hängt ChurchTools (Zeitlimit aus services/churchtools.js), ist das
      // kein Fehler des Portals — 503 mit klarem Hinweis statt generischer 500-Seite, und nur eine
      // knappe Logzeile statt Stacktrace/betrieb_fehler pro Anmeldeversuch.
      if (istZeitlimit(err)) {
        console.error('Anmeldung: ChurchTools antwortet nicht (Zeitlimit überschritten).');
        return res.status(503).render('error', { message: CT_ZEITLIMIT_MELDUNG });
      }
      next(err);
    }
  }));

  // POST /auth/logout – beendet die Session (und einen laufenden Testmodus) und zeigt die Bestätigungsseite.
  router.post('/logout', csrfProtection, (req, res, next) => {
    // Abmelden beendet den Testmodus (im echten Audit-Log vermerkt).
    if (req.session.testmodus) {
      delete req.session.testmodus;
      if (req.currentPerson) schreibeTestmodusAudit(db, req.currentPerson, 'ausgeschaltet', { anlass: 'abmelden' });
    }
    req.session.destroy((err) => {
      if (err) return next(err);
      // Eine direkte Weiterleitung auf '/' schickte einen anonymen Besucher früher sofort nach /auth/login (siehe app.js), und das meldet per ChurchTools-SSO still wieder an,
      // solange die ChurchTools-Sitzung in diesem Browser noch aktiv ist — der Button sah aus, als täte er nichts. Erst auf einer echten Bestätigungsseite zu landen,
      // unterbricht diese Sofort-Schleife und macht die (echte, kurzzeitige) Abmeldung sichtbar, bevor sich jemand wieder anmelden kann.
      res.redirect('/auth/abgemeldet');
    });
  });

  // GET /auth/abgemeldet – Bestätigungsseite mit Link zur ChurchTools-Abmeldung.
  router.get('/abgemeldet', (req, res) => {
    res.render('abgemeldet', { churchtoolsBaseUrl: config.churchtools.baseUrl });
  });

  return router;
}
