import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { getJobById, pruefeSplitGruppenVollstaendigkeit, markGruppeExportiert } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampGruppenDokument } from './pdfStamp.js';
import { setZeitstempel } from './zeitstempel.js';
import { kkHinweisFuerJob } from './kkStempel.js';
import { writeFinalDocument } from './finalDocument.js';
import { tsaTrustOptions } from './tsaTrust.js';

const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1',
  freigeber2: 'Freigabe 2',
  ablehnung: 'Ablehnung',
  freigabe1_eskalation: 'Eskalation Freigabe 1',
  freigabe2_eskalation: 'Eskalation Freigabe 2',
  iban_abweichung: 'IBAN-Abweichung',
};

function buildFreigabeEintrag(person, freigabe) {
  return {
    name: `${person.vorname} ${person.nachname}`,
    identitaet: person.churchtools_person_id,
    zeitpunkt: freigabe.zeitpunkt,
    ip: freigabe.ip,
    interessenskonflikt: Boolean(freigabe.interessenskonflikt),
    kommentar: freigabe.kommentar,
  };
}

// mergeBelegFuerJob (Aufsplitten time, kontierung.js) always inserts Beleg pages directly
// after the invoice pages, before any later stamping -- so with a known Beleg page count
// recorded at that time (kind.beleg_seitenzahl), the Beleg pages are always exactly
// [basisSeitenzahl, basisSeitenzahl + belegSeitenzahl), regardless of how many stamp/Verlauf
// pages a later Freigabe-2 completion appended after them.
//
// Deriving the range from the Kind-PDF's current page count instead (as an earlier version did)
// is wrong: by the time a group merge runs, every Kind has already been individually stamped by
// freigabe2.js, so the page-count delta would drag each Kind's own redundant Stempelseite into
// the combined archival document -- exactly what this feature exists to avoid.
async function haengeBelegSeitenAn(gruppenDoc, kindBytes, basisSeitenzahl, belegSeitenzahl) {
  if (!belegSeitenzahl) return;
  const kindDoc = await PDFDocument.load(kindBytes);
  if (!Number.isInteger(belegSeitenzahl) || belegSeitenzahl < 0 || basisSeitenzahl + belegSeitenzahl > kindDoc.getPageCount()) {
    throw new Error('Die gespeicherte Belegseitenzahl passt nicht zum Teilbeleg.');
  }
  const belegIndices = kindDoc.getPageIndices().slice(basisSeitenzahl, basisSeitenzahl + belegSeitenzahl);
  const copiedPages = await gruppenDoc.copyPages(kindDoc, belegIndices);
  copiedPages.forEach((page) => gruppenDoc.addPage(page));
}

function groupState(db, parentJobId) {
  const completeness = pruefeSplitGruppenVollstaendigkeit(db, parentJobId);
  return {
    parent: getJobById(db, parentJobId),
    ...completeness,
    details: completeness.kinder.map((kind) => ({
      konto: getKontoById(db, kind.konto_id),
      freigaben: listFreigabenByJob(db, kind.id).map((freigabe) => ({ ...freigabe, person: getPersonById(db, freigabe.person_id) })),
    })),
  };
}

// Merges a complete Splitgruppe (alle Kinder abgeschlossen) into one stamped, zeitgestempelten
// PDF and records it on the Elternjob. Best-effort and idempotent by construction: no-ops
// whenever the group is not (yet) complete, is blocked by a rejected sibling, or has already been
// exported (gruppe_pdf_pfad already set) -- safe to call repeatedly from multiple trigger points
// (Freigabe-2-Abschluss, Löschung einer blockierenden Zeile, der Nachhol-Cron-Job).
//
// Deliberately DOES block the whole export on a configured-but-unreachable TSA (unlike
// freigabe2.js's per-job stampAndFinalize, which proceeds without a Zeitstempel on TSA failure):
// this merged document's entire purpose is the paperless archival copy handed to Paperless-ngx,
// so shipping it without the Zeitstempel it was built for would defeat that purpose. Retried
// later by the split-gruppen-nachholen cron job (cronJobs.js) exactly because gruppe_pdf_pfad
// stays unset on failure.
export async function pruefeUndFinalisiereSplitGruppe(db, parentJobId, config = {}) {
  let parent = getJobById(db, parentJobId);
  if (!parent || parent.status !== 'aufgesplittet' || parent.gruppe_pdf_pfad) return { status: 'uebersprungen' };

  const { vollstaendig, blockiert, kinder } = pruefeSplitGruppenVollstaendigkeit(db, parentJobId);
  let zielPfad;
  try {
    const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
    // Persist before network/file work so failure followed by disabling TSA cannot downgrade it.
    if (!parent.zeitstempel_erforderlich && (tsaUrl || kinder.some((kind) => kind.zeitstempel_erforderlich))) {
      db.prepare('UPDATE jobs SET zeitstempel_erforderlich = 1 WHERE id = ?').run(parent.id);
      parent = getJobById(db, parent.id);
    }
    if (blockiert) return { status: 'blockiert' };
    if (!vollstaendig) return { status: 'unvollstaendig' };
    if (parent.zeitstempel_erforderlich && !tsaUrl) throw new Error('Zeitstempel ist verpflichtend; TSA muss wieder konfiguriert werden.');
    const state = groupState(db, parentJobId);
    const basisBuffer = readFileSync(parent.pdf_pfad);
    const kindBuffers = kinder.map((kind) => {
      const bytes = readFileSync(kind.pdf_pfad);
      const expected = kind.zeitstempel_datei_hash || kind.final_datei_hash;
      if (expected && createHash('sha256').update(bytes).digest('hex') !== expected) {
        throw new Error('Teilbeleg stimmt nicht mit seinem Freigabe-Hash ueberein.');
      }
      return bytes;
    });
    const basisDoc = await PDFDocument.load(basisBuffer);
    const basisSeitenzahl = basisDoc.getPageCount();
    const gruppenDoc = await PDFDocument.load(basisBuffer);

    const positionen = [];
    const verlauf = [];
    for (const [index, kind] of kinder.entries()) {
      const snapshot = kind.freigabe_snapshot ? JSON.parse(kind.freigabe_snapshot) : null;
      const konto = snapshot?.konto || state.details[index].konto;
      const freigaben = state.details[index].freigaben;
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigabe2 = freigaben.findLast((f) => f.rolle === 'freigeber2');

      positionen.push({
        kontoNummer: konto.kontonummer,
        kontoBezeichnung: konto.bezeichnung,
        betrag: kind.betrag,
        typ: kind.typ,
        position: kind.rechnungsposition,
        // Wie freigeber1/2: der bei Freigabe 2 eingefrorene Hinweis hat Vorrang vor dem Live-Wert.
        kkHinweis: snapshot?.stampData && 'kkHinweis' in snapshot.stampData ? snapshot.stampData.kkHinweis : kkHinweisFuerJob(db, kind),
        freigeber1: snapshot?.stampData.freigeber1 || buildFreigabeEintrag(freigabe1.person, freigabe1),
        freigeber2: snapshot?.stampData.freigeber2 || buildFreigabeEintrag(freigabe2.person, freigabe2),
      });

      const praefix = `Konto ${konto.kontonummer}${kind.rechnungsposition ? ` (Pos. ${kind.rechnungsposition})` : ''}`;
      for (const f of freigaben) {
        const person = f.person;
        verlauf.push({
          rolleLabel: `${praefix} — ${EREIGNIS_LABEL[f.rolle] || f.rolle}`,
          name: `${person.vorname} ${person.nachname}`,
          identitaet: f.person_id,
          zeitpunkt: f.zeitpunkt,
          ip: f.ip,
          interessenskonflikt: Boolean(f.interessenskonflikt),
          kommentar: f.kommentar,
        });
      }

      await haengeBelegSeitenAn(gruppenDoc, kindBuffers[index], basisSeitenzahl, kind.beleg_seitenzahl);
    }
    verlauf.sort((a, b) => (a.zeitpunkt < b.zeitpunkt ? -1 : a.zeitpunkt > b.zeitpunkt ? 1 : 0));

    const gruppenPdfMitBelegen = Buffer.from(await gruppenDoc.save());
    let gestempelt = await stampGruppenDokument(gruppenPdfMitBelegen, { jobId: parent.id, positionen, verlauf });

    let zeitstempelGesetztAm = null;
    let zeitstempelDateiHash = null;
    if (tsaUrl) {
      gestempelt = await setZeitstempel(gestempelt, {
        ...tsaTrustOptions(config),
        url: tsaUrl,
        user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
        passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
      });
      zeitstempelGesetztAm = new Date().toISOString();
      zeitstempelDateiHash = createHash('sha256').update(gestempelt).digest('hex');
    }

    zielPfad = writeFinalDocument(parent.pdf_pfad, gestempelt);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getJobById(db, parent.id)?.gruppe_pdf_pfad) {
        db.exec('ROLLBACK');
        unlinkSync(zielPfad);
        zielPfad = undefined;
        return { status: 'uebersprungen' };
      }
      if (JSON.stringify(groupState(db, parent.id)) !== JSON.stringify(state) ||
          getConfigValue(db, 'zeitstempel_tsa_url') !== tsaUrl ||
          !readFileSync(parent.pdf_pfad).equals(basisBuffer) ||
          kinder.some((kind, index) => !readFileSync(kind.pdf_pfad).equals(kindBuffers[index]))) {
        throw new Error('Gruppenstand oder Quelldateien wurden waehrend der Finalisierung geaendert.');
      }
      if (db.prepare('SELECT 1 FROM export_nachweise WHERE job_id = ?').get(parent.id)) throw new Error('Archivexport wurde bereits festgeschrieben.');
      const geschrieben = markGruppeExportiert(db, parent.id, {
        pdfPfad: zielPfad, zeitstempelGesetztAm, zeitstempelDateiHash,
        finalDateiHash: createHash('sha256').update(gestempelt).digest('hex'),
      });
      if (!geschrieben) throw new Error('Gruppe wurde inzwischen finalisiert.');
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
    const pdfPfad = zielPfad;
    zielPfad = undefined;
    return { status: 'exportiert', pdfPfad };
  } catch (err) {
    if (zielPfad) {
      try { unlinkSync(zielPfad); } catch { /* Never remove any other attempt's file. */ }
    }
    console.error(`Splitgruppen-Export für Elternjob ${parentJobId} fehlgeschlagen, wird nachgeholt:`, err.message);
    return { status: 'fehler', error: err.message };
  }
}
