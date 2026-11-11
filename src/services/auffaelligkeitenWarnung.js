// Eine Warn-Mail „Auffälligkeiten bei Kontierung“ (ersetzt die frühere iban-warnung). Immer sofort
// (notify.js IMMER_SOFORT_TYPEN). Empfänger: Freigeber 1 + 2 der betroffenen Konten, die kontierende
// Person und die unter iban_abweichung_empfaenger konfigurierten Adressen — jede Adresse einmal.
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { sendNotification, resolveEmpfaenger } from './notify.js';
import { kreditorNameVariablen } from './kreditorFelder.js';

export function auffaelligkeitenAlsText(befunde) {
  return befunde.map((b) => `- ${b.titel}: ${b.text}`).join('\n');
}

// Kurzfassung für den freigaben-Kommentar (Audit-Log).
export function bestaetigungsKommentar(befunde, bemerkung) {
  return befunde.map((b) => b.titel).join('; ') + (bemerkung ? ` — Wie geprüft: ${bemerkung}` : '');
}

export async function sendeAuffaelligkeitenWarnung(db, mailer, config, { job, kreditor, befunde, bemerkung, person, freigeberIds, link }) {
  const empfaenger = new Set();
  for (const personId of freigeberIds) {
    const freigeber = personId ? getPersonById(db, personId) : null;
    if (freigeber?.email) empfaenger.add(freigeber.email);
  }
  if (person.email) empfaenger.add(person.email);
  for (const email of resolveEmpfaenger(db, config, getConfigValue(db, 'iban_abweichung_empfaenger'))) empfaenger.add(email);

  const variablen = {
    jobDateiname: job.dateiname,
    ...kreditorNameVariablen(kreditor.name),
    auffaelligkeiten: auffaelligkeitenAlsText(befunde),
    bestaetigtVon: `${person.vorname} ${person.nachname}`,
    bemerkung: bemerkung || '–',
    link,
  };
  for (const to of empfaenger) {
    await sendNotification(db, mailer, { to, typ: 'auffaelligkeiten-warnung', jobId: job.id, variablen });
  }
}
