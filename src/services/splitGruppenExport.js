import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { getJobById, pruefeSplitGruppenVollstaendigkeit, markGruppeExportiert } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampGruppenDokument } from './pdfStamp.js';
import { setZeitstempel } from './zeitstempel.js';

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
async function haengeBelegSeitenAn(gruppenDoc, kindPdfPfad, basisSeitenzahl, belegSeitenzahl) {
  if (!belegSeitenzahl) return;
  const kindDoc = await PDFDocument.load(readFileSync(kindPdfPfad));
  const belegIndices = kindDoc.getPageIndices().slice(basisSeitenzahl, basisSeitenzahl + belegSeitenzahl);
  const copiedPages = await gruppenDoc.copyPages(kindDoc, belegIndices);
  copiedPages.forEach((page) => gruppenDoc.addPage(page));
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
export async function pruefeUndFinalisiereSplitGruppe(db, parentJobId) {
  const parent = getJobById(db, parentJobId);
  if (!parent || parent.gruppe_pdf_pfad) return { status: 'uebersprungen' };

  const { vollstaendig, blockiert, kinder } = pruefeSplitGruppenVollstaendigkeit(db, parentJobId);
  if (blockiert) return { status: 'blockiert' };
  if (!vollstaendig) return { status: 'unvollstaendig' };

  try {
    const basisBuffer = readFileSync(parent.pdf_pfad);
    const basisDoc = await PDFDocument.load(basisBuffer);
    const basisSeitenzahl = basisDoc.getPageCount();
    const gruppenDoc = await PDFDocument.load(basisBuffer);

    const positionen = [];
    const verlauf = [];
    for (const kind of kinder) {
      const konto = getKontoById(db, kind.konto_id);
      const freigaben = listFreigabenByJob(db, kind.id);
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigabe2 = freigaben.findLast((f) => f.rolle === 'freigeber2');

      positionen.push({
        kontoNummer: konto.kontonummer,
        kontoBezeichnung: konto.bezeichnung,
        betrag: kind.betrag,
        position: kind.rechnungsposition,
        freigeber1: buildFreigabeEintrag(getPersonById(db, freigabe1.person_id), freigabe1),
        freigeber2: buildFreigabeEintrag(getPersonById(db, freigabe2.person_id), freigabe2),
      });

      const praefix = `Konto ${konto.kontonummer}${kind.rechnungsposition ? ` (Pos. ${kind.rechnungsposition})` : ''}`;
      for (const f of freigaben) {
        const person = getPersonById(db, f.person_id);
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

      await haengeBelegSeitenAn(gruppenDoc, kind.pdf_pfad, basisSeitenzahl, kind.beleg_seitenzahl);
    }
    verlauf.sort((a, b) => (a.zeitpunkt < b.zeitpunkt ? -1 : a.zeitpunkt > b.zeitpunkt ? 1 : 0));

    const gruppenPdfMitBelegen = Buffer.from(await gruppenDoc.save());
    let gestempelt = await stampGruppenDokument(gruppenPdfMitBelegen, { jobId: parent.id, positionen, verlauf });

    let zeitstempelGesetztAm = null;
    let zeitstempelDateiHash = null;
    const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
    if (tsaUrl) {
      gestempelt = await setZeitstempel(gestempelt, {
        url: tsaUrl,
        user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
        passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
      });
      zeitstempelGesetztAm = new Date().toISOString();
      zeitstempelDateiHash = createHash('sha256').update(gestempelt).digest('hex');
    }

    // Dateiname wird frisch gebaut (Verzeichnis des Elternjobs + eigene UUID) statt per Regex aus
    // parent.pdf_pfad abgeleitet: ein `.replace(/\.pdf$/, ...)` liefert bei einem Pfad ohne
    // .pdf-Endung den Originalpfad unverändert zurück -- und renameSync würde dann die
    // Original-Rechnung mit dem Gruppen-Dokument überschreiben.
    const zielPfad = join(dirname(parent.pdf_pfad), `gruppe-${randomUUID()}.pdf`);
    const tmpPfad = `${zielPfad}.tmp`;
    writeFileSync(tmpPfad, gestempelt);
    renameSync(tmpPfad, zielPfad);

    // Zwischen der Frühabbruch-Prüfung oben (parent.gruppe_pdf_pfad) und diesem Schreibvorgang
    // liegen mehrere awaits -- zwei gleichzeitige Auslöser (Nachhol-Cron-Job und Freigabe-2-
    // Abschluss) können also beide bis hierher kommen. markGruppeExportiert schreibt nur, solange
    // gruppe_pdf_pfad noch NULL ist; der Verlierer räumt seine eigene, nun verwaiste Datei weg.
    const geschrieben = markGruppeExportiert(db, parent.id, { pdfPfad: zielPfad, zeitstempelGesetztAm, zeitstempelDateiHash });
    if (!geschrieben) {
      try {
        unlinkSync(zielPfad);
      } catch (err) {
        console.error(`Aufräumen der verwaisten Gruppen-PDF ${zielPfad} fehlgeschlagen:`, err.message);
      }
      return { status: 'uebersprungen' };
    }
    return { status: 'exportiert', pdfPfad: zielPfad };
  } catch (err) {
    console.error(`Splitgruppen-Export für Elternjob ${parentJobId} fehlgeschlagen, wird nachgeholt:`, err.message);
    return { status: 'fehler', error: err.message };
  }
}
