import { getJobById, adminUmhaengen } from '../db/jobsRepo.js';
import { listPersonenMitFreigeberRolle } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { createFreigabe, listFreigabenByJob, listKonfliktmelder } from '../db/freigabenRepo.js';
import { reiheBenachrichtigungEin, reiheBenachrichtigungMitVertretungEin } from './notify.js';
import { stelleEintraegeZu } from './mailZustellung.js';
import { LAUFENDE_STATUS, ermittleZustaendigkeit, standToken } from './vorgangZustaendigkeit.js';

export const MIN_BEMERKUNG_LAENGE = 10;
const MAIL_TYP = 'admin-umzuweisung';

function name(person) {
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// Abgelehnte Spesen-Positionen haben keinen Überarbeiten-Weg (/abgelehnt/:id weist Spesen ab) --
// ein Umhängen würde nur einen toten Vorgang erzeugen.
export function istUmhaengbar(job) {
  if (!job || !LAUFENDE_STATUS.includes(job.status)) return false;
  if (job.status === 'abgelehnt' && job.quelle === 'spesen') return false;
  return true;
}

// Erlaubte Zielpersonen: aktive Personen mit Konto-Rolle, ohne die aktuell zuständige Person und
// ohne jeden, den das Vier-Augen-Prinzip oder ein erklärter Interessenskonflikt ausschliesst.
// Konflikte werden aus freigaben gelesen, nicht aus *_eskaliert_von: eine zweite Eskalation
// überschreibt diese Spalte, der erste Konfliktmelder bliebe sonst wählbar.
export function listUmhaengenZiele(db, job) {
  const ausgeschlossen = new Set();
  const { personId } = ermittleZustaendigkeit(db, job);
  if (personId) ausgeschlossen.add(personId);
  if (job.quelle === 'spesen' && job.eingereicht_von) ausgeschlossen.add(job.eingereicht_von);
  if (job.status === 'freigabe2') {
    const freigabe1 = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'freigeber1');
    if (freigabe1) ausgeschlossen.add(freigabe1.person_id);
  }
  for (const id of listKonfliktmelder(db, job.id, job.status === 'freigabe2' ? 2 : 1)) ausgeschlossen.add(id);
  return listPersonenMitFreigeberRolle(db).filter((p) => !ausgeschlossen.has(p.churchtools_person_id));
}

function linkNachUmhaengen(config, job) {
  const basis = config.publicBaseUrl;
  if (job.status === 'freigabe2') return `${basis}/freigabe2/${job.id}`;
  if (job.status === 'abgelehnt') return `${basis}/abgelehnt/${job.id}`;
  return job.quelle === 'spesen' ? `${basis}/spesen-freigabe1/${job.id}` : `${basis}/kontierung/${job.id}`;
}

export async function umhaengeVorgang(db, config, mailer, { jobId, zielId, bemerkung, standErwartet, admin, ip }) {
  let eintraege = [];
  db.exec('BEGIN');
  try {
    const job = getJobById(db, jobId);
    if (!istUmhaengbar(job)) {
      db.exec('ROLLBACK');
      return { fehler: 'phase' };
    }
    const vorher = ermittleZustaendigkeit(db, job);
    if (standToken(job, vorher) !== standErwartet) {
      db.exec('ROLLBACK');
      return { fehler: 'stand' };
    }
    const ziel = listUmhaengenZiele(db, job).find((p) => p.churchtools_person_id === zielId);
    if (!ziel) {
      db.exec('ROLLBACK');
      return { fehler: 'ziel' };
    }
    if (!adminUmhaengen(db, job.id, { status: job.status, zielId })) {
      db.exec('ROLLBACK');
      return { fehler: 'stand' };
    }

    const vorherPerson = vorher.personId ? getPersonById(db, vorher.personId) : null;
    const vorherText = vorher.art === 'pool' ? 'Pool' : vorher.art === 'admin' ? 'Admin-Gruppe' : name(vorherPerson);
    createFreigabe(db, {
      jobId: job.id,
      personId: admin.churchtools_person_id,
      rolle: 'admin_umzuweisung',
      zeitpunkt: new Date().toISOString(),
      ip,
      interessenskonflikt: false,
      kommentar: `Von ${vorherText} an ${name(ziel)}: ${bemerkung}`,
      eskaliertVon: null,
      vorherZustaendig: vorher.personId,
      zielPersonId: ziel.churchtools_person_id,
    });

    const jobDanach = getJobById(db, job.id);
    const gemeinsam = { jobDateiname: job.dateiname, adminName: name(admin), bemerkung };
    eintraege = reiheBenachrichtigungMitVertretungEin(db, {
      person: ziel,
      typ: MAIL_TYP,
      jobId: job.id,
      variablen: {
        ...gemeinsam,
        grund: `${name(admin)} hat dir einen Vorgang übergeben (bisher zuständig: ${vorherText}).`,
        link: linkNachUmhaengen(config, jobDanach),
      },
    });
    if (vorherPerson && vorherPerson.aktiv) {
      eintraege.push(reiheBenachrichtigungEin(db, {
        to: vorherPerson.email,
        typ: MAIL_TYP,
        jobId: job.id,
        variablen: {
          ...gemeinsam,
          empfaengerName: name(vorherPerson),
          grund: `${name(admin)} hat einen Vorgang, für den du zuständig warst, an ${name(ziel)} übergeben. Du musst dafür nichts mehr tun.`,
          link: `${config.publicBaseUrl}/pool`,
        },
      }));
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  // Nach dem Commit zustellen: scheitert SMTP, bleibt das Umhängen gültig und mail-zustellung
  // wiederholt die eingereihten Mails.
  await stelleEintraegeZu(db, mailer, eintraege);
  return { ok: true };
}
