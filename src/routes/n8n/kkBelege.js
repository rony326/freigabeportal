import { Router } from 'express';
import multer from 'multer';
import { nimmKkBelegEntgegen } from '../../services/kkBelegEingang.js';
import { machineAuditContext, mitAuditKontext } from '../../services/auditContext.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// Nimmt einen per Mail eingehenden Kreditkarten-Beleg entgegen -- n8n überwacht ein "belege@"-
// Postfach, spaltet Anhänge auf und ruft diese Route je Anhang einmal auf. Die eigentliche
// fachliche Logik (Absender-Zuordnung, Datei-/Textanalyse, Entwurf anlegen, Mail an die Person)
// steckt in kkBelegEingang.js, damit sie später auch von einem nativen Mail-Modul wiederverwendet
// werden kann.
export function createN8nKkBelegeRouter({ db, config, mailer }) {
  const router = Router();
  // Wie /api/n8n/jobs: Audit-Ereignisse dieser Route gehören dem n8n-Dienst, nicht 'anonymous'.
  router.use(machineAuditContext('service:n8n', 'n8n'));
  router.post('/', (req, res, next) => {
    mitAuditKontext(upload.single('pdf'))(req, res, async (uploadErr) => {
      try {
        if (uploadErr) return res.status(400).json({ fehler: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'datei_zu_gross' : 'upload_fehler' });
        const { status, body } = await nimmKkBelegEntgegen(db, config, mailer, { absender: req.body.absender, buffer: req.file?.buffer });
        res.status(status).json(body);
      } catch (err) {
        next(err);
      }
    });
  });
  return router;
}
