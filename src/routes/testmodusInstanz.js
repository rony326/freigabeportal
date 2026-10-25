import { Router } from 'express';
import { runPoolErinnerungenJob, runFreigabe2ErinnerungenJob, runMailDigestJob, runMailZustellungJob } from '../services/cronJobs.js';

// Nur in der Test-Instanz gemountet (app.js, Zweig `testmodus`): Test-Postfach und Jobs per Knopf.
// Ausgeführt werden ausschliesslich diese vier Jobs, gegen die Spiel-DB. Sync, Backup, Zeitstempel
// und n8n gehören bewusst nicht dazu.
export const TESTMODUS_JOBS = [
  { id: 'pool-erinnerungen', name: 'Pool-Erinnerungen', fn: runPoolErinnerungenJob },
  { id: 'freigabe2-erinnerungen', name: 'Freigabe-2-Erinnerungen', fn: runFreigabe2ErinnerungenJob },
  { id: 'mail-digest', name: 'Mail-Sammelversand', fn: runMailDigestJob },
  { id: 'mail-zustellung', name: 'Mailzustellung', fn: runMailZustellungJob },
];

const STATUS_TEXT = { erfolg: 'erfolgreich', fehler: 'fehlgeschlagen', uebersprungen: 'nichts zu tun', abgebrochen: 'abgebrochen' };

export function createTestmodusInstanzRouter({ db, config, mailer, csrfProtection }) {
  const router = Router();

  router.get('/postfach', (req, res) => {
    const mails = db.prepare('SELECT id, typ, empfaenger, betreff, text, status, versucht_am FROM mail_log ORDER BY versucht_am DESC, id DESC LIMIT 200').all();
    const ergebnis = String(req.query.ergebnis || '');
    res.render('testmodus-postfach', { mails, ergebnis: ergebnis ? ergebnis.split('|').slice(0, TESTMODUS_JOBS.length) : null });
  });

  router.post('/jobs', csrfProtection, async (req, res, next) => {
    try {
      const teile = [];
      for (const job of TESTMODUS_JOBS) {
        let status;
        try {
          const r = await job.fn(db, config, mailer);
          status = STATUS_TEXT[r?.status] || r?.status || 'erfolgreich';
        } catch (err) {
          console.error(`Testmodus: Job ${job.name} fehlgeschlagen:`, err?.stack || err);
          const meldung = String(err?.message || err || '').replace(/[|\r\n]+/g, ' ').slice(0, 200);
          status = meldung ? `${STATUS_TEXT.fehler} (${meldung})` : STATUS_TEXT.fehler;
        }
        teile.push(`${job.name}: ${status}`);
      }
      res.redirect(`/testmodus/postfach?ergebnis=${encodeURIComponent(teile.join('|'))}`);
    } catch (err) { next(err); }
  });

  return router;
}
