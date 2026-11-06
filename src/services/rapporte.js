// Rapporte: Dokumente, die nur zur Kenntnis weitergegeben werden (kein Rechnungsweg).
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getJobById, markZeitstempelGesetzt } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listAllPersons, getPersonById } from '../db/personenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import {
  markiereAlsRapport,
  hebeRapportMarkierungAuf,
  bestaetigeKenntnisnahme,
  schliesseRapportAbWennVollstaendig,
  listKenntnisnahmen,
  listOffeneKenntnisnahmen,
  listRapportIdsZumAbschliessen,
} from '../db/rapporteRepo.js';
import { stampKenntnisnahme } from './pdfStamp.js';
import { setZeitstempelMitNachweis } from './zeitstempel.js';
import { speichereTsaNachweis } from './tsaNachweis.js';
import { tsaTrustOptions } from './tsaTrust.js';
import { writeFinalDocument } from './finalDocument.js';
import { listeKommentare } from './kommentare.js';
import { reiheBenachrichtigungEin } from './notify.js';
import { stelleEintraegeZu } from './mailZustellung.js';
import { personHasPermission } from '../middleware/permissions.js';

export const MAX_BEMERKUNG_LAENGE = 2000;

function name(person) {
  return `${person.vorname} ${person.nachname}`;
}

export function istRapportModulAktiv(db) {
  return getConfigValue(db, 'modul_rapporte_aktiv') === '1';
}

export function listRapportEmpfaengerKandidaten(db) {
  return listAllPersons(db).filter((p) => p.aktiv && !p.ct_person_unresolved);
}

function istZulaessig(db, job) {
  if (!['scanner', 'lieferant'].includes(job.quelle)) return false;
  if (job.aufgesplittet_von || job.kreditkarte_id) return false;
  return !db.prepare('SELECT 1 FROM jobs WHERE aufgesplittet_von = ? LIMIT 1').get(job.id);
}

export async function markiereRapport(db, config, mailer, { job, person, empfaengerIds, bemerkung, ip }) {
  if (!istRapportModulAktiv(db)) return { ok: false, status: 409, fehler: 'Das Rapporte-Modul ist derzeit deaktiviert.' };
  if (!istZulaessig(db, job)) return { ok: false, status: 409, fehler: 'Dieser Vorgang kann nicht als Rapport weitergegeben werden.' };
  const text = (bemerkung || '').trim();
  if (text.length > MAX_BEMERKUNG_LAENGE) {
    return { ok: false, status: 400, fehler: `Die Bemerkung darf höchstens ${MAX_BEMERKUNG_LAENGE} Zeichen lang sein.` };
  }
  const gewaehlt = new Set([].concat(empfaengerIds ?? []).map(String));
  const empfaenger = listRapportEmpfaengerKandidaten(db).filter((p) => gewaehlt.has(p.churchtools_person_id));
  if (empfaenger.length === 0) return { ok: false, status: 400, fehler: 'Bitte mindestens eine Empfängerin oder einen Empfänger wählen.' };

  const zeitpunkt = new Date().toISOString();
  const markierer = person.churchtools_person_id;
  let eintraege;
  db.exec('BEGIN');
  try {
    const ok = markiereAlsRapport(db, job.id, {
      markiertVon: markierer,
      empfaengerIds: empfaenger.map((p) => p.churchtools_person_id),
      bemerkung: text || null,
      zeitpunkt,
    });
    if (!ok) {
      db.exec('ROLLBACK');
      return { ok: false, status: 409, fehler: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' };
    }
    createFreigabe(db, {
      jobId: job.id, personId: markierer, rolle: 'rapport_markiert', zeitpunkt, ip,
      interessenskonflikt: false, kommentar: empfaenger.map(name).join(', '), eskaliertVon: null,
    });
    eintraege = empfaenger.map((p) =>
      reiheBenachrichtigungEin(db, {
        to: p.email,
        typ: 'rapport-zuweisung',
        jobId: job.id,
        variablen: {
          empfaengerName: name(p),
          jobDateiname: job.dateiname,
          markiertVon: name(person),
          bemerkung: text,
          link: `${config.publicBaseUrl}/rapporte/${job.id}`,
        },
      })
    );
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  // Nach dem Commit zustellen: scheitert SMTP, bleibt die Markierung gueltig (Mail-Outbox wiederholt).
  await stelleEintraegeZu(db, mailer, eintraege);
  return { ok: true };
}

export async function hebeRapportAuf(db, config, { jobId, person, ip }) {
  const job = getJobById(db, jobId);
  if (!job || job.status !== 'kenntnisnahme') {
    return { ok: false, status: 409, fehler: 'Dieser Rapport ist nicht (mehr) zur Kenntnis weitergegeben.' };
  }
  const darf = job.rapport_markiert_von === person.churchtools_person_id || personHasPermission(db, config, person, 'workflow_eingreifen');
  if (!darf) return { ok: false, status: 403, fehler: 'Nur die markierende Person oder eine Person mit Eingriffsrecht darf die Markierung aufheben.' };
  db.exec('BEGIN');
  try {
    if (!hebeRapportMarkierungAuf(db, jobId)) {
      db.exec('ROLLBACK');
      return { ok: false, status: 409, fehler: 'Die Markierung kann nicht mehr aufgehoben werden: es liegt bereits eine Bestätigung vor.' };
    }
    createFreigabe(db, {
      jobId, personId: person.churchtools_person_id, rolle: 'rapport_markierung_aufgehoben',
      zeitpunkt: new Date().toISOString(), ip, interessenskonflikt: false, kommentar: null, eskaliertVon: null,
    });
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true };
}

// Kenntnisnahme-Zeilen der aktuellen Markierung: Zeilen einer früher aufgehobenen Markierung
// (zugeteilt vor rapport_markiert_am) gehören nicht dazu. Ersatz-Zeilen sind jünger, zählen also mit.
export function aktuelleKenntnisnahmen(db, job) {
  return listKenntnisnahmen(db, job.id).filter((k) => !job.rapport_markiert_am || k.zugeteilt_am >= job.rapport_markiert_am);
}

function personNameOder(db, personId) {
  const p = personId ? getPersonById(db, personId) : null;
  return p ? name(p) : personId ? `Unbekannte Person (${personId})` : null;
}

function kommentarStand(kommentare) {
  return `${kommentare.length}:${kommentare.at(-1)?.id ?? 0}`;
}

const MAX_FINALISIERUNGSVERSUCHE = 3;

// Schliesst einen vollständig zur Kenntnis genommenen Rapport ab (0 offen, ≥1 bestätigt -- auch
// wenn der letzte offene Empfänger entfernt wurde): Vermerk stempeln, TSA ausserhalb der
// Transaktion, finales Dokument schreiben, dann geschützt abschliessen. true = dieser Aufruf hat
// abgeschlossen; false = nichts zu tun oder ein paralleler Aufruf war schneller (dessen tmp-Datei
// räumt der Verlierer selbst weg). Wirft bei Stempel-/Schreibfehlern; der Rapport bleibt dann
// 'kenntnisnahme' mit 0 offen und wird später nachgeholt. Geht während Stempel/TSA ein Kommentar
// ein, wird neu gestempelt (sonst fehlte er auf dem archivierten PDF).
export async function finalisiereRapport(db, config, jobId) {
  for (let versuch = 1; versuch <= MAX_FINALISIERUNGSVERSUCHE; versuch++) {
    const ergebnis = await finalisiereRapportEinmal(db, config, jobId);
    if (ergebnis !== 'kommentar_neu') return ergebnis;
  }
  console.error(`Rapport ${jobId}: Abschluss nach ${MAX_FINALISIERUNGSVERSUCHE} Versuchen wegen neuer Kommentare verschoben.`);
  return false;
}

async function finalisiereRapportEinmal(db, config, jobId) {
  const job = getJobById(db, jobId);
  if (!job || job.typ !== 'rapport' || job.status !== 'kenntnisnahme') return false;
  if (listOffeneKenntnisnahmen(db, jobId).length > 0) return false;
  const zeilen = aktuelleKenntnisnahmen(db, job);
  if (!zeilen.some((k) => k.bestaetigt_am)) return false;

  const nachId = new Map(zeilen.map((k) => [k.id, k]));
  const kommentare = listeKommentare(db, jobId);
  const stand = kommentarStand(kommentare);
  const pdfBuffer = readFileSync(job.pdf_pfad);
  let stamped = await stampKenntnisnahme(pdfBuffer, {
    ...(config.testmodus ? { testmodus: true } : {}),
    jobId,
    markiertVon: { name: personNameOder(db, job.rapport_markiert_von), zeitpunkt: job.rapport_markiert_am },
    bemerkung: job.rapport_bemerkung,
    kenntnisnahmen: zeilen.map((k) => ({
      name: personNameOder(db, k.person_id),
      bestaetigtAm: k.bestaetigt_am,
      entferntAm: k.entfernt_am,
      entferntVon: personNameOder(db, k.entfernt_von),
      begruendung: k.begruendung,
      ersetztDurch: k.ersetzt_durch_id ? personNameOder(db, nachId.get(k.ersetzt_durch_id)?.person_id) : null,
    })),
    kommentare: kommentare.map((k) => ({ zeitpunkt: k.erstellt_am, verfasser: k.verfasser_name, text: k.text })),
  });

  // TSA-I/O ausserhalb der Transaktion (wie Freigabe 2). Bei Ausfall bleibt zeitstempel_erforderlich
  // gesetzt, die Abholung wartet, bis zeitstempel-nachholen erfolgreich war.
  const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
  let zeitstempelGesetztAm = null;
  let zeitstempelDateiHash = null;
  let tsaNachweis = null;
  if (tsaUrl) {
    try {
      ({ stamped, nachweis: tsaNachweis } = await setZeitstempelMitNachweis(stamped, {
        ...tsaTrustOptions(config),
        url: tsaUrl,
        user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
        passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
      }));
      zeitstempelGesetztAm = new Date().toISOString();
      zeitstempelDateiHash = createHash('sha256').update(stamped).digest('hex');
    } catch (err) {
      console.error(`Zeitstempel für Rapport ${jobId} fehlgeschlagen, wird nachgeholt:`, err.message);
    }
  }

  const tmpPfad = writeFinalDocument(job.pdf_pfad, stamped);
  const verwerfen = () => {
    try { unlinkSync(tmpPfad); } catch { /* best-effort: tmp-Datei des unterlegenen Versuchs */ }
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (kommentarStand(listeKommentare(db, jobId)) !== stand) {
      db.exec('ROLLBACK');
      verwerfen();
      return 'kommentar_neu';
    }
    if (!schliesseRapportAbWennVollstaendig(db, jobId, new Date().toISOString())) {
      db.exec('ROLLBACK');
      verwerfen();
      return false;
    }
    if (zeitstempelGesetztAm) {
      markZeitstempelGesetzt(db, jobId, zeitstempelGesetztAm, zeitstempelDateiHash);
      speichereTsaNachweis(db, { jobId, bezug: 'einzel', dokumentSha256: zeitstempelDateiHash, nachweis: tsaNachweis });
    }
    db.prepare('UPDATE jobs SET pdf_pfad = ?, final_datei_hash = ?, zeitstempel_erforderlich = ? WHERE id = ?').run(
      tmpPfad, createHash('sha256').update(stamped).digest('hex'), tsaUrl ? 1 : 0, jobId);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    verwerfen();
    throw err;
  }
  return true;
}

// Bestätigt die Kenntnisnahme der angemeldeten Person (nur die genannte Person selbst, keine
// Ferienvertretung). Die Bestätigung wird zuerst für sich committet; scheitert danach der
// Abschluss (Stempel), bleibt sie gültig und der Abschluss wird nachgeholt.
export async function bestaetigeRapport(db, config, { jobId, person, ip }) {
  const job = getJobById(db, jobId);
  if (!job || job.typ !== 'rapport') return { ok: false, status: 404, fehler: 'Rapport nicht gefunden.' };
  const personId = person.churchtools_person_id;
  const zeitpunkt = new Date().toISOString();
  let ergebnis;
  db.exec('BEGIN IMMEDIATE');
  try {
    const aktuell = getJobById(db, jobId);
    ergebnis = aktuell.status === 'kenntnisnahme'
      ? bestaetigeKenntnisnahme(db, jobId, personId, zeitpunkt)
      : (db.prepare('SELECT 1 FROM kenntnisnahmen WHERE job_id = ? AND person_id = ? AND bestaetigt_am IS NOT NULL').get(jobId, personId) ? 'bereits' : 'nicht_offen');
    if (ergebnis === 'bestaetigt') {
      createFreigabe(db, {
        jobId, personId, rolle: 'rapport_bestaetigt', zeitpunkt, ip,
        interessenskonflikt: false, kommentar: null, eskaliertVon: null,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  if (ergebnis === 'bereits') return { ok: true, abgeschlossen: false };
  if (ergebnis === 'nicht_berechtigt') {
    return { ok: false, status: 403, fehler: 'Diesen Rapport kann nur eine genannte Empfängerin oder ein genannter Empfänger zur Kenntnis nehmen.' };
  }
  if (ergebnis === 'nicht_offen') return { ok: false, status: 409, fehler: 'Dieser Rapport ist nicht (mehr) zur Kenntnis weitergegeben.' };

  let abgeschlossen = false;
  if (listOffeneKenntnisnahmen(db, jobId).length === 0) {
    try {
      abgeschlossen = await finalisiereRapport(db, config, jobId);
    } catch (err) {
      console.error(`Rapport ${jobId}: Abschluss fehlgeschlagen, wird nachgeholt:`, err.message);
    }
  }
  return { ok: true, abgeschlossen };
}

// Holt Rapporte nach, die vollständig bestätigt sind, aber noch in 'kenntnisnahme' stehen. Fehler
// eines Rapports (z. B. unlesbares PDF) werden protokolliert und stoppen die übrigen nicht.
export async function schliesseRapporteNach(db, config) {
  let geschlossen = 0;
  for (const jobId of listRapportIdsZumAbschliessen(db)) {
    try {
      if (await finalisiereRapport(db, config, jobId)) geschlossen += 1;
    } catch (err) {
      console.error(`Rapport ${jobId}: Nachholen des Abschlusses fehlgeschlagen:`, err.message);
    }
  }
  return geschlossen;
}
