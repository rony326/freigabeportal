// Verlauf eines Vorgangs ("Audit-Log" unter jedem Beleg): macht aus den Zeilen der Tabelle `freigaben` eine lesbare
// Zeitleiste mit Ereignisbezeichnung und Personennamen. Der globale, durchsuchbare Audit-Log (Tabelle `audit_ereignisse`)
// steckt dagegen in services/globalAuditLog.js.

import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

// Anzeigetext je `freigaben.rolle`. Neue Rolle (CHECK in db/index.js erweitern!) → hier eine Bezeichnung ergänzen,
// sonst erscheint der rohe Rollenname.
export const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1 erteilt',
  freigeber2: 'Freigabe 2 erteilt',
  ablehnung: 'Abgelehnt',
  freigabe1_eskalation: 'Freigabe 1: Interessenskonflikt gemeldet',
  freigabe2_eskalation: 'Freigabe 2: Interessenskonflikt gemeldet',
  iban_abweichung: 'IBAN-Abweichung festgestellt',
  rechnungsnummer_duplikat: 'Doppelte Rechnungsnummer festgestellt',
  duplikat_verdacht: 'Mögliche doppelte Rechnung festgestellt',
  iban_manuell_geprueft: 'IBAN von Hand geprüft',
  auffaelligkeiten_bestaetigt: 'Auffälligkeiten bestätigt',
  pool_zuweisung: 'An Person weitergeleitet',
  pool_ruecksendung: 'An Gruppe zurückgesendet',
  freigabe1_weiterleitung: 'An Freigeber 1 weitergeleitet (Kontierung durch andere Person)',
  admin_umzuweisung: 'Vorgang durch Administration übergeben',
  loeschung: 'Job gelöscht',
  rapport_markiert: 'Zur Kenntnis weitergegeben',
  rapport_bestaetigt: 'Zur Kenntnis genommen',
  rapport_empfaenger_ersetzt: 'Empfänger ersetzt',
  rapport_empfaenger_entfernt: 'Empfänger entfernt',
  rapport_markierung_aufgehoben: 'Markierung aufgehoben',
  kk_abrechnung_markiert: 'Als Kreditkartenabrechnung markiert',
  kk_markierung_aufgehoben: 'Kreditkarten-Markierung aufgehoben',
  kk_abgleich: 'Kreditkartenabrechnung abgeglichen',
  kk_beleg_erfasst: 'Kreditkartenbeleg erfasst',
  kk_beleg_ergaenzt: 'Kreditkartenbeleg ergänzt',
  kk_beleg_geaendert: 'Kreditkartenbeleg geändert',
  kk_beleg_verworfen: 'Kreditkartenbeleg verworfen',
  kk_beleg_zugeordnet: 'Kreditkartenbeleg zugeordnet',
  kk_beleg_datei_geloescht: 'Kreditkartenbeleg-Datei gelöscht (Frist)',
};

// Schweizer Organisation, fest eingetragen statt aus der Zeitzone des Server-Betriebssystems abgeleitet — das Hosting bei
// Infomaniak läuft in UTC, und "lokale Zeit" meint hier immer Europe/Zurich, egal wo der Prozess gerade läuft.
const LOKALE_ZEITZONE = 'Europe/Zurich';

// Voller Name der Person oder 'Unbekannt'.
export function personName(db, personId) {
  const person = getPersonById(db, personId);
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// zeitpunkt wird immer als UTC-ISO-Text gespeichert (siehe freigabenRepo.js) — das hier ändert nur die Anzeige. Die
// Formatierung läuft von Hand über formatToParts statt über einen Locale-Text, damit die Ausgabe (TT.MM.JJJJ HH:MM)
// deterministisch ist und nicht von den Intl-Locale-Daten der Maschine abhängt, die die Seite rendert.
export function formatZeitpunkt(iso, lokaleZeit) {
  if (!lokaleZeit) return iso;
  const teile = new Intl.DateTimeFormat('de-CH', {
    timeZone: LOKALE_ZEITZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const teil = (typ) => teile.find((t) => t.type === typ).value;
  return `${teil('day')}.${teil('month')}.${teil('year')} ${teil('hour')}:${teil('minute')}`;
}

// Für Listen und Kacheln: immer Ortszeit, fehlender Wert als Strich, Unlesbares unverändert.
export function zeitpunktAnzeige(iso) {
  if (!iso) return '—';
  if (Number.isNaN(new Date(iso).getTime())) return iso;
  return formatZeitpunkt(iso, true);
}

// Die Tabelle freigaben ist die einzige Aufzeichnung je Aktion im System (wer, wann, von welcher IP) — sie existiert schon
// für die Vier-Augen-Prüfungen in kontierung.js/freigabe2.js/ablehnung.js. Hier werden dieselben Zeilen zur lesbaren Zeitleiste
// unter dem Abschnitt Freigabe jeder Rechnung, ohne dass jede Route Personennamen-Abfragen und Ereignisbezeichnungen selbst nachbaut.
// @returns {object[]} je Verlaufseintrag: Zeitpunkt (formatiert), Ereignis, Person, Konflikt-Flag, Kommentar, eskaliert von / Vertretung für
export function buildAuditLog(db, jobId) {
  const lokaleZeit = getConfigValue(db, 'audit_log_lokale_zeit') === '1';
  return listFreigabenByJob(db, jobId).map((eintrag) => ({
    zeitpunkt: formatZeitpunkt(eintrag.zeitpunkt, lokaleZeit),
    ereignis: EREIGNIS_LABEL[eintrag.rolle] || eintrag.rolle,
    person: personName(db, eintrag.person_id),
    interessenskonflikt: Boolean(eintrag.interessenskonflikt),
    kommentar: eintrag.kommentar,
    eskaliertVonPerson: eintrag.eskaliert_von ? personName(db, eintrag.eskaliert_von) : null,
    vertretungFuerPerson: eintrag.vertretung_fuer ? personName(db, eintrag.vertretung_fuer) : null,
  }));
}
