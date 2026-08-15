import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup } from '../db/personenRepo.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';

export async function sendNotification(db, mailer, { to, subject, text, typ, jobId }) {
  try {
    await mailer.sendMail({ to, subject, text });
    logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'versendet' });
  } catch (err) {
    try {
      logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'fehlgeschlagen', fehlerDetails: err.message });
    } catch (logErr) {
      console.error('sendNotification: logMailAttempt failed while recording a failed send', logErr);
    }
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
    } else {
      empfaenger.add(zeile);
    }
  }
  return [...empfaenger];
}
