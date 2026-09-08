import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup, getPersonById } from '../db/personenRepo.js';
import { getVorlage, renderTemplate } from './mailTemplates.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { getAktivenVertreter } from './vertretung.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';
const GRUPPE_ADMIN_TOKEN = 'gruppe:admin';

// sync-fehler (ChurchTools-Ausfall) und iban-warnung (Betrugsverdacht) sind betriebs-/
// sicherheitskritisch und ignorieren den globalen Batching-Schalter -- sie warten nie auf den
// nächsten Digest-Lauf.
const IMMER_SOFORT_TYPEN = new Set(['sync-fehler', 'iban-warnung']);

// The low-level "send now and log the attempt" primitive -- what sendNotification used to be
// before templating/batching existed. Kept as its own export because /admin/mails' "erneut
// versenden" replays an already-rendered mail_log row verbatim and must bypass both the template
// layer (there's no `variablen` to re-render from) and the batching queue (a manual resend is
// always immediate).
export async function sendRenderedMail(db, mailer, { to, subject, text, typ, jobId }) {
  try {
    await mailer.sendMail({ to, subject, text });
    logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'versendet' });
  } catch (err) {
    try {
      logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'fehlgeschlagen', fehlerDetails: err.message });
    } catch (logErr) {
      console.error('sendRenderedMail: logMailAttempt failed while recording a failed send', logErr);
    }
  }
}

export async function sendNotification(db, mailer, { to, typ, jobId, variablen = {} }) {
  let subject;
  let text;
  try {
    const vorlage = getVorlage(db, typ);
    const portalName = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
    const alleVariablen = { ...variablen, portalName };
    subject = renderTemplate(vorlage.betreff, alleVariablen);
    text = renderTemplate(vorlage.text, alleVariablen);
  } catch (err) {
    // logMailAttempt itself can fail here too (e.g. `typ` isn't even one of the values
    // mail_log's CHECK constraint allows -- a genuinely unknown typ is a programmer error that
    // never occurs via today's callers, but must still not escape this function). Mirrors the
    // same nested try/catch sendRenderedMail already uses for its own failed-send logging.
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
    return;
  }

  const batchingAktiv = getConfigValue(db, 'mail_batching_aktiv') === '1';
  if (!batchingAktiv || IMMER_SOFORT_TYPEN.has(typ)) {
    await sendRenderedMail(db, mailer, { to, subject, text, typ, jobId });
    return;
  }

  // Batching aktiv: nur protokollieren, kein SMTP-Call -- runMailDigestJob sammelt diese Zeile
  // später ein und verschickt sie als Teil der Digest-Mail des Empfängers.
  logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'geplant' });
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

// Wraps sendNotification so every call site that currently mails "the person responsible for
// this job" also reaches their active Ferienmodus-Stellvertreter, without each call site having
// to know about Ferienmodus itself. See docs/superpowers/specs/2026-09-07-ferienmodus-design.md.
export async function sendNotificationMitVertretung(db, mailer, { person, typ, jobId, variablen }) {
  await sendNotification(db, mailer, {
    to: person.email,
    typ,
    jobId,
    variablen: { ...variablen, empfaengerName: `${person.vorname} ${person.nachname}` },
  });

  const vertreterId = getAktivenVertreter(db, person.churchtools_person_id);
  if (!vertreterId) return;
  const vertreter = getPersonById(db, vertreterId);
  if (!vertreter) return;

  await sendNotification(db, mailer, {
    to: vertreter.email,
    typ,
    jobId,
    variablen: {
      ...variablen,
      empfaengerName: `${vertreter.vorname} ${vertreter.nachname}`,
      grund: `(Als Stellvertreter für ${person.vorname} ${person.nachname} im Ferienmodus) ${variablen.grund}`,
    },
  });
}
