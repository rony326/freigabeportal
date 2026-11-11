// Markieren eines Vorgangs als Kreditkartenabrechnung (manuell oder automatisch erkannt), siehe docs/kreditkarten-belege.md.
import { markiereJobAlsKkAbrechnung } from '../db/jobsRepo.js';
import { listOffeneKkBelegeFuerKarte } from '../db/kkBelegeRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotificationMitVertretung } from './notify.js';

// Gemeinsamer Ablauf für manuelle (Pool/Kontierung) und automatische (Etappe 2) Markierung.
// markiertVon = null bedeutet System: freigaben.person_id ist NOT NULL, deshalb wird dann die
// verantwortliche Person der Karte eingetragen und im Kommentar "automatisch" vermerkt.
/**
 * Markiert einen Vorgang als Kreditkartenabrechnung der Karte (Verlaufseintrag 'kk_abrechnung_markiert') und benachrichtigt die
 * verantwortliche Person (mit Vertretung), sofern sie nicht selbst markiert hat.
 * @returns {Promise<boolean>} false, wenn der Vorgang nicht mehr im erwarteten Status war
 */
export async function markiereAlsKkAbrechnung(db, config, mailer, { job, karte, markiertVon, ip, ausStatus, kommentarZusatz = '' }) {
  db.exec('BEGIN');
  try {
    const ok = markiereJobAlsKkAbrechnung(db, job.id, { kreditkarteId: karte.id, verantwortlichId: karte.verantwortlich_id, ausStatus });
    if (!ok) {
      db.exec('ROLLBACK');
      return false;
    }
    createFreigabe(db, {
      jobId: job.id,
      personId: markiertVon ? markiertVon.churchtools_person_id : karte.verantwortlich_id,
      rolle: 'kk_abrechnung_markiert',
      zeitpunkt: new Date().toISOString(),
      ip: ip || 'system',
      interessenskonflikt: false,
      kommentar: `Karte "${karte.bezeichnung}"${markiertVon ? '' : ' (automatisch erkannt)'}${kommentarZusatz}`,
      eskaliertVon: null,
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (markiertVon && markiertVon.churchtools_person_id === karte.verantwortlich_id) return true;
  const verantwortlich = getPersonById(db, karte.verantwortlich_id);
  if (verantwortlich) {
    await sendNotificationMitVertretung(db, mailer, {
      person: verantwortlich,
      typ: 'kk-abrechnung-zugewiesen',
      jobId: job.id,
      variablen: {
        karte: karte.bezeichnung,
        anzahlBelege: listOffeneKkBelegeFuerKarte(db, karte.id).length,
        jobDateiname: job.dateiname,
        grund: `Kreditkartenabrechnung "${karte.bezeichnung}" zum Abgleich`,
        link: `${config.publicBaseUrl}/kontierung/${job.id}/kk-abgleich`,
      },
    });
  }
  return true;
}
