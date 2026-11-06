// Rapporte: Dokumente, die nur zur Kenntnis weitergegeben werden (kein Rechnungsweg).
import { getJobById } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listAllPersons } from '../db/personenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { markiereAlsRapport, hebeRapportMarkierungAuf } from '../db/rapporteRepo.js';
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
