import { Router } from 'express';
import { listMailLog, getMailLogById } from '../../db/mailLogRepo.js';
import { sendRenderedMail } from '../../services/notify.js';

export function createMailsRouter({ db, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/mails', { mails: listMailLog(db), gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/:id/erneut-versenden', csrfProtection, async (req, res, next) => {
    try {
      const eintrag = getMailLogById(db, Number(req.params.id));
      if (!eintrag) {
        return res.status(404).render('error', { message: 'Mail-Eintrag nicht gefunden.' });
      }
      if (eintrag.status === 'geplant') {
        return res.status(400).render('error', { message: 'Diese Mail ist noch nicht versendet worden (wartet auf den nächsten Digest-Lauf) und kann nicht erneut versendet werden.' });
      }
      await sendRenderedMail(db, mailer, {
        to: eintrag.empfaenger,
        subject: eintrag.betreff,
        text: eintrag.text,
        typ: eintrag.typ,
        jobId: eintrag.job_id,
      });
      res.redirect('/admin/mails?gespeichert=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
