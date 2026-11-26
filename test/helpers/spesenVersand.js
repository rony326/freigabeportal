// Gemeinsame Vorarbeit für die Tests der Spesen-Bestätigung: Positionen, die schon an Bexio versandt sind.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createJob } from '../../src/db/jobsRepo.js';

// Legt zu einer vorhandenen Position Exportnachweis und Bexio-Versandquittung an.
export function quittiereVersand(db, jobId, sha256 = 'x') {
  db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, ?, '{}', '2026-11-02')")
    .run(`e${jobId}`, jobId, sha256);
  db.prepare(`INSERT INTO bexio_versand (job_id, export_id, empfaenger, message_id, smtp_antwort, gesendet_am, gemeldet_am)
    VALUES (?, ?, 'b@example.org', ?, '250', '2026-11-03', '2026-11-03')`).run(jobId, `e${jobId}`, `<m${jobId}>`);
}

// Spesenposition mit Beleg-Datei und passendem Exportnachweis; `versandt` ergänzt die Bexio-Versandquittung.
export function spesenPosition(db, { spesenabrechnungId, eingereichtVon, pdfPfad, versandt = false }) {
  const bytes = Buffer.from(`%PDF-1.4\n${pdfPfad}\n`);
  writeFileSync(pdfPfad, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const id = createJob(db, { eingangAm: '2026-11-01T00:00:00Z', quelle: 'spesen', dateiname: 'quittung.pdf', pdfPfad });
  db.prepare(`UPDATE jobs SET status = 'abgeschlossen', betrag = '10.00', beschreibung = 'Zugbillett', spesenabrechnung_id = ?,
    eingereicht_von = ?, final_datei_hash = ? WHERE id = ?`).run(spesenabrechnungId, eingereichtVon, hash, id);
  if (versandt) quittiereVersand(db, id, hash);
  else db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, ?, '{}', '2026-11-02')").run(`e${id}`, id, hash);
  return { id, bytes, hash, pdfPfad };
}
