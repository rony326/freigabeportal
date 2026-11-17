// Meldung "IBAN eines Lieferanten hinzugefügt oder gelöscht" (Mailtyp `iban-aenderung`, Ereignis in
// services/benachrichtigungsEreignisse.js, docs/qr-bill-und-betrugserkennung.md). Vier-Augen-Gedanke: wer das Recht
// `kreditoren_verwalten` hat, kann allein eine IBAN ändern; die Buchhaltung und die Administration erfahren es immer.
//
// Wie die Warn-Mail der Auffälligkeiten: immer sofort (notify.js IMMER_SOFORT_TYPEN), IBAN nur gekürzt. Empfänger ist die
// unter `iban_aenderung_empfaenger` eingestellte Liste (Standard: Buchhaltung und Administration). Die ändernde Person wird
// NICHT herausgefiltert: ist sie Empfänger, bekommt auch sie die Mail, sie kann die Meldung also nicht unterdrücken.
import { getConfigValue, getDefaultConfigValue } from '../db/adminConfigRepo.js';
import { sendeNotificationsImHintergrund, resolveEmpfaenger } from './notify.js';
import { kreditorNameVariablen } from './kreditorFelder.js';
import { ibanKurz } from './ibanUtils.js';
import { formatZeitpunkt } from './auditLog.js';

/**
 * Reiht die Meldung für alle Empfänger ein (jede Adresse einmal) und stösst die Zustellung im Hintergrund an (kein Warten auf SMTP). Wirft nie: Mailprobleme dürfen die Änderung nicht
 * rückgängig machen (die Mail liegt in der Ausgangsablage und wird bei Fehlern wiederholt, siehe mailZustellung.js).
 * @param {object} config App-Konfiguration (Gruppen-IDs, publicBaseUrl); ohne sie ist keine Empfängerermittlung möglich
 * @param {object|null} mailer ohne Mailer wird nur eingereiht (der Job mail-zustellung sendet später)
 * @param {{kreditor: {id?: number, name: string}, iban: string, art: 'hinzugefuegt'|'geloescht', person: object, neuerLieferant?: boolean}} aenderung
 */
export async function meldeIbanAenderung(db, config, mailer, { kreditor, iban, art, person, neuerLieferant = false }) {
  try {
    if (!config?.churchtools) return;
    const konfig = getConfigValue(db, 'iban_aenderung_empfaenger') ?? getDefaultConfigValue('iban_aenderung_empfaenger');
    const empfaenger = resolveEmpfaenger(db, config, konfig).filter(Boolean);
    if (empfaenger.length === 0) {
      console.warn('IBAN-Änderung: kein Empfänger für die Meldung gefunden (Einstellung "IBAN eines Lieferanten geändert" prüfen).');
      return;
    }
    const aktion = art === 'geloescht' ? 'gelöscht' : `hinzugefügt${neuerLieferant ? ' (neuer Lieferant angelegt)' : ''}`;
    const basis = (config.publicBaseUrl || '').replace(/\/$/, '');
    const variablen = {
      ...kreditorNameVariablen(kreditor.name),
      iban: ibanKurz(iban),
      aktion,
      geaendertVon: `${person?.vorname ?? ''} ${person?.nachname ?? ''}`.trim() || 'unbekannt',
      zeitpunkt: formatZeitpunkt(new Date().toISOString(), true),
      // Mit bekannter ID direkt auf die Kreditor-Seite (IBANs dort), sonst auf die Liste.
      link: kreditor.id ? `${basis}/admin/kreditoren/${kreditor.id}/bearbeiten` : `${basis}/admin/kreditoren`,
    };
    // Nur einreihen; der SMTP-Versand läuft im Hintergrund und blockiert die Anfrage nicht (Wiederholung: Job mail-zustellung).
    sendeNotificationsImHintergrund(db, mailer, empfaenger.map((to) => ({ to, typ: 'iban-aenderung', jobId: null, variablen })));
  } catch (err) {
    console.error('IBAN-Änderung: Meldung konnte nicht verschickt werden', err);
  }
}
