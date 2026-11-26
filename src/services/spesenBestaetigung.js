// Spesen-Bestätigung an die einreichende Person (docs/superpowers/specs/2026-11-26-spesen-bestaetigungsmail-design.md):
// Sobald jede Position einer Spesenabrechnung erledigt ist und mindestens eine freigegeben wurde, geht eine Mail mit den
// gestempelten Belegen in die Outbox. «Freigegeben» heisst: es gibt eine Bexio-Versandquittung (bexio_versand);
// «nicht durchgekommen» heisst abgelehnt oder gelöscht; alles andere ist offen. Der Marker
// spesenabrechnungen.bestaetigung_am sorgt für höchstens eine Bestätigung je Abrechnung.
// Die Belege werden je Position nach <jobsDir>/mail-anhaenge kopiert, weil die Originale nach der Aufbewahrungsfrist
// gelöscht werden, die Abrechnung aber erst später erledigt sein kann. Fehlt einer freigegebenen Position die Kopie und ist
// auch das Original schon gelöscht (z. B. Versandquittung erst nach der Bereinigung), gibt es keine Mail (Vermerk «keine»).

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getJobById } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { getSpesenabrechnungById, listPositionen, setzeBestaetigung } from '../db/spesenabrechnungenRepo.js';
import { jobDocument } from './jobDocument.js';
import { belegName } from './belegName.js';
import { zeitpunktAnzeige } from './auditLog.js';
import { renderBenachrichtigung } from './notify.js';
import { reiheMailEin, stelleMailZu } from './mailZustellung.js';

const MAIL_TYP = 'spesen-bestaetigung';
// Obergrenze für alle Anhänge einer Mail zusammen; darüber geht die Mail ohne Anhänge raus.
const MAX_ANHANG_BYTES = 15 * 1024 * 1024;
const NICHT_DURCHGEKOMMEN = new Set(['abgelehnt', 'geloescht']);

// Die Bausteine für %anhang_hinweis% bringen ihre Zeilenumbrüche selbst mit.
const HINWEIS_ANHANG = '\nDie gestempelten Belege findest du im Anhang.\n';
const HINWEIS_ZU_GROSS = '\nDie Belege sind zu gross für den Versand per E-Mail. Du kannst sie bei der Finanzverwaltung anfordern.\n';
const HINWEIS_UNVOLLSTAENDIG = '\nNicht alle Belege konnten angehängt werden. Fehlende Belege kannst du bei der Finanzverwaltung anfordern.\n';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Dateigrösse, null wenn die Datei fehlt oder keine gewöhnliche Datei ist.
function dateiGroesse(pfad) {
  const stat = statSync(pfad, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.size : null;
}

// true nur, wenn weder eine Kopie noch das Original da ist, ein Anhang also nie mehr entstehen kann. Andere Fehler beim
// Zugriff auf das Original (Rechte, Datenträger) zählen nicht als «gelöscht».
function belegVerloren(db, job) {
  const kopie = db.prepare('SELECT pfad FROM spesen_beleg_kopien WHERE job_id = ?').get(job.id);
  if (kopie && dateiGroesse(kopie.pfad) !== null) return false;
  const original = jobDocument(job).pdf_pfad;
  if (!original) return true;
  try {
    return dateiGroesse(original) === null;
  } catch {
    return false;
  }
}

// @returns {number|null} Abrechnung, zu der eine Spesenposition gehört; null für andere Vorgänge
export function abrechnungIdFuerJob(db, jobId) {
  const job = getJobById(db, jobId);
  return job?.quelle === 'spesen' ? job.spesenabrechnung_id ?? null : null;
}

/**
 * Legt die Kopie des gestempelten End-PDFs einer Spesenposition an (idempotent, eine vorhandene Kopie bleibt unverändert).
 * Kopiert wird nur, was byte-genau dem Hash im Exportnachweis entspricht. Wirft nicht bei Dateifehlern.
 * @returns {{pfad: string, sha256: string}|null} null, wenn keine Kopie vorhanden ist und keine angelegt werden konnte
 */
export function sichereBelegKopie(db, config, jobId) {
  const job = getJobById(db, jobId);
  if (job?.quelle !== 'spesen') return null;
  const vorhanden = db.prepare('SELECT pfad, sha256 FROM spesen_beleg_kopien WHERE job_id = ?').get(jobId);
  if (vorhanden && dateiGroesse(vorhanden.pfad) !== null) return { pfad: vorhanden.pfad, sha256: vorhanden.sha256 };
  const warnung = (grund) => {
    console.error(`Spesen-Bestätigung: keine Beleg-Kopie für Position ${jobId}: ${grund}`);
    return null;
  };
  const erwartet = vorhanden?.sha256 ?? db.prepare('SELECT sha256 FROM export_nachweise WHERE job_id = ?').get(jobId)?.sha256;
  if (!erwartet) return warnung('kein Exportnachweis');
  const pfad = vorhanden?.pfad ?? join(config.jobsDir, 'mail-anhaenge', `spesen-${jobId}.pdf`);
  // Über eine Zwischendatei, damit nie eine halb geschriebene Kopie unter dem endgültigen Namen liegt.
  const tmp = `${pfad}.${randomUUID()}.tmp`;
  try {
    const bytes = readFileSync(jobDocument(job).pdf_pfad);
    if (sha256(bytes) !== erwartet) return warnung('Datei stimmt nicht mit dem Exportnachweis überein');
    mkdirSync(join(config.jobsDir, 'mail-anhaenge'), { recursive: true });
    writeFileSync(tmp, bytes, { flag: 'wx' });
    renameSync(tmp, pfad);
  } catch (err) {
    rmSync(tmp, { force: true });
    return warnung(err.message);
  }
  db.prepare('INSERT OR IGNORE INTO spesen_beleg_kopien (job_id, pfad, sha256, erstellt_am) VALUES (?, ?, ?, ?)')
    .run(jobId, pfad, erwartet, new Date().toISOString());
  return { pfad, sha256: erwartet };
}

// Freitext auf eine Zeile bringen, damit jede Position in der Mail genau eine Zeile bleibt.
const einzeilig = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// Betrag (auch mit Komma gespeichert) in Rappen, damit die Summe ohne Rundungsfehler entsteht.
const rappen = (betrag) => Math.round(Number(String(betrag ?? '').replace(',', '.')) * 100) || 0;
const franken = (wert) => (wert / 100).toFixed(2);

function positionsZeile(job) {
  return `- ${einzeilig(job.beschreibung) || belegName(job)}: CHF ${franken(rappen(job.betrag))}`;
}

function ablehnungsZeile(job) {
  if (job.status === 'geloescht') return `${positionsZeile(job)} (gelöscht)`;
  const grund = einzeilig(job.ablehnungsgrund);
  return grund ? `${positionsZeile(job)} (Grund: ${grund})` : positionsZeile(job);
}

// Dateiarbeit vor der Transaktion: fehlende Kopien der schon versandten Positionen nachholen, damit während des Kopierens
// keine Schreibsperre gehalten wird. Auch bei noch offener Abrechnung sinnvoll, weil die Originale befristet sind.
function holeKopienNach(db, config, abrechnungId) {
  const abrechnung = getSpesenabrechnungById(db, abrechnungId);
  if (!abrechnung || abrechnung.bestaetigung_am) return;
  const versandt = db.prepare('SELECT 1 FROM bexio_versand WHERE job_id = ?');
  for (const job of listPositionen(db, abrechnungId)) {
    if (versandt.get(job.id)) sichereBelegKopie(db, config, job.id);
  }
}

// Anhänge der freigegebenen Positionen (aus den vorhandenen Kopien) samt passendem Hinweistext.
function sammleAnhaenge(db, abrechnungId, freigegeben) {
  const anhaenge = [];
  let bytes = 0;
  for (const job of freigegeben) {
    const kopie = db.prepare('SELECT pfad, sha256 FROM spesen_beleg_kopien WHERE job_id = ?').get(job.id);
    const groesse = kopie ? dateiGroesse(kopie.pfad) : null;
    if (groesse === null) continue;
    bytes += groesse;
    anhaenge.push({ dateiname: `Spesen-${abrechnungId}-${job.id}.pdf`, pfad: kopie.pfad, sha256: kopie.sha256 });
  }
  if (bytes > MAX_ANHANG_BYTES) {
    console.error(`Spesen-Bestätigung ${abrechnungId}: Anhänge zu gross (${bytes} Bytes), Mail geht ohne Anhänge raus.`);
    return { anhaenge: [], hinweis: HINWEIS_ZU_GROSS };
  }
  return { anhaenge, hinweis: anhaenge.length === freigegeben.length ? HINWEIS_ANHANG : HINWEIS_UNVOLLSTAENDIG };
}

// Entscheidet über eine Abrechnung; läuft innerhalb der Transaktion von pruefeSpesenBestaetigung.
function entscheide(db, config, abrechnungId, jetzt) {
  const abrechnung = getSpesenabrechnungById(db, abrechnungId);
  if (!abrechnung) return { ergebnis: 'offen' };
  if (abrechnung.bestaetigung_am) return { ergebnis: 'bereits' };

  const versandt = db.prepare('SELECT 1 FROM bexio_versand WHERE job_id = ?');
  const positionen = listPositionen(db, abrechnungId);
  const freigegeben = [];
  const abgelehnt = [];
  for (const job of positionen) {
    if (versandt.get(job.id)) freigegeben.push(job);
    else if (NICHT_DURCHGEKOMMEN.has(job.status)) abgelehnt.push(job);
    else return { ergebnis: 'offen' };
  }
  if (positionen.length === 0) return { ergebnis: 'offen' };

  const abschliessen = (vermerk, ergebnis) => ({ ergebnis: setzeBestaetigung(db, abrechnungId, vermerk, jetzt) ? ergebnis : 'bereits' });
  if (freigegeben.length === 0) return abschliessen('keine', 'keine');
  if (getConfigValue(db, 'spesen_bestaetigung_aktiv') !== '1') return abschliessen('deaktiviert', 'deaktiviert');
  const verloren = freigegeben.filter((job) => belegVerloren(db, job));
  if (verloren.length) {
    console.warn(`Spesen-Bestätigung ${abrechnungId}: keine Mail, Beleg bereits gelöscht und keine Kopie vorhanden (Position ${verloren.map((job) => job.id).join(', ')}).`);
    return abschliessen('keine', 'keine');
  }
  const person = getPersonById(db, abrechnung.eingereicht_von);
  const email = person?.email?.trim();
  if (!email) {
    console.error(`Spesen-Bestätigung ${abrechnungId}: einreichende Person ${abrechnung.eingereicht_von} hat keine Mailadresse.`);
    return abschliessen('keine', 'keine');
  }
  if (!setzeBestaetigung(db, abrechnungId, 'versendet', jetzt)) return { ergebnis: 'bereits' };

  const { anhaenge, hinweis } = sammleAnhaenge(db, abrechnungId, freigegeben);
  const { subject, text } = renderBenachrichtigung(db, MAIL_TYP, {
    name: `${person.vorname} ${person.nachname}`,
    titel: einzeilig(abrechnung.titel) || `Nr. ${abrechnungId}`,
    // Nur das Datum (TT.MM.JJJJ) in Zürcher Zeit.
    eingereicht_am: zeitpunktAnzeige(abrechnung.eingereicht_am).slice(0, 10),
    positionen: freigegeben.map(positionsZeile).join('\n'),
    summe: franken(freigegeben.reduce((summe, job) => summe + rappen(job.betrag), 0)),
    nicht_freigegeben: abgelehnt.length ? `\nNicht freigegeben:\n${abgelehnt.map(ablehnungsZeile).join('\n')}\n` : '',
    anhang_hinweis: hinweis,
    portal_url: config.publicBaseUrl,
  });
  const mailId = reiheMailEin(db, {
    typ: MAIL_TYP, jobId: freigegeben[0].id, empfaenger: email, betreff: subject, text, anhaenge, jetzt,
  });
  return { ergebnis: 'eingereiht', mailId };
}

/**
 * Prüft, ob eine Abrechnung erledigt ist, und reiht dann die Bestätigung ein. Marker und Mail werden gemeinsam
 * gespeichert oder gar nicht. Synchron und mit eigener Transaktion: wirft, wenn schon eine läuft.
 * @returns {{ergebnis: 'offen'|'bereits'|'keine'|'deaktiviert'|'eingereiht', mailId?: number}}
 */
export function pruefeSpesenBestaetigung(db, config, abrechnungId, { jetzt = Date.now() } = {}) {
  // Läuft schon eine fremde Transaktion, wird nichts angefasst; BEGIN wirft dann.
  if (!db.isTransaction) holeKopienNach(db, config, abrechnungId);
  // Vor dem try: scheitert BEGIN an einer fremden Transaktion, darf diese nicht zurückgerollt werden.
  db.exec('BEGIN IMMEDIATE');
  try {
    const ergebnis = entscheide(db, config, abrechnungId, jetzt);
    db.exec('COMMIT');
    return ergebnis;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Auslöser für die Routen, nach deren Commit (nie in einer offenen Transaktion): prüft die Abrechnung der Position und stellt
 * eine neu eingereihte Bestätigung im Hintergrund zu. Wirft nie, damit Versandquittung und Ablehnung nicht daran scheitern;
 * Liegengebliebenes holen die Jobs pdf-bereinigung (Prüfung) und mail-zustellung (Versand) nach.
 */
export function loeseSpesenBestaetigungAus(db, config, mailer, jobId) {
  try {
    const abrechnungId = abrechnungIdFuerJob(db, jobId);
    if (abrechnungId === null) return;
    const { ergebnis, mailId } = pruefeSpesenBestaetigung(db, config, abrechnungId);
    if (ergebnis !== 'eingereiht' || !mailer) return;
    stelleMailZu(db, mailer, mailId)
      .catch((err) => console.error(`Spesen-Bestätigung: Sofortzustellung für Mail ${mailId} fehlgeschlagen, mail-zustellung wiederholt`, err));
  } catch (err) {
    console.error(`Spesen-Bestätigung nach Position ${jobId} fehlgeschlagen`, err);
  }
}

// Nachhol-Durchlauf über alle noch nicht entschiedenen Abrechnungen. Ein Fehler bei einer Abrechnung wird protokolliert
// und hält die übrigen nicht auf. @returns {{geprueft: number, eingereiht: number}}
export function holeSpesenBestaetigungenNach(db, config) {
  const offene = db.prepare('SELECT id FROM spesenabrechnungen WHERE bestaetigung_am IS NULL ORDER BY id').all();
  let eingereiht = 0;
  for (const { id } of offene) {
    try {
      if (pruefeSpesenBestaetigung(db, config, id).ergebnis === 'eingereiht') eingereiht += 1;
    } catch (err) {
      console.error(`Spesen-Bestätigung ${id} konnte nicht geprüft werden`, err);
    }
  }
  return { geprueft: offene.length, eingereiht };
}
