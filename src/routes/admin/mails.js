import { Router } from 'express';
import { listMailLog, getMailLogById } from '../../db/mailLogRepo.js';
import { sendNotification } from '../../services/notify.js';

export function createMailsRouter({ db, mailer }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/mails', { mails: listMailLog(db) });
  });

  router.post('/:id/erneut-versenden', async (req, res, next) => {
    try {
      const eintrag = getMailLogById(db, Number(req.params.id));
      if (!eintrag) {
        return res.status(404).render('error', { message: 'Mail-Eintrag nicht gefunden.' });
      }
      await sendNotification(db, mailer, {
        to: eintrag.empfaenger,
        subject: eintrag.betreff,
        text: eintrag.text,
        typ: eintrag.typ,
        jobId: eintrag.job_id,
      });
      res.redirect('/admin/mails');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
