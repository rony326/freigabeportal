import { Router } from 'express';
import { getJobById } from '../db/jobsRepo.js';
import {
  darfKommentareSehen,
  darfKommentieren,
  erwaehnbarePersonen,
  erfasseKommentar,
  listeKommentare,
  markiereGelesen,
  KOMMENTAR_MAX_LAENGE,
} from '../services/kommentare.js';
import { erfasseFehler } from '../services/nutzung.js';

// Erlaubte Rücksprungziele: nur die Seiten mit Kommentarbereich, mit ihren tatsächlichen
// Mount-Pfaden aus src/app.js (Ablehnung hängt unter /abgelehnt, der KK-Abgleich unter
// /kontierung/:id/kk-abgleich). Ganze Pfade per Regex statt
// Präfixvergleich: so passen weder "//evil", "/\evil", kodierte Varianten noch "../" oder
// Zusatz-Query. Alles andere → Startseite.
const ZURUECK_MUSTER = [
  /^\/kontierung\/\d+$/,
  /^\/kontierung\/\d+\/kk-abgleich$/,
  /^\/freigabe2\/\d+$/,
  /^\/abgelehnt\/\d+$/,
  /^\/spesen-freigabe1\/\d+$/,
  /^\/admin\/vorgaenge\/\d+$/,
  /^\/zeitstempel-pruefen\?jobId=\d+$/,
];

export function sicheresZiel(zurueck) {
  return typeof zurueck === 'string' && ZURUECK_MUSTER.some((re) => re.test(zurueck)) ? zurueck : null;
}

// Locals für views/_kommentare.ejs. Markiert die Kommentare als gelesen (jede eingebundene Seite).
// null, wenn die Person die Kommentare nicht sehen darf (Seite zeigt dann keinen Bereich).
export function kommentarBereich(db, config, person, job, zurueck) {
  if (!job || !person || !darfKommentareSehen(db, config, person, job)) return null;
  markiereGelesen(db, job.id, person.churchtools_person_id);
  const darf = darfKommentieren(db, config, person, job);
  return {
    kommentare: listeKommentare(db, job.id),
    darfKommentieren: darf,
    erwaehnbar: darf ? erwaehnbarePersonen(db, config, job).filter((p) => p.id !== person.churchtools_person_id) : [],
    jobId: job.id,
    zurueck: sicheresZiel(zurueck) || '',
    maxLaenge: KOMMENTAR_MAX_LAENGE,
  };
}

export function createKommentareRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function zeigeFehler(res, status, { job, text, zurueck, fehler, darf }) {
    res.status(status).render('kommentar-fehler', {
      fehler,
      text,
      jobId: job.id,
      zurueck: sicheresZiel(zurueck) || '',
      zurueckLink: sicheresZiel(zurueck) ? `${zurueck}#kommentare` : '/',
      darfKommentieren: darf,
      maxLaenge: KOMMENTAR_MAX_LAENGE,
    });
  }

  router.post('/:jobId', csrfProtection, async (req, res) => {
    const job = /^\d+$/.test(req.params.jobId) ? getJobById(db, Number(req.params.jobId)) : null;
    if (!job || !darfKommentareSehen(db, config, req.currentPerson, job)) {
      return res.status(403).render('error', { message: 'Kein Zugriff auf diesen Vorgang.' });
    }
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    const zurueck = typeof req.body.zurueck === 'string' ? req.body.zurueck : '';
    let ergebnis;
    try {
      // Bewusst ausserhalb jeder Transaktion (siehe Kommentar an erfasseKommentar, N1). Die
      // Hintergrund-Zustellung (ergebnis.zustellung) wird nicht abgewartet.
      ergebnis = await erfasseKommentar(db, config, mailer, { job, person: req.currentPerson, text });
    } catch (err) {
      console.error('POST /kommentare: Kommentar konnte nicht gespeichert werden', err);
      const fehlerId = erfasseFehler(db, { req, err, status: 500 }).slice(0, 8);
      return zeigeFehler(res, 500, {
        job, text, zurueck, darf: true,
        fehler: [`Der Kommentar konnte wegen eines technischen Fehlers nicht gespeichert werden. Bitte versuche es später erneut (Fehler-ID ${fehlerId}).`],
      });
    }
    if (!ergebnis.ok) {
      return zeigeFehler(res, 422, { job, text, zurueck, fehler: ergebnis.fehler, darf: darfKommentieren(db, config, req.currentPerson, job) });
    }
    const ziel = sicheresZiel(zurueck);
    res.redirect(ziel ? `${ziel}#kommentare` : '/');
  });

  return router;
}
