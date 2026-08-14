import { Router } from 'express';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchPerson, resolveMemberGroupIds } from '../services/churchtools.js';
import { upsertPerson } from '../db/personenRepo.js';

export function createAuthRouter({ db, config }) {
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
      const candidateGroupIds = [config.churchtools.groupIdBuchhaltung, config.churchtools.groupIdAdmin];
      const gruppen = await resolveMemberGroupIds(config.churchtools, token.access_token, profile.id, candidateGroupIds);

      upsertPerson(db, {
        id: String(profile.id),
        vorname: profile.firstName,
        nachname: profile.lastName,
        email: profile.email,
        gruppen,
        loggedInNow: true,
      });

      req.session.personId = String(profile.id);
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.redirect('/');
    });
  });

  return router;
}
