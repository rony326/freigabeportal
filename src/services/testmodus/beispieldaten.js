import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { upsertPerson } from '../../db/personenRepo.js';
import { createKonto } from '../../db/kontenRepo.js';
import { createKreditor } from '../../db/kreditorenRepo.js';
import {
  createJob, claimJob, setKontierung, updateKontierungMetadaten, abschliessenFreigabe1,
  abschliessenFreigabe2, ablehnenJob, setThumbnailPfad, createSpesenPosition,
} from '../../db/jobsRepo.js';
import { createFreigabe } from '../../db/freigabenRepo.js';
import { createSpesenabrechnung } from '../../db/spesenabrechnungenRepo.js';
import { renderFirstPageThumbnail } from '../thumbnail.js';

export const BEISPIELPERSONEN = [
  { id: 'test-1', vorname: 'Anna', nachname: 'Beispiel', rolle: 'Freigeberin 1', gruppen: ['test-buchhaltung'] },
  { id: 'test-2', vorname: 'Ben', nachname: 'Beispiel', rolle: 'Freigeber 2', gruppen: ['test-buchhaltung'] },
  { id: 'test-3', vorname: 'Carla', nachname: 'Beispiel', rolle: 'reicht Spesen ein', gruppen: ['test-buchhaltung'] },
  { id: 'test-4', vorname: 'Dora', nachname: 'Beispiel', rolle: 'Admin', gruppen: ['test-admin', 'test-buchhaltung'] },
  { id: 'test-5', vorname: 'Emil', nachname: 'Beispiel', rolle: 'Stellvertretung', gruppen: ['test-buchhaltung'] },
];

async function beispielPdf(titel, lieferant, betrag) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Beispielrechnung - kein echtes Dokument', { x: 60, y: 760, size: 18, font });
  page.drawText(`Lieferant: ${lieferant}`, { x: 60, y: 720, size: 12, font });
  page.drawText(`Betrag: CHF ${betrag}`, { x: 60, y: 700, size: 12, font });
  page.drawText(titel, { x: 60, y: 680, size: 12, font });
  return Buffer.from(await pdf.save());
}

let zaehler = 0;

async function legeDateiAn(config, titel, lieferant, betrag) {
  mkdirSync(config.jobsDir, { recursive: true });
  const buf = await beispielPdf(titel, lieferant, betrag);
  const pdfPfad = join(config.jobsDir, `job-test-${Date.now()}-${++zaehler}.pdf`);
  writeFileSync(pdfPfad, buf);
  return { pdfPfad, hash: createHash('sha256').update(buf).digest('hex'), buf };
}

function setzeThumbnail(db, id, pdfPfad, buf) {
  try {
    const pfad = pdfPfad.replace(/\.pdf$/, '.png');
    writeFileSync(pfad, renderFirstPageThumbnail(buf));
    setThumbnailPfad(db, id, pfad);
  } catch { /* ohne Vorschau weiter */ }
}

async function neuerJob(db, config, titel, lieferant, betrag) {
  const { pdfPfad, hash, buf } = await legeDateiAn(config, titel, lieferant, betrag);
  const id = createJob(db, {
    eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null,
    dateiname: `${titel}.pdf`, pdfPfad, dateiHash: hash,
  });
  setzeThumbnail(db, id, pdfPfad, buf);
  return { id, pdfPfad, buf, hash };
}

// Bis Freigabe 2 wie im echten Ablauf: Anna übernimmt, kontiert, Freigabe 1 wird festgehalten.
function bisFreigabe2(db, id, kontoId, lieferant, kreditorId, betrag) {
  claimJob(db, id, 'test-1');
  setKontierung(db, id, kontoId);
  updateKontierungMetadaten(db, id, {
    absender: null, betrag, zahlungsziel: '2026-12-31', rechnungsnummer: `BSP-${id}`,
    lieferant, kreditorId, typ: 'rechnung',
  });
  createFreigabe(db, { jobId: id, personId: 'test-1', rolle: 'freigeber1', zeitpunkt: new Date().toISOString(), ip: '127.0.0.1', interessenskonflikt: false });
  abschliessenFreigabe1(db, id);
}

export async function spieleBeispieldatenEin(db, testConfig) {
  for (const p of BEISPIELPERSONEN) {
    upsertPerson(db, { id: p.id, vorname: p.vorname, nachname: p.nachname, email: `${p.vorname.toLowerCase()}@beispiel.invalid`, gruppen: p.gruppen });
  }
  const konto1 = createKonto(db, { kontonummer: '3000', bezeichnung: 'Jugend', freigeber1Id: 'test-1', stellvertreter1Id: 'test-5', freigeber2Id: 'test-2', stellvertreter2Id: 'test-3' });
  const konto2 = createKonto(db, { kontonummer: '6000', bezeichnung: 'Verwaltung', freigeber1Id: 'test-1', stellvertreter1Id: 'test-5', freigeber2Id: 'test-4', stellvertreter2Id: 'test-2' });
  const k1 = createKreditor(db, { name: 'Muster Druck AG', kontoId: konto1 });
  const k2 = createKreditor(db, { name: 'Beispiel Büro GmbH', kontoId: konto2 });

  // Pool
  await neuerJob(db, testConfig, 'Rechnung im Pool', 'Muster Druck AG', '120.00');

  // zugewiesen an Anna
  const zugewiesen = await neuerJob(db, testConfig, 'Rechnung bei Anna', 'Beispiel Büro GmbH', '86.50');
  claimJob(db, zugewiesen.id, 'test-1');
  setKontierung(db, zugewiesen.id, konto2);

  // Freigabe 2 bei Ben
  const f2 = await neuerJob(db, testConfig, 'Rechnung zur Freigabe 2', 'Muster Druck AG', '450.00');
  bisFreigabe2(db, f2.id, konto1, 'Muster Druck AG', k1, '450.00');

  // abgelehnt
  const abg = await neuerJob(db, testConfig, 'Abgelehnte Rechnung', 'Beispiel Büro GmbH', '99.90');
  bisFreigabe2(db, abg.id, konto1, 'Beispiel Büro GmbH', k2, '99.90');
  const grund = 'Beispiel: Betrag stimmt nicht';
  if (ablehnenJob(db, abg.id, { abgelehntVon: 'test-2', grund })) {
    createFreigabe(db, { jobId: abg.id, personId: 'test-2', rolle: 'ablehnung', zeitpunkt: new Date().toISOString(), ip: '127.0.0.1', interessenskonflikt: false, kommentar: grund });
  }

  // abgeschlossen
  const fertig = await neuerJob(db, testConfig, 'Abgeschlossene Rechnung', 'Muster Druck AG', '300.00');
  bisFreigabe2(db, fertig.id, konto1, 'Muster Druck AG', k1, '300.00');
  createFreigabe(db, { jobId: fertig.id, personId: 'test-2', rolle: 'freigeber2', zeitpunkt: new Date().toISOString(), ip: '127.0.0.1', interessenskonflikt: false });
  abschliessenFreigabe2(db, fertig.id);

  // Spesenposition von Carla
  const now = new Date().toISOString();
  const abrId = createSpesenabrechnung(db, { eingereichtVon: 'test-3', eingereichtAm: now, titel: 'Beispiel-Spesen' });
  const sp = await legeDateiAn(testConfig, 'Spesenbeleg', 'Kiosk Beispiel', '23.40');
  const spId = createSpesenPosition(db, {
    eingangAm: now, eingereichtVon: 'test-3', kontoId: konto1, betrag: '23.40',
    auslageDatum: now.slice(0, 10), beschreibung: 'Material für den Jugendanlass',
    dateiname: 'Spesenbeleg.pdf', pdfPfad: sp.pdfPfad, thumbnailPfad: null,
    spesenabrechnungId: abrId, zugewiesenAn: 'test-1',
  });
  setzeThumbnail(db, spId, sp.pdfPfad, sp.buf);
}
