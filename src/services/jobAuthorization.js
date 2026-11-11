// Wer darf das PDF/die Kommentare eines Vorgangs sehen? (Sichtrechte für Vorschau, Download und Kommentare.)
import { getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { personHasRole } from '../middleware/roles.js';
import { istAktiveVertretungFuer } from './vertretung.js';
import { hatKenntnisnahmeZeile } from '../db/rapporteRepo.js';
import { personHasPermission } from '../middleware/permissions.js';

// Entspricht der Berechtigung je Seite, die jede Vorgangs-Detailroute ohnehin durchsetzt (loadAuthorizedJob in
// kontierung.js/ablehnung.js, loadAuthorized in freigabe2.js, das Pool-Tor in poolPage.js) — entscheidet, ob eine Sitzung
// das PDF/Thumbnail eines Vorgangs sehen darf (Vorschau erneuern, Thumbnail-Bild); ersetzt nicht die eigenen Prüfungen jener Routen.
// @returns {boolean} true für Superadmin, Buchhaltung (Pool), zugewiesene Person und Vertretung, Einreicher:in, Rapport-Beteiligte, Freigeber 2 und Vertretung
export function canViewJobPdf(db, config, currentPerson, job) {
  if (personHasRole(currentPerson, config, 'superadmin')) return true;
  if (job.status === 'unzugewiesen') return personHasRole(currentPerson, config, 'buchhaltung');
  const personId = currentPerson.churchtools_person_id;
  if (job.zugewiesen_an === personId) return true;
  if (job.zugewiesen_an && istAktiveVertretungFuer(db, personId, job.zugewiesen_an)) return true;
  // Die einreichende Person einer Spesenposition ist weder zugewiesen_an (das ist der prüfende Freigeber 1/Stellvertreter 1)
  // noch je der aufgelöste Freigeber 2/Stellvertreter 2 (gesperrt durch die Vier-Augen-Selbstfreigabe-Sperren in
  // spesenFreigabe1.js/freigabe2.js) — ohne diese Prüfung könnte sie ihren eigenen eingereichten Beleg nie ansehen oder
  // seinen Zeitstempel prüfen, selbst nach vollständiger Freigabe.
  if (job.eingereicht_von === personId) return true;
  // Rapport: die markierende Person und jede (auch frühere) Empfängerin -- nicht deren Vertretung,
  // denn zur Kenntnis nimmt nur die genannte Person.
  if (istRapportBeteiligt(db, personId, job)) return true;
  if (job.konto_id) {
    const konto = getKontoById(db, job.konto_id);
    if (konto) {
      const freigeber2Id = getEffectiveFreigeber2Id(job, konto);
      if (freigeber2Id === personId) return true;
      if (freigeber2Id && istAktiveVertretungFuer(db, personId, freigeber2Id)) return true;
    }
  }
  return false;
}

// true, wenn die Person den Rapport markiert hat oder je Empfänger:in war.
export function istRapportBeteiligt(db, personId, job) {
  return job.typ === 'rapport' && (job.rapport_markiert_von === personId || hatKenntnisnahmeZeile(db, job.id, personId));
}

// Detailseite /rapporte/:id: Beteiligte (siehe oben), Superadmin oder Vorgänge-Recht.
export function darfRapportSehen(db, config, person, job) {
  if (!person || person.aktiv === false || !job || job.typ !== 'rapport') return false;
  return istRapportBeteiligt(db, person.churchtools_person_id, job) || personHasPermission(db, config, person, 'vorgaenge_einsehen');
}
