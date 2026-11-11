// Admin → Mail-Protokoll (`/admin/mails`, Recht `mails_einsehen`, docs/admin-bereich.md): alle versendeten, geplanten und fehlgeschlagenen Mails; fehlgeschlagene lassen sich erneut versenden.

import { Router } from 'express';
import { istWartungsmodusAktiv } from '../../services/wartungsmodus.js';
import { listMailLog, getMailLogById } from '../../db/mailLogRepo.js';
import { sendRenderedMail } from '../../services/notify.js';
import { stelleMailZu } from '../../services/mailZustellung.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

export function createMailsRouter({ db, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/mails – das Protokoll (neueste zuerst).
  router.get('/', (req, res) => {
    res.render('admin/mails', { mails: listMailLog(db), gespeichert: req.query.gespeichert === '1', zurueckgehalten: req.query.zurueckgehalten === '1' });
  });

  // POST /admin/mails/:id/erneut-versenden – sendet eine protokollierte Mail unverändert nochmals (sofort, nie gebündelt).
  router.post('/:id/erneut-versenden', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      // Wartungsmodus: nichts versenden und keine neue Zeile anlegen.
      if (istWartungsmodusAktiv(db)) return res.redirect('/admin/mails?zurueckgehalten=1');
      const eintrag = getMailLogById(db, Number(req.params.id));
      if (!eintrag) {
        return res.status(404).render('error', { message: 'Mail-Eintrag nicht gefunden.' });
      }
      if (eintrag.status === 'geplant') {
        return res.status(400).render('error', { message: 'Diese Mail ist noch nicht versendet worden (wartet auf den nächsten Digest-Lauf) und kann nicht erneut versendet werden.' });
      }
      if (eintrag.status === 'eingereiht') {
        // Noch in der automatischen Wiederholung: dieselbe Zeile sofort versuchen statt eine
        // zweite anzulegen -- sonst könnte der Empfänger die Nachricht doppelt erhalten.
        db.prepare("UPDATE mail_log SET naechster_versuch_am = ? WHERE id = ? AND status = 'eingereiht'").run(new Date().toISOString(), eintrag.id);
        await stelleMailZu(db, mailer, eintrag.id);
        return res.redirect('/admin/mails?gespeichert=1');
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
  }));

  return router;
}
