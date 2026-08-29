import { Router } from 'express';
import { queryGlobalAuditLog } from '../../services/globalAuditLog.js';
import { listAllPersons } from '../../db/personenRepo.js';
import { listKonten } from '../../db/kontenRepo.js';
import { EREIGNIS_LABEL } from '../../services/auditLog.js';

// Ein Von-Datum ("2026-08-01") ist als reiner Tages-Präfix bereits inklusiv (String-Vergleich:
// "2026-08-01T09:00:00Z" > "2026-08-01"). Ein Bis-Datum muss dagegen auf das Tagesende erweitert
// werden, sonst schneidet "zeitpunkt <= '2026-08-01'" jeden Eintrag mit Uhrzeit an diesem Tag ab.
function bisEndeDesTages(bis) {
  if (!bis) return null;
  return bis.length === 10 ? `${bis}T23:59:59.999Z` : bis;
}

export function createAuditLogRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const filter = {
      personId: req.query.person || null,
      kontoId: req.query.konto ? Number(req.query.konto) : null,
      von: req.query.von || null,
      bis: bisEndeDesTages(req.query.bis || null),
      ereignisTyp: req.query.typ || null,
      suchbegriff: req.query.q || null,
    };
    const seite = Math.max(1, Number(req.query.seite) || 1);
    const { eintraege, gesamtAnzahl, proSeite } = queryGlobalAuditLog(db, filter, { seite });

    res.render('admin/audit-log', {
      eintraege,
      gesamtAnzahl,
      seite,
      proSeite,
      gesamtSeiten: Math.max(1, Math.ceil(gesamtAnzahl / proSeite)),
      query: req.query,
      personen: listAllPersons(db),
      konten: listKonten(db, { includeInactive: true }),
      ereignisLabels: EREIGNIS_LABEL,
    });
  });

  return router;
}
