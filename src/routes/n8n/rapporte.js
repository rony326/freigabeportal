// Maschinenroute `/api/n8n/rapporte` (Header `X-API-Key`, docs/n8n-schnittstelle.md, Abschnitt Rapporte): Archivweg für abgeschlossene Rapporte – abholbereit, Exportnachweis, hashgebundener Download der Exportdatei und Archivquittung. Aufbau wie /api/n8n/jobs, aber strikt getrennt.

import { Router, json } from 'express';
import { getConfigValue } from '../../db/adminConfigRepo.js';
import { createExportEvidence, readExportDocument, confirmArchiveReceipt, ArchiveError } from '../../services/archiveReceipt.js';
import { machineAuditContext } from '../../services/auditContext.js';

// n8n-Archivweg für Rapporte (nur zur Kenntnis): getrennt von /api/n8n/jobs, damit ein Rapport nie
// in den Rechnungs-/Bexio-Ablauf gelangt. Rapporte werden nur archiviert (Paperless), nie gebucht;
// das Manifest trägt darum weder Rechnungs- noch Zahlungsfelder (zahlung: null).
const ART = { art: 'rapport' };

// Antwortet bei einem ArchiveError mit dessen Status, sonst an den Fehler-Handler.
function sendeFehler(res, next, err) {
  if (err instanceof ArchiveError) return res.status(err.status).json({ error: err.message });
  next(err);
}

export function createN8nRapporteRouter({ db }) {
  const router = Router();
  router.use(machineAuditContext('service:n8n', 'n8n'));
  router.param('id', (req, res, next, value) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      return res.status(400).json({ error: 'Ungueltige Job-ID.' });
    }
    next();
  });

  // GET /api/n8n/rapporte/abholbereit – abgeschlossene Rapporte, deren Zeitstempel (falls verlangt) vorliegt. Gleiche Zeitstempel-Bedingung wie listAbholbereitJobs (Rechnungsweg).
  router.get('/abholbereit', (req, res) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const zeitstempelBedingung = nurMitZeitstempel ? ' AND zeitstempel_gesetzt_am IS NOT NULL' : ' AND (zeitstempel_erforderlich = 0 OR zeitstempel_gesetzt_am IS NOT NULL)';
    const rows = db.prepare(`SELECT id, eingang_am, dateiname, abgeschlossen_am FROM jobs
      WHERE typ = 'rapport' AND status = 'abgeschlossen'${zeitstempelBedingung} ORDER BY id`).all();
    res.set('Cache-Control', 'no-store').json(rows.map((row) => ({
      id: row.id,
      art: 'rapport',
      eingang_am: row.eingang_am,
      dateiname: row.dateiname,
      abgeschlossen_am: row.abgeschlossen_am,
      export_nachweis_url: `/api/n8n/rapporte/${row.id}/exportnachweis`,
    })));
  });

  // GET /api/n8n/rapporte/archivierung-ausstehend?nach_id= – abgeholte/archivierte Rapporte ohne Archivquittung (Cursor, höchstens 100).
  router.get('/archivierung-ausstehend', (req, res) => {
    const after = req.query.nach_id ?? '0';
    if (typeof after !== 'string' || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) {
      return res.status(400).json({ error: 'Ungueltiger Cursor nach_id.' });
    }
    const rows = db.prepare(`SELECT j.id, j.status FROM jobs j
      WHERE j.id > ? AND j.typ = 'rapport' AND j.status IN ('abgeholt', 'archiviert')
        AND NOT EXISTS (SELECT 1 FROM export_nachweise e JOIN archiv_quittungen q ON q.export_id = e.id WHERE e.job_id = j.id)
      ORDER BY j.id LIMIT 100`).all(Number(after));
    res.set('Cache-Control', 'no-store').json(rows.map((row) => ({ ...row, export_nachweis_url: `/api/n8n/rapporte/${row.id}/exportnachweis` })));
  });

  // GET /api/n8n/rapporte/:id/exportnachweis – unveränderliches Exportmanifest (idempotent).
  router.get('/:id/exportnachweis', (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(createExportEvidence(db, Number(req.params.id), ART));
    } catch (err) { sendeFehler(res, next, err); }
  });

  // GET /api/n8n/rapporte/:id/exportdatei/:exportId – die Exportdatei (PDF), nur wenn der Hash zum Manifest passt.
  router.get('/:id/exportdatei/:exportId', (req, res, next) => {
    try {
      const bytes = readExportDocument(db, Number(req.params.id), req.params.exportId, ART);
      res.set('Cache-Control', 'no-store').type('application/pdf').send(bytes);
    } catch (err) { sendeFehler(res, next, err); }
  });

  // POST /api/n8n/rapporte/:id/archivierung-bestaetigen – Archivquittung von n8n (Export-ID, SHA-256, Paperless-Dokument-ID, Aufgaben-UUID); setzt den Rapport auf 'abgeholt'.
  router.post('/:id/archivierung-bestaetigen', json({ limit: '8kb' }), (req, res, next) => {
    try {
      const quittung = confirmArchiveReceipt(db, Number(req.params.id), req.body, ART);
      res.json({ id: Number(req.params.id), status: 'archiv_bestaetigt', quittung });
    } catch (err) { sendeFehler(res, next, err); }
  });

  return router;
}
