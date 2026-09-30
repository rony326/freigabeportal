import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup, getPersonById } from '../db/personenRepo.js';
import { getVorlage, renderTemplate } from './mailTemplates.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { getAktivenVertreter } from './vertretung.js';
import { reiheMailEin, stelleMailZu } from './mailZustellung.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';
const GRUPPE_ADMIN_TOKEN = 'gruppe:admin';

// sync-fehler (ChurchTools-Ausfall) und iban-warnung (Betrugsverdacht) sind betriebs-/
// sicherheitskritisch und ignorieren den globalen Batching-Schalter -- sie warten nie auf den
// nächsten Digest-Lauf. kk-beleg-eingegangen kommt dazu: die Person, die per Mail einen Beleg
// eingereicht hat, soll sofort den Ergänzen-Link bekommen statt bis zum nächsten Digest zu warten.
const IMMER_SOFORT_TYPEN = new Set(['sync-fehler', 'iban-warnung', 'kk-beleg-eingegangen']);

// The low-level "enqueue and try now" primitive for an already-rendered mail. /admin/mails'
// "erneut versenden" replays an already-rendered mail_log row verbatim through here and must
// bypass both the template layer (there's no `variablen` to re-render from) and the batching
// queue (a manual resend is always immediate).
//
// The row is stored as 'eingereiht' BEFORE the SMTP call (services/mailZustellung.js), so a
// failed or interrupted send is retried automatically by the mail-zustellung job with growing
// back-off. Never throws; returns { id, status } with status 'versendet' | 'eingereiht' (retry
// pending) | 'fehlgeschlagen'.
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
    // Only reachable if recording the attempt itself failed -- the row stays 'eingereiht' and the
    // lock expires, so the retry job picks it up.
    console.error('sendRenderedMail: Zustellversuch konnte nicht gespeichert werden', err);
    return { id, status: 'eingereiht', fehler: err.message };
  }
}

function renderBenachrichtigung(db, typ, variablen) {
  const vorlage = getVorlage(db, typ);
  const portalName = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
  const alleVariablen = { ...variablen, portalName };
  return { subject: renderTemplate(vorlage.betreff, alleVariablen), text: renderTemplate(vorlage.text, alleVariablen) };
}

// Synchronous: renders and durably enqueues one notification, without any SMTP call. Throws if the
// template cannot be rendered -- meant for callers that enqueue inside the same transaction as
// their own business marker (cronJobs.js reminders) and deliver afterwards via stelleEintraegeZu.
// Returns { id, status } with status 'eingereiht' or 'geplant' (batching).
export function reiheBenachrichtigungEin(db, { to, typ, jobId, variablen = {} }) {
  const { subject, text } = renderBenachrichtigung(db, typ, variablen);
  const geplant = getConfigValue(db, 'mail_batching_aktiv') === '1' && !IMMER_SOFORT_TYPEN.has(typ);
  // Batching aktiv: nur einreihen, kein SMTP-Call -- runMailDigestJob sammelt diese Zeile später
  // ein und verschickt sie als Teil der Digest-Mail des Empfängers.
  const id = reiheMailEin(db, { typ, jobId, empfaenger: to, betreff: subject, text, geplant });
  return { id, status: geplant ? 'geplant' : 'eingereiht' };
}

// Never throws on SMTP or template problems. Returns { id, status } with status 'versendet' |
// 'eingereiht' (retry pending) | 'geplant' (digest) | 'fehlgeschlagen'.
export async function sendNotification(db, mailer, { to, typ, jobId, variablen = {} }) {
  let eintrag;
  try {
    eintrag = reiheBenachrichtigungEin(db, { to, typ, jobId, variablen });
  } catch (err) {
    // logMailAttempt itself can fail here too (e.g. `typ` isn't even one of the values
    // mail_log's CHECK constraint allows -- a genuinely unknown typ is a programmer error that
    // never occurs via today's callers, but must still not escape this function).
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
    } else {
      empfaenger.add(zeile);
    }
  }
  return [...empfaenger];
}

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

// Wraps sendNotification so every call site that currently mails "the person responsible for
// this job" also reaches their active Ferienmodus-Stellvertreter, without each call site having
// to know about Ferienmodus itself. See docs/superpowers/specs/2026-09-07-ferienmodus-design.md.
// Returns one result per recipient (see sendNotification).
export async function sendNotificationMitVertretung(db, mailer, { person, typ, jobId, variablen }) {
  const ergebnisse = [];
  for (const empfaenger of vertretungsEmpfaenger(db, { person, variablen })) {
    ergebnisse.push(await sendNotification(db, mailer, { to: empfaenger.to, typ, jobId, variablen: empfaenger.variablen }));
  }
  return ergebnisse;
}

// Synchronous counterpart of sendNotificationMitVertretung for transactional enqueueing.
export function reiheBenachrichtigungMitVertretungEin(db, { person, typ, jobId, variablen }) {
  return vertretungsEmpfaenger(db, { person, variablen }).map((empfaenger) =>
    reiheBenachrichtigungEin(db, { to: empfaenger.to, typ, jobId, variablen: empfaenger.variablen })
  );
}
