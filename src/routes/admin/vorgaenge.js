import { Router } from 'express';
import { getJobById } from '../../db/jobsRepo.js';
import { getKontoById } from '../../db/kontenRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { getConfigValue } from '../../db/adminConfigRepo.js';
import { personHasPermission, requirePermission } from '../../middleware/permissions.js';
import { buildAuditLog } from '../../services/auditLog.js';
import { canViewJobPdf } from '../../services/jobAuthorization.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../../services/downloadUrl.js';
import { listLaufendeVorgaenge, beschreibeVorgang, STATUS_LABEL } from '../../services/vorgaengeUebersicht.js';
import { LAUFENDE_STATUS, ermittleZustaendigkeit, standToken } from '../../services/vorgangZustaendigkeit.js';
import { listUmhaengenZiele, umhaengeVorgang, istUmhaengbar, MIN_BEMERKUNG_LAENGE } from '../../services/vorgangUmhaengen.js';
import { ermittleStriktesWeiterleitungsZiel } from '../../services/kontierungZugriff.js';
import { kommentarBereich } from '../kommentare.js';
import { kommentarInfoFuer } from '../../services/kommentare.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const NICHT_LAUFEND = 'Dieser Vorgang existiert nicht oder ist nicht (mehr) in Bearbeitung.';

export function createVorgaengeRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function kannEingreifen(req) {
    return personHasPermission(db, config, req.currentPerson, 'workflow_eingreifen');
  }

  function ladeLaufendenJob(id) {
    const job = getJobById(db, Number(id));
    return job && LAUFENDE_STATUS.includes(job.status) ? job : null;
  }

  // Hinweis bei aktiver strikter Freigeber1-Prüfung: der Admin-Eingriff hebelt sie nicht aus. Das
  // Ziel kommt aus derselben Funktion wie die Weiterleitung in der Kontierung, damit der Hinweis
  // nie eine Person nennt, die wegen eines erklärten Konflikts gar nicht in Frage kommt.
  function strikterHinweis(job) {
    if (job.status !== 'zugewiesen' || !job.konto_id) return null;
    if (getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') !== '1') return null;
    const konto = getKontoById(db, job.konto_id);
    if (!konto) return null;
    const ziel = ermittleStriktesWeiterleitungsZiel(db, job, konto, null);
    if (ziel.anAdmin) return { anAdmin: true };
    const person = getPersonById(db, ziel.personId);
    return person ? { name: `${person.vorname} ${person.nachname}` } : null;
  }

  function renderDetail(req, res, status, job, { errors = [], werte = {}, umgehaengt = false, standOverride = null } = {}) {
    const darfEingreifen = kannEingreifen(req) && istUmhaengbar(job);
    res.status(status).render('admin/vorgang-detail', {
      vorgang: beschreibeVorgang(db, job),
      auditLog: buildAuditLog(db, job.id),
      pdfUrl: canViewJobPdf(db, config, req.currentPerson, job) ? buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS) : null,
      darfEingreifen,
      ziele: darfEingreifen ? listUmhaengenZiele(db, job) : [],
      // Bei einer 422-Neuanzeige bleibt der abgeschickte Stand stehen: ein frisch berechneter
      // würde eine zwischenzeitliche Änderung beim nächsten Absenden verschlucken (409 entfiele).
      stand: standOverride ?? standToken(job, ermittleZustaendigkeit(db, job)),
      strikterHinweis: darfEingreifen ? strikterHinweis(job) : null,
      minBemerkung: MIN_BEMERKUNG_LAENGE,
      errors,
      werte: { zielId: '', bemerkung: '', ...werte },
      umgehaengt,
      kommentarBereich: kommentarBereich(db, config, req.currentPerson, job, `/admin/vorgaenge/${job.id}`),
    });
  }

  router.get('/', (req, res) => {
    const filter = {
      status: LAUFENDE_STATUS.includes(req.query.status) ? req.query.status : '',
      art: ['rechnung', 'gutschrift', 'spesen'].includes(req.query.art) ? req.query.art : '',
      personId: typeof req.query.person === 'string' ? req.query.person : '',
      nurProbleme: req.query.probleme === '1',
    };
    const alle = listLaufendeVorgaenge(db);
    const personen = [...new Map(alle.filter((v) => v.zustaendig.personId).map((v) => [v.zustaendig.personId, v.zustaendig.name])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const vorgaenge = listLaufendeVorgaenge(db, filter);
    res.render('admin/vorgaenge-liste', {
      vorgaenge,
      kommentarInfo: kommentarInfoFuer(db, config, req.currentPerson, vorgaenge.map((v) => v.id)),
      filter,
      personen,
      statusLabel: STATUS_LABEL,
      darfEingreifen: kannEingreifen(req),
    });
  });

  router.get('/:id', (req, res) => {
    const job = ladeLaufendenJob(req.params.id);
    if (!job) return res.status(404).render('error', { message: NICHT_LAUFEND });
    renderDetail(req, res, 200, job, { umgehaengt: req.query.umgehaengt === '1' });
  });

  router.post('/:id/umhaengen', requirePermission(db, config, 'workflow_eingreifen'), csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const job = ladeLaufendenJob(req.params.id);
      if (!job || !istUmhaengbar(job)) return res.status(404).render('error', { message: NICHT_LAUFEND });
      const zielId = typeof req.body.zielId === 'string' ? req.body.zielId : '';
      const bemerkung = typeof req.body.bemerkung === 'string' ? req.body.bemerkung.trim() : '';
      const werte = { zielId, bemerkung };
      const errors = [];
      if (bemerkung.length < MIN_BEMERKUNG_LAENGE) errors.push(`Bitte eine Bemerkung mit mindestens ${MIN_BEMERKUNG_LAENGE} Zeichen angeben.`);
      if (req.body.bestaetigung !== 'ja') errors.push('Bitte das Umhängen bestätigen.');
      if (!zielId) errors.push('Bitte eine Zielperson auswählen.');
      const standErwartet = typeof req.body.stand === 'string' ? req.body.stand : '';
      if (errors.length) return renderDetail(req, res, 422, job, { errors, werte, standOverride: standErwartet });

      const ergebnis = await umhaengeVorgang(db, config, mailer, {
        jobId: job.id,
        zielId,
        bemerkung,
        standErwartet,
        admin: req.currentPerson,
        ip: req.ip,
      });
      if (ergebnis.ok) return res.redirect(`/admin/vorgaenge/${job.id}?umgehaengt=1`);

      const aktuell = ladeLaufendenJob(job.id);
      if (ergebnis.fehler === 'phase' || !aktuell) return res.status(404).render('error', { message: NICHT_LAUFEND });
      if (ergebnis.fehler === 'ziel') return renderDetail(req, res, 422, aktuell, { errors: ['Diese Person kann den Vorgang nicht übernehmen. Bitte eine Person aus der Liste wählen.'], werte, standOverride: standErwartet });
      return renderDetail(req, res, 409, aktuell, { errors: ['Der Vorgang hat sich inzwischen geändert. Bitte den aktuellen Stand prüfen und erneut umhängen.'], werte: { bemerkung } });
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
