import { Router } from 'express';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchPerson, resolveMemberGroupIds } from '../services/churchtools.js';
import { upsertPerson } from '../db/personenRepo.js';

export function createAuthRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(buildAuthorizeUrl(config.churchtools, state));
  });

  router.get('/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (!state || state !== req.session.oauthState) {
        return res.status(400).render('error', { message: 'Ungültiger Login-Vorgang. Bitte erneut versuchen.' });
      }
      delete req.session.oauthState;

      const token = await exchangeCodeForToken(config.churchtools, code);
      const profile = await fetchPerson(config.churchtools, token.access_token);
      const candidateGroupIds = [config.churchtools.groupIdBuchhaltung, config.churchtools.groupIdAdmin, config.churchtools.groupIdManager].filter(Boolean);
      // AUTH-WIDEN-1: login no longer requires Buchhaltung/Admin membership — Freigeber1/2 and
      // their Stellvertreter are account-based roles (AUTHZ-3) that may not be in either group.
      // gruppen is still resolved and stored exactly as before; only the empty-array rejection
      // is gone. Every route that matters is gated by its own per-job or per-group check
      // downstream (requireRole/requireAnyRole for /pool and /admin, per-job checks elsewhere).
      //
      // Uses the sync service account's Login-Token, not the freshly-obtained OAuth access
      // token: ChurchTools' OAuth2 access tokens are only valid against the dedicated /oauth/*
      // endpoints (authorize, access_token, userinfo) — /api/groups/*/members returns 403 for
      // them, confirmed against the live instance. /oauth/userinfo's own `groups` field exists
      // but only lists group *names*, which this app must never match against (see the
      // Lastenheft's explicit "match by group ID, never by name" requirement — group renames in
      // ChurchTools must not silently break access). The Login-Token already has the API access
      // the nightly sync depends on, so it's reused here for the identical lookup at login time.
      const gruppen = await resolveMemberGroupIds(config.churchtools, config.churchtools.syncServiceToken, profile.id, candidateGroupIds);

      upsertPerson(db, {
        id: String(profile.id),
        vorname: profile.firstName,
        nachname: profile.lastName,
        email: profile.email,
        gruppen,
        loggedInNow: true,
      });

      // /pool is now the dashboard for every logged-in person, not just Buchhaltung/Portal-Admin
      // (see app.js's /pool mount) — every login lands there directly, no landing page in between.
      //
      // Regenerate the session on login (not just reuse the pre-login one) to prevent session
      // fixation: a session ID issued before authentication must never become a valid,
      // authenticated session ID after it. Nothing from the pre-login session is needed past
      // this point — oauthState was already consumed above.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.personId = String(profile.id);
        res.redirect('/pool');
      });
      return;
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', csrfProtection, (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      // Redirecting straight to '/' used to immediately bounce an anonymous visitor to
      // /auth/login (see app.js), which silently re-authenticates via ChurchTools SSO as long as
      // the ChurchTools-side session is still active in this browser — the button looked like it
      // did nothing. Landing on a real confirmation page first breaks that instant loop and makes
      // the (real, momentary) logout visible before anyone can click their way back in.
      res.redirect('/auth/abgemeldet');
    });
  });

  router.get('/abgemeldet', (req, res) => {
    res.render('abgemeldet', { churchtoolsBaseUrl: config.churchtools.baseUrl });
  });

  return router;
}
