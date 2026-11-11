// Benachrichtigungs-Mails: Vorlage rendern, dauerhaft einreihen und zustellen; Empfängerlisten auflösen; Vertretung mitbedienen.
// Zustellung mit Wiederholung: services/mailZustellung.js, Bündelung (Digest): services/benachrichtigung.js. Einstieg für die meisten
// Aufrufer: `sendNotification` bzw. `sendNotificationMitVertretung`.

import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup, getPersonById } from '../db/personenRepo.js';
import { getVorlage, renderTemplate } from './mailTemplates.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { getAktivenVertreter } from './vertretung.js';
import { reiheMailEin, stelleMailZu } from './mailZustellung.js';
import { benachrichtigungFuer } from './benachrichtigung.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';
const GRUPPE_ADMIN_TOKEN = 'gruppe:admin';

// Grund der "Freigabe 2 wartet"-Mail, wenn abschliessenFreigabe1 den Vorgang an die Admin-Gruppe
// gegeben hat, weil die effektive Freigabe-2-Person bereits einen Interessenskonflikt erklärt hat.
export const FREIGABE2_AN_ADMIN_GRUND =
  'Eine Rechnung wartet auf Freigabe 2 und wurde an die Portal-Admin-Gruppe übergeben, da die zuständige Freigabe-2-Person für diese Rechnung bereits einen Interessenskonflikt erklärt hat.';

// Typen, die nie auf den Digest warten -- unabhängig von der persönlichen Bündelung
// (services/benachrichtigung.js). sync-fehler (ChurchTools-Ausfall) und auffaelligkeiten-warnung
// (Betrugsverdacht) sind betriebs-/sicherheitskritisch. kk-beleg-eingegangen: die Person, die per
// Mail einen Beleg eingereicht hat, soll sofort den Ergänzen-Link bekommen. admin-umzuweisung: ein
// Admin hat einen laufenden Vorgang umgehängt -- die neue Person soll sofort handeln können, die
// bisherige sofort wissen, dass sie nichts mehr tun muss. Erinnerungen und Eskalationen (reminder,
// eskalation, freigabe2-*, kk-beleg-erinnerung) sind zeitkritisch und dürfen nie eine Woche
// warten; sicherheitsalarm, duplikat-warnung und rechnungsnummer-warnung sind Warnungen.
// rapport-reminder/-eskalation wie freigabe2-*; rapport-zuweisung folgt der Bündelung wie zuweisung.
export const IMMER_SOFORT_TYPEN = new Set([
  'sync-fehler', 'auffaelligkeiten-warnung', 'kk-beleg-eingegangen', 'admin-umzuweisung', 'audit-pruefnummer', 'neues-geraet', 'fehlermeldung', 'testmail',
  'reminder', 'eskalation', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-beleg-erinnerung',
  'rapport-reminder', 'rapport-eskalation',
  'sicherheitsalarm', 'duplikat-warnung', 'rechnungsnummer-warnung',
]);

// Der Baustein auf unterer Ebene "einreihen und jetzt versuchen" für eine bereits gerenderte Mail. Das erneute Versenden unter
// /admin/mails spielt eine bereits gerenderte mail_log-Zeile unverändert hierüber ab und muss sowohl die Vorlagenschicht
// (es gibt keine `variablen` zum erneuten Rendern) als auch die Bündelung (ein manuelles Erneut-Senden geht immer sofort) umgehen.
//
// Die Zeile wird VOR dem SMTP-Aufruf als 'eingereiht' gespeichert (services/mailZustellung.js), ein fehlgeschlagener oder
// unterbrochener Versand wird also vom Job mail-zustellung mit wachsendem Abstand automatisch wiederholt. Wirft nie; liefert
// { id, status } mit status 'versendet' | 'eingereiht' (Wiederholung ausstehend) | 'fehlgeschlagen'.
export async function sendRenderedMail(db, mailer, { to, subject, text, typ, jobId }) {
  let id;
  try {
    id = reiheMailEin(db, { typ, jobId, empfaenger: to, betreff: subject, text });
  } catch (err) {
    console.error('sendRenderedMail: Mail konnte nicht eingereiht werden', err);
    return { id: null, status: 'fehlgeschlagen', fehler: err.message };
  }
  try {
    return await stelleMailZu(db, mailer, id);
  } catch (err) {
    // Nur erreichbar, wenn das Festhalten des Versuchs selbst scheiterte — die Zeile bleibt 'eingereiht', die Sperre läuft ab, und der Wiederholungsjob holt sie.
    console.error('sendRenderedMail: Zustellversuch konnte nicht gespeichert werden', err);
    return { id, status: 'eingereiht', fehler: err.message };
  }
}

// `vorlage` optional: eine bereits gewählte Vorlage { betreff, text } statt der aus admin_config. Ergänzt automatisch %portalName%.
export function renderBenachrichtigung(db, typ, variablen, vorlage = getVorlage(db, typ)) {
  const portalName = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
  const alleVariablen = { ...variablen, portalName };
  return { subject: renderTemplate(vorlage.betreff, alleVariablen), text: renderTemplate(vorlage.text, alleVariablen) };
}

// Synchron: rendert und reiht eine Benachrichtigung dauerhaft ein, ohne SMTP-Aufruf. Wirft, wenn die Vorlage nicht gerendert werden
// kann — gedacht für Aufrufer, die in derselben Transaktion wie ihre eigene fachliche Marke einreihen (Erinnerungen in cronJobs.js)
// und danach über stelleEintraegeZu zustellen. Liefert { id, status } mit status 'eingereiht' oder 'geplant' (Bündelung).
// `gerendert` optional: bereits gerenderte { subject, text } (der Aufrufer hat Vorlagenfehler selbst behandelt).
export function reiheBenachrichtigungEin(db, { to, typ, jobId, variablen = {}, gerendert = null }) {
  const { subject, text } = gerendert ?? renderBenachrichtigung(db, typ, variablen);
  const geplant = !IMMER_SOFORT_TYPEN.has(typ) && benachrichtigungFuer(db, to) !== 'sofort';
  // Empfänger bündelt (täglich/wöchentlich): nur einreihen, kein SMTP-Call -- runMailDigestJob
  // sammelt diese Zeile später ein und verschickt sie als Teil der Digest-Mail des Empfängers.
  const id = reiheMailEin(db, { typ, jobId, empfaenger: to, betreff: subject, text, geplant });
  return { id, status: geplant ? 'geplant' : 'eingereiht' };
}

// Wirft nie bei SMTP- oder Vorlagenproblemen. Liefert { id, status } mit status 'versendet' | 'eingereiht' (Wiederholung ausstehend) |
// 'geplant' (Digest) | 'fehlgeschlagen'. Das ist der normale Weg, eine Benachrichtigung zu verschicken.
export async function sendNotification(db, mailer, { to, typ, jobId, variablen = {} }) {
  let eintrag;
  try {
    eintrag = reiheBenachrichtigungEin(db, { to, typ, jobId, variablen });
  } catch (err) {
    // Auch logMailAttempt selbst kann hier scheitern (z. B. wenn `typ` nicht einmal zu den Werten gehört, die der CHECK von mail_log
    // erlaubt — ein wirklich unbekannter typ ist ein Programmierfehler, der über die heutigen Aufrufer nie vorkommt, darf diese
    // Funktion aber trotzdem nicht verlassen).
    try {
      logMailAttempt(db, {
        typ,
        jobId,
        empfaenger: to,
        betreff: '(Vorlage konnte nicht gerendert werden)',
        text: '(Vorlage konnte nicht gerendert werden)',
        status: 'fehlgeschlagen',
        fehlerDetails: err.message,
      });
    } catch (logErr) {
      console.error('sendNotification: logMailAttempt failed while recording a template-rendering failure', logErr);
    }
    return { id: null, status: 'fehlgeschlagen', fehler: err.message };
  }
  if (eintrag.status === 'geplant') return eintrag;
  try {
    return await stelleMailZu(db, mailer, eintrag.id);
  } catch (err) {
    console.error('sendNotification: Zustellversuch konnte nicht gespeichert werden', err);
    return { id: eintrag.id, status: 'eingereiht', fehler: err.message };
  }
}

const PERSON_TOKEN_PREFIX = 'person:';

// Löst eine Empfängerliste aus der Konfiguration (Zeilen: `gruppe:buchhaltung`, `gruppe:admin`, `person:<id>` oder Adresse) zu
// Mailadressen auf; Gruppen und Personen nur aktiv, Duplikate entfallen. @returns {string[]}
export function resolveEmpfaenger(db, config, konfigWert) {
  if (!konfigWert) return [];
  const zeilen = konfigWert
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean);
  const empfaenger = new Set();
  for (const zeile of zeilen) {
    if (zeile === GRUPPE_BUCHHALTUNG_TOKEN) {
      for (const person of listActivePersonsInGroup(db, config.churchtools.groupIdBuchhaltung)) {
        empfaenger.add(person.email);
      }
    } else if (zeile === GRUPPE_ADMIN_TOKEN) {
      for (const person of listActivePersonsInGroup(db, config.churchtools.groupIdAdmin)) {
        empfaenger.add(person.email);
      }
    } else if (zeile.startsWith(PERSON_TOKEN_PREFIX)) {
      // Aktuelle Mail der Person; inaktive oder mail-lose Personen werden still übersprungen.
      const person = getPersonById(db, zeile.slice(PERSON_TOKEN_PREFIX.length).trim());
      if (person && person.aktiv && person.email) empfaenger.add(person.email);
    } else {
      empfaenger.add(zeile);
    }
  }
  return [...empfaenger];
}

// Empfängerliste der Person plus ihrer aktiven Ferienmodus-Stellvertretung (mit Hinweis im Grund).
function vertretungsEmpfaenger(db, { person, variablen }) {
  const empfaenger = [{ to: person.email, variablen: { ...variablen, empfaengerName: `${person.vorname} ${person.nachname}` } }];
  const vertreterId = getAktivenVertreter(db, person.churchtools_person_id);
  const vertreter = vertreterId ? getPersonById(db, vertreterId) : null;
  if (vertreter) {
    empfaenger.push({
      to: vertreter.email,
      variablen: {
        ...variablen,
        empfaengerName: `${vertreter.vorname} ${vertreter.nachname}`,
        grund: `(Als Stellvertreter für ${person.vorname} ${person.nachname} im Ferienmodus) ${variablen.grund}`,
      },
    });
  }
  return empfaenger;
}

// Umhüllt sendNotification, damit jede Stelle, die "die für diesen Vorgang zuständige Person" anmailt, auch deren aktive
// Ferienmodus-Stellvertretung erreicht, ohne dass jede Stelle den Ferienmodus selbst kennen muss. Siehe
// docs/superpowers/specs/2026-09-07-ferienmodus-design.md. Liefert je Empfänger ein Ergebnis (siehe sendNotification).
export async function sendNotificationMitVertretung(db, mailer, { person, typ, jobId, variablen }) {
  const ergebnisse = [];
  for (const empfaenger of vertretungsEmpfaenger(db, { person, variablen })) {
    ergebnisse.push(await sendNotification(db, mailer, { to: empfaenger.to, typ, jobId, variablen: empfaenger.variablen }));
  }
  return ergebnisse;
}

// Synchrones Gegenstück zu sendNotificationMitVertretung für das Einreihen innerhalb einer Transaktion.
export function reiheBenachrichtigungMitVertretungEin(db, { person, typ, jobId, variablen }) {
  return vertretungsEmpfaenger(db, { person, variablen }).map((empfaenger) =>
    reiheBenachrichtigungEin(db, { to: empfaenger.to, typ, jobId, variablen: empfaenger.variablen })
  );
}
