import { createHash } from 'node:crypto';
import { getJobById, listSplitKinder, pruefeSplitGruppenVollstaendigkeit } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { fetchPersonById, extractCustomFieldValue } from './churchtools.js';
import { validateSpesenPayment, ermittleRechnungsZahlung, zahlungBestaetigungspflichtig } from './paymentApproval.js';
import { einzelNachweis, belegMetadaten, kindPosition, bereiteGruppenSnapshotVor, zahlungAusSnapshot } from './exportSnapshot.js';
import { EREIGNIS_LABEL } from './auditLog.js';
import { kkHinweisFuerJob } from './kkStempel.js';

// Altfaelle: abgeschlossene, noch nicht an n8n uebergebene Belege bzw. Splitgruppen ohne
// belastbaren Freigabe-/Zahlungsnachweis. Sie bleiben fuer den Export gesperrt, bis eine
// berechtigte Person ausdruecklich entscheidet. Jeder angezeigte Wert traegt seine Herkunft;
// aktuelle Stammdaten werden nie stillschweigend als historischer Freigabestand ausgegeben.

export class AltfallError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const OFFEN_EINZEL = `SELECT * FROM jobs j WHERE j.status = 'abgeschlossen' AND j.aufgesplittet_von IS NULL
  AND NOT EXISTS (SELECT 1 FROM export_nachweise e WHERE e.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM altfall_entscheidungen a WHERE a.job_id = j.id)`;
const OFFEN_GRUPPEN = `SELECT * FROM jobs j WHERE j.status = 'aufgesplittet' AND j.aufgesplittet_von IS NULL
  AND j.gruppe_abgeholt_am IS NULL AND j.gruppe_freigabe_snapshot IS NULL
  AND NOT EXISTS (SELECT 1 FROM export_nachweise e WHERE e.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM altfall_entscheidungen a WHERE a.job_id = j.id)`;

function gruppenGrund(db, parent) {
  const { vollstaendig, kinder } = pruefeSplitGruppenVollstaendigkeit(db, parent.id);
  if (!vollstaendig) return null;
  if (parent.gruppe_pdf_pfad) return 'Splitgruppe wurde ohne Gruppen-Freigabe-Snapshot finalisiert.';
  return bereiteGruppenSnapshotVor(db, parent, kinder).nachpruefung || null;
}

function altfallFuer(db, job) {
  if (job.status === 'aufgesplittet') {
    const grund = gruppenGrund(db, job);
    return grund ? { job, gruppe: true, grund } : null;
  }
  const nachweis = einzelNachweis(db, job);
  return nachweis.exportierbar ? null : { job, gruppe: false, grund: nachweis.grund };
}

export function listAltfaelle(db) {
  return [...db.prepare(`${OFFEN_EINZEL} ORDER BY j.id`).all(), ...db.prepare(`${OFFEN_GRUPPEN} ORDER BY j.id`).all()]
    .map((job) => altfallFuer(db, job))
    .filter(Boolean);
}

export function getAltfall(db, jobId) {
  const job = db.prepare(`SELECT * FROM (${OFFEN_EINZEL} UNION ALL ${OFFEN_GRUPPEN}) WHERE id = ?`).get(jobId);
  return job ? altfallFuer(db, job) : null;
}

function parse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function freigabeBlock(db, freigabe) {
  if (!freigabe) return null;
  const person = getPersonById(db, freigabe.person_id);
  return {
    name: person ? `${person.vorname} ${person.nachname}` : 'Unbekannt', identitaet: freigabe.person_id,
    zeitpunkt: freigabe.zeitpunkt, ip: freigabe.ip, interessenskonflikt: Boolean(freigabe.interessenskonflikt), kommentar: freigabe.kommentar,
  };
}

// Position eines Teilbelegs ohne Snapshot: Werte aus dem Jobdatensatz, Konto und Namen aus dem
// aktuellen Stamm -- ausdruecklich so gekennzeichnet.
function positionAusDatensatz(db, kind) {
  const freigaben = listFreigabenByJob(db, kind.id);
  return {
    job_id: kind.id,
    nachweis_status: 'jobdatensatz',
    ...belegMetadaten(kind, getKontoById(db, kind.konto_id)),
    datei_sha256: kind.zeitstempel_datei_hash || kind.final_datei_hash || null,
    freigeber1: freigabeBlock(db, freigaben.findLast((f) => f.rolle === 'freigeber1')),
    freigeber2: freigabeBlock(db, freigaben.findLast((f) => f.rolle === 'freigeber2')),
    kkHinweis: kkHinweisFuerJob(db, kind),
    verlauf: freigaben.map((f) => ({ rolleLabel: EREIGNIS_LABEL[f.rolle] || f.rolle, ...freigabeBlock(db, f) })),
  };
}

async function spesenZahlung(config, job, snapshot) {
  if (snapshot?.zahlungsdaten) {
    return { zahlung: { art: 'spesen', daten: snapshot.zahlungsdaten, abgleich: null, hinweise: [] }, herkunft: 'freigabe_snapshot_unbestaetigt' };
  }
  try {
    const person = await fetchPersonById(config.churchtools, config.churchtools.syncServiceToken, job.eingereicht_von);
    const daten = validateSpesenPayment(
      extractCustomFieldValue(person, config.churchtools.customFieldIban),
      extractCustomFieldValue(person, config.churchtools.customFieldKontoinhaber),
    );
    if (daten) return { zahlung: { art: 'spesen', daten, abgleich: null, hinweise: [] }, herkunft: 'churchtools_aktuell' };
  } catch {
    // An unavailable or incomplete master record only allows the archive-only decision.
  }
  return { zahlung: { art: 'spesen', daten: null, abgleich: null, hinweise: [] }, herkunft: 'nicht_verfuegbar', fehler: 'Aktuelle ChurchTools-Zahlungsdaten sind nicht abrufbar oder ungueltig.' };
}

// Stand, der der entscheidenden Person gezeigt wird. Asynchron, weil Spesen ohne eingefrorene
// Zahlungsdaten nur mit einem ausdruecklich gekennzeichneten aktuellen ChurchTools-Stand
// nachbestaetigt werden koennen.
export async function altfallAnzeige(db, config, altfall) {
  const { job } = altfall;
  let daten;
  let fehler = null;
  if (altfall.gruppe) {
    const kinder = listSplitKinder(db, job.id).filter((kind) => kind.status !== 'geloescht');
    const zahlung = ermittleRechnungsZahlung(db, job);
    daten = {
      version: 1,
      metadaten: { ...belegMetadaten(job, null), konto_id: null, position: null, anzahl_positionen: kinder.length },
      positionen: kinder.map((kind) => {
        const snapshot = parse(kind.freigabe_snapshot);
        return snapshot?.job ? kindPosition(kind, snapshot) : positionAusDatensatz(db, kind);
      }),
      zahlung: zahlung.fehler ? null : { art: zahlung.art, daten: zahlung.daten, abgleich: zahlung.abgleich, hinweise: zahlung.hinweise },
      herkunft: {
        metadaten: 'jobdatensatz',
        positionen: kinder.map((kind) => (parse(kind.freigabe_snapshot)?.job ? 'freigabe_snapshot' : 'jobdatensatz_und_aktueller_stamm')),
        zahlung: zahlung.art === 'qr_rechnung' ? 'qr_scan_eingang' : null,
        iban_abgleich: zahlung.abgleich ? 'lieferanten_iban_aktuell' : null,
      },
    };
  } else {
    const snapshot = parse(job.freigabe_snapshot);
    const basis = snapshot?.job || job;
    const konto = snapshot?.job ? snapshot.konto : getKontoById(db, job.konto_id);
    let zahlung;
    let zahlungHerkunft = null;
    if (basis.quelle === 'spesen') {
      const ergebnis = await spesenZahlung(config, basis, snapshot);
      zahlung = ergebnis.zahlung;
      zahlungHerkunft = ergebnis.herkunft;
      fehler = ergebnis.fehler || null;
    } else if (snapshot?.job) {
      const { bestaetigung, ...rest } = zahlungAusSnapshot(snapshot);
      zahlung = rest;
      zahlungHerkunft = zahlung.daten ? 'freigabe_snapshot_unbestaetigt' : null;
    } else {
      const ergebnis = ermittleRechnungsZahlung(db, job);
      zahlung = { art: ergebnis.art, daten: ergebnis.daten, abgleich: ergebnis.abgleich, hinweise: ergebnis.hinweise };
      zahlungHerkunft = zahlung.daten ? 'qr_scan_eingang' : null;
    }
    daten = {
      version: 1,
      metadaten: belegMetadaten(basis, konto),
      zahlung,
      herkunft: {
        metadaten: snapshot?.job ? 'freigabe_snapshot' : 'jobdatensatz',
        konto: snapshot?.job ? 'freigabe_snapshot' : 'kontenstamm_aktuell',
        zahlung: zahlungHerkunft,
      },
    };
  }
  const zahlungNoetig = Boolean(daten.zahlung) && zahlungBestaetigungspflichtig(daten.zahlung);
  return {
    ...altfall,
    kinderStand: altfall.gruppe ? JSON.stringify(listSplitKinder(db, job.id)) : null,
    daten,
    fehler,
    nachbestaetigbar: !fehler && (!zahlungNoetig || Boolean(daten.zahlung?.daten) || daten.zahlung?.art === 'ohne_zahlungsdaten'),
  };
}

export function altfallStand(jobId, daten, personId) {
  return createHash('sha256').update(JSON.stringify({ jobId, daten, personId })).digest('hex');
}

// Speichert die Entscheidung genau fuer den angezeigten Stand. Die Pruefung, ob der Fall noch
// offen ist, und das Einfuegen laufen in einer Transaktion; eine zweite Entscheidung scheitert.
export function entscheideAltfall(db, { anzeige, entscheidung, stand, begruendung, person }) {
  if (entscheidung !== 'nachbestaetigt' && entscheidung !== 'nur_archiv') throw new AltfallError(400, 'Bitte eine Entscheidung waehlen.');
  const text = typeof begruendung === 'string' ? begruendung.trim() : '';
  if (!text || text.length > 2000) throw new AltfallError(400, 'Eine Begruendung (hoechstens 2000 Zeichen) ist Pflicht.');
  if (entscheidung === 'nachbestaetigt' && !anzeige.nachbestaetigbar) {
    throw new AltfallError(400, 'Ohne verwendbare Zahlungsdaten ist nur "Nur archivieren, keine Zahlung" moeglich.');
  }
  // Wer die Spesen selbst eingereicht hat, bestaetigt nicht die eigene Auszahlung.
  if (!anzeige.gruppe && anzeige.job.quelle === 'spesen' && anzeige.job.eingereicht_von === person.churchtools_person_id) {
    throw new AltfallError(403, 'Eigene Spesen koennen nicht selbst entschieden werden.');
  }
  if (stand !== altfallStand(anzeige.job.id, anzeige.daten, person.churchtools_person_id)) {
    throw new AltfallError(409, 'Der angezeigte Stand hat sich geaendert. Bitte erneut pruefen.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const aktuell = getAltfall(db, anzeige.job.id);
    if (!aktuell || JSON.stringify(getJobById(db, anzeige.job.id)) !== JSON.stringify(anzeige.job)) {
      throw new AltfallError(409, 'Dieser Fall wurde inzwischen entschieden, exportiert oder geaendert.');
    }
    if (anzeige.gruppe && JSON.stringify(listSplitKinder(db, anzeige.job.id)) !== anzeige.kinderStand) {
      throw new AltfallError(409, 'Die Splitgruppe wurde inzwischen geaendert.');
    }
    const zeitpunkt = new Date().toISOString();
    const result = db.prepare(`INSERT INTO altfall_entscheidungen
      (job_id, entscheidung, angezeigte_daten, stand, person_id, person_name, begruendung, zeitpunkt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      anzeige.job.id, entscheidung, JSON.stringify(anzeige.daten), stand, person.churchtools_person_id,
      `${person.vorname} ${person.nachname}`, text, zeitpunkt,
    );
    db.exec('COMMIT');
    return { id: Number(result.lastInsertRowid), zeitpunkt };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
