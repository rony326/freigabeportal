import { getKontoById } from '../db/kontenRepo.js';
import { getKreditorById } from '../db/kreditorenRepo.js';
import { listStalledJobs } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getAktivenVertreter } from './vertretung.js';
import { LAUFENDE_STATUS, ermittleZustaendigkeit } from './vorgangZustaendigkeit.js';

export const STATUS_LABEL = {
  unzugewiesen: 'Pool',
  zugewiesen: 'Kontierung / Freigabe 1',
  freigabe2: 'Freigabe 2',
  abgelehnt: 'Abgelehnt',
};

const ART_LABEL = { rechnung: 'Rechnung', gutschrift: 'Gutschrift', spesen: 'Spesen' };
const STUNDE_MS = 60 * 60 * 1000;

function artVon(job) {
  if (job.quelle === 'spesen') return 'spesen';
  return job.typ === 'gutschrift' ? 'gutschrift' : 'rechnung';
}

// Ein Namens-Cache pro Request: die Liste löst dieselben Personen oft dutzendfach auf.
function namensAufloeser(db) {
  const cache = new Map();
  return (personId) => {
    if (!personId) return null;
    if (!cache.has(personId)) cache.set(personId, getPersonById(db, personId));
    return cache.get(personId);
  };
}

function anzeigeName(person) {
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// Freigeber 2 des ersten vorhandenen Kontos: konto_id, sonst Default-Konto des Kreditors, sonst
// Hinweis-Konto. Nur das eigene Konto ist sicher, alles andere ist eine Prognose.
function prognoseFreigabe2(db, job, person) {
  if (job.status === 'freigabe2') return null;
  const kandidaten = [
    { kontoId: job.konto_id, prognose: false },
    { kontoId: job.kreditor_id ? getKreditorById(db, job.kreditor_id)?.konto_id : null, prognose: true },
    { kontoId: job.hinweis_konto_id, prognose: true },
  ];
  for (const { kontoId, prognose } of kandidaten) {
    const konto = kontoId ? getKontoById(db, kontoId) : null;
    if (!konto) continue;
    const spesenSelbst = job.quelle === 'spesen' && konto.freigeber2_id === job.eingereicht_von;
    const personId = (job.freigabe2_eskaliert_von || spesenSelbst) ? konto.stellvertreter2_id : konto.freigeber2_id;
    return { personId, name: anzeigeName(person(personId)), prognose, offen: false };
  }
  return { personId: null, name: null, prognose: true, offen: true };
}

function seitWann(db, job) {
  if (job.status === 'freigabe2' && job.freigabe2_seit) return job.freigabe2_seit;
  if (job.status === 'unzugewiesen') return job.pool_rueckgesendet_am || job.eingang_am;
  const letzter = listFreigabenByJob(db, job.id).at(-1);
  return letzter ? letzter.zeitpunkt : job.eingang_am;
}

function istUeberfaellig(db, job, jetzt) {
  if (job.status === 'unzugewiesen') {
    const stunden = Number(getConfigValue(db, 'reminder_stunden'));
    return Boolean(stunden) && Date.parse(job.eingang_am) < jetzt - stunden * STUNDE_MS;
  }
  if (job.status === 'freigabe2' && job.freigabe2_seit && !job.freigabe2_eskaliert_an_admin) {
    const stunden = Number(getConfigValue(db, 'freigabe2_reminder_stunden'));
    return Boolean(stunden) && Date.parse(job.freigabe2_seit) < jetzt - stunden * STUNDE_MS;
  }
  return false;
}

function kennzeichenVon(job) {
  const liste = [];
  if (job.status === 'unzugewiesen' && job.pool_rueckgesendet_bemerkung) liste.push('Rückläufer');
  if ((job.status === 'freigabe2' && job.freigabe2_eskaliert_an_admin) || (job.status !== 'freigabe2' && job.freigabe1_eskaliert_an_admin)) liste.push('Admin-Eskalation');
  if ((job.status === 'freigabe2' && job.freigabe2_eskaliert_von) || (job.status === 'zugewiesen' && job.freigabe1_eskaliert_von)) liste.push('Interessenskonflikt');
  if (job.status === 'freigabe2' && job.freigabe2_umgeleitet_an) liste.push('umgeleitet');
  return liste;
}

// Gleiche Definition wie der Admin-Hänger-Bericht, damit beide nie auseinanderlaufen.
function haengendeJobIds(db) {
  return new Set(listStalledJobs(db).map((s) => s.job.id));
}

export function beschreibeVorgang(db, job, { jetzt = Date.now(), namen = namensAufloeser(db), haengendeIds = haengendeJobIds(db) } = {}) {
  const zust = ermittleZustaendigkeit(db, job);
  const zustaendigPerson = namen(zust.personId);
  const vertreterId = zust.personId ? getAktivenVertreter(db, zust.personId) : null;
  const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
  const art = artVon(job);
  const zustaendigName =
    zust.art === 'pool' ? (job.pool_rueckgesendet_bemerkung ? 'Pool – Rückläufer' : 'Pool')
      : zust.art === 'admin' ? 'Admin-Gruppe'
        : anzeigeName(zustaendigPerson);
  return {
    id: job.id,
    dateiname: job.dateiname,
    eingangAm: job.eingang_am,
    seit: seitWann(db, job),
    art,
    artLabel: ART_LABEL[art],
    status: job.status,
    statusLabel: STATUS_LABEL[job.status] || job.status,
    betrag: job.betrag,
    gegenueber: art === 'spesen' ? anzeigeName(namen(job.eingereicht_von)) : job.lieferant || job.absender || '—',
    kontoLabel: konto ? `${konto.kontonummer} ${konto.bezeichnung}` : '—',
    zustaendig: { art: zust.art, personId: zust.personId, name: zustaendigName, vertretungName: vertreterId ? anzeigeName(namen(vertreterId)) : null },
    prognoseF2: prognoseFreigabe2(db, job, namen),
    kennzeichen: kennzeichenVon(job),
    haengt: haengendeIds.has(job.id),
    ueberfaellig: istUeberfaellig(db, job, jetzt),
  };
}

export function listLaufendeVorgaenge(db, filter = {}) {
  const platzhalter = LAUFENDE_STATUS.map(() => '?').join(', ');
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN (${platzhalter}) ORDER BY eingang_am, id`).all(...LAUFENDE_STATUS);
  const kontext = { jetzt: Date.now(), namen: namensAufloeser(db), haengendeIds: haengendeJobIds(db) };
  return jobs
    .map((job) => beschreibeVorgang(db, job, kontext))
    .filter((v) => !filter.status || v.status === filter.status)
    .filter((v) => !filter.art || v.art === filter.art)
    .filter((v) => !filter.personId || v.zustaendig.personId === filter.personId)
    .filter((v) => !filter.nurProbleme || v.haengt || v.ueberfaellig);
}
