import { getJobById } from '../../src/db/jobsRepo.js';
import { getKontoById } from '../../src/db/kontenRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { getPersonById } from '../../src/db/personenRepo.js';
import { ermittleRechnungsZahlung, zahlungBestaetigungspflichtig } from '../../src/services/paymentApproval.js';

// Test fixture: freezes a job's current row as the version-2 Freigabe-2 snapshot, exactly as
// freigabe2.js would, including the explicit payment confirmation where one is required. Tests
// that seed an 'abgeschlossen' job directly use this so the export sees an approved state.
export function setzeFreigabeSnapshot(db, jobId, { personId = '3', zeitpunkt = '2026-08-15T09:00:00.000Z', zahlungsdaten = null, bestaetigt = true } = {}) {
  const job = getJobById(db, jobId);
  const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
  let zahlung;
  if (job.quelle === 'spesen') {
    zahlung = { art: 'spesen', daten: zahlungsdaten, abgleich: null, hinweise: [] };
  } else {
    const parent = job.aufgesplittet_von ? getJobById(db, job.aufgesplittet_von) : null;
    zahlung = ermittleRechnungsZahlung(db, job, parent);
  }
  const bestaetigung = zahlungBestaetigungspflichtig(zahlung) && bestaetigt ? { person_id: personId, zeitpunkt, stand: 'test' } : null;
  const freigaben = listFreigabenByJob(db, jobId).map((f) => {
    const person = getPersonById(db, f.person_id);
    return { ...f, name: person ? `${person.vorname} ${person.nachname}` : `Person ${f.person_id}` };
  });
  const block = (f) => ({
    name: f?.name ?? 'Unbekannt', identitaet: f?.person_id ?? null, zeitpunkt: f?.zeitpunkt ?? zeitpunkt,
    ip: f?.ip ?? null, interessenskonflikt: Boolean(f?.interessenskonflikt), kommentar: f?.kommentar ?? null,
  });
  const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
  const freigabe2 = freigaben.findLast((f) => f.rolle === 'freigeber2');
  const snapshot = {
    version: 2, job, konto,
    zahlungsdaten: job.quelle === 'spesen' ? zahlungsdaten : null,
    stampData: {
      jobId, konto: konto ? { nummer: konto.kontonummer, bezeichnung: konto.bezeichnung } : null,
      zahlungsdaten: job.quelle === 'spesen' ? zahlungsdaten : zahlung.daten,
      kkHinweis: null,
      freigeber1: block(freigabe1), freigeber2: block(freigabe2),
      verlauf: freigaben.map((f) => ({ rolleLabel: f.rolle === 'freigeber1' ? 'Freigabe 1' : f.rolle === 'freigeber2' ? 'Freigabe 2' : f.rolle, ...block(f) })),
    },
    zahlungsdaten_bestaetigung: job.quelle === 'spesen' && bestaetigung ? { personId, zeitpunkt, stand: 'test' } : null,
    zahlung: { ...zahlung, bestaetigung },
  };
  db.prepare('UPDATE jobs SET freigabe_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), jobId);
  return snapshot;
}

// Fixture for a group finalized outside pruefeUndFinalisiereSplitGruppe (markGruppeExportiert
// directly): freezes its children and stores the group snapshot the real finalization would write.
export async function setzeGruppenSnapshot(db, parentId, options = {}) {
  const { listSplitKinder } = await import('../../src/db/jobsRepo.js');
  const { bereiteGruppenSnapshotVor } = await import('../../src/services/exportSnapshot.js');
  const kinder = listSplitKinder(db, parentId).filter((kind) => kind.status !== 'geloescht');
  for (const kind of kinder) if (!kind.freigabe_snapshot) setzeFreigabeSnapshot(db, kind.id, options);
  const vorbereitung = bereiteGruppenSnapshotVor(db, getJobById(db, parentId), listSplitKinder(db, parentId).filter((kind) => kind.status !== 'geloescht'));
  if (vorbereitung.nachpruefung) throw new Error(vorbereitung.nachpruefung);
  db.prepare('UPDATE jobs SET gruppe_freigabe_snapshot = ? WHERE id = ?').run(JSON.stringify(vorbereitung.snapshot), parentId);
  return vorbereitung.snapshot;
}

// Freezes every directly seeded, completed job and finalized group that has no evidence yet.
export async function freigabeSnapshotsFuerTest(db, options = {}) {
  for (const { id } of db.prepare("SELECT id FROM jobs WHERE status IN ('abgeschlossen', 'abgeholt', 'archiviert') AND freigabe_snapshot IS NULL").all()) {
    setzeFreigabeSnapshot(db, id, options);
  }
  for (const { id } of db.prepare("SELECT id FROM jobs WHERE gruppe_pdf_pfad IS NOT NULL AND gruppe_freigabe_snapshot IS NULL").all()) {
    await setzeGruppenSnapshot(db, id, options);
  }
}
