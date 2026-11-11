// In-Process-Scheduler: der dauerhaft laufende Node-Prozess plant alle 16 Hintergrund-Jobs selbst (kein externer Task-Scheduler nötig).
// Zeiten und Intervalle stehen in `admin_config` (Admin → Geplante Jobs) und werden vor jedem Lauf neu gelesen. Beschreibung der Jobs:
// docs/geplante-jobs-und-benachrichtigungen.md. Neuer Job: in cronJobs.js implementieren, hier in `startScheduler` einhängen, in
// routes/cron.js bzw. routes/admin/geplanteJobs.js für den manuellen Aufruf freigeben und den Zeitplan in adminConfigRepo.js ergänzen.

import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runDatenbankSicherungJob, runSplitGruppenNachholenJob, runMailDigestJob, runFreigabe2ErinnerungenJob, runRapportErinnerungenJob, runKkBelegErinnerungenJob, runMailZustellungJob } from './cronJobs.js';
import { istWartungsmodusAktiv } from './wartungsmodus.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { runSicherheitsalarmeJob } from './sicherheitsalarme.js';
import { runTsaCrlAktualisierungJob } from './tsaCrlUpdate.js';
import { runAuditExportJob, runAuditPruefnummerJob } from './auditNachweisJobs.js';
import { runNutzungsdatenBereinigungJob } from './nutzungBereinigung.js';

const ZEITZONE = 'Europe/Zurich';
const MINUTE_MS = 60 * 1000;

// Schweizer Organisation, fest eingetragen statt aus der Zeitzone des Server-Betriebssystems abgeleitet — das Hosting bei Infomaniak
// läuft in UTC, und "nachts" meint hier immer Europe/Zurich, egal wo der Prozess gerade läuft.
//
// Für Unit-Tests exportiert: Millisekunden ab `now` bis zum nächsten Auftreten von `stunde:minute` in `zeitzone` — heute, wenn die
// Zeit noch nicht vorbei ist, sonst morgen. Wird nach jedem Lauf frisch berechnet (siehe planeTaeglich) statt von einem festen
// setInterval über 24 h getrieben, das bei jeder Schweizer Zeitumstellung still um eine Stunde abdriften würde; der eine verbleibende
// Randfall ist der Tag der Zeitumstellung selbst, an dem die berechnete Wartezeit um bis zu eine Stunde danebenliegen kann —
// für einen nur nächtlichen Wartungsjob akzeptabel und die Komplexität nicht wert, ihn ganz zu schliessen.
export function msBisNaechstesTaeglichesEreignis(stunde, minute, now = new Date(), zeitzone = ZEITZONE) {
  const teile = new Intl.DateTimeFormat('en-US', {
    timeZone: zeitzone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const teil = (typ) => Number(teile.find((t) => t.type === typ).value);
  const aktuelleSekunden = teil('hour') * 3600 + teil('minute') * 60 + teil('second');
  const zielSekunden = stunde * 3600 + minute * 60;
  let deltaSekunden = zielSekunden - aktuelleSekunden;
  if (deltaSekunden <= 0) deltaSekunden += 24 * 3600;
  return deltaSekunden * 1000;
}

// Zahl aus dem Konfigurationswert, sonst der Standard.
function zahlOderStandard(wert, standard) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : standard;
}

// stundeGetter/minuteGetter (keine festen Zahlen), damit eine unter /admin/geplante-jobs gespeicherte Zeitplanänderung ab dem nächsten
// Tick wirkt, ohne Prozessneustart. Ein Lauf überschneidet sich nie mit dem vorherigen (`laeuft`-Sperre).
function planeTaeglich(stundeGetter, minuteGetter, aufgabe) {
  let laeuft = false;
  async function tick() {
    if (!laeuft) {
      laeuft = true;
      try {
        await aufgabe();
      } catch (err) {
        console.error('Geplante tägliche Aufgabe fehlgeschlagen:', err.message);
      } finally {
        laeuft = false;
      }
    }
    setTimeout(tick, msBisNaechstesTaeglichesEreignis(stundeGetter(), minuteGetter()));
  }
  setTimeout(tick, msBisNaechstesTaeglichesEreignis(stundeGetter(), minuteGetter()));
}

// intervallMsGetter wird vor jeder Neuplanung neu gelesen (rekursives setTimeout, kein setInterval), aus demselben Grund wie bei
// planeTaeglich oben: Eine gespeicherte Intervalländerung gilt ab dem nächsten Tick.
function planeIntervall(intervallMsGetter, aufgabe) {
  let laeuft = false;
  function schedule() {
    setTimeout(async () => {
      if (!laeuft) {
        laeuft = true;
        try {
          await aufgabe();
        } catch (err) {
          console.error('Geplante Aufgabe fehlgeschlagen:', err.message);
        } finally {
          laeuft = false;
        }
      }
      schedule();
    }, intervallMsGetter());
  }
  schedule();
}

// Ersetzt das externe Setup "Infomaniak-Task-Scheduler ruft /internal/cron/* im Takt auf" (README) für Hosting-Pläne, auf denen es das
// nicht gibt — der dauerhaft laufende Node-Prozess plant dieselben Jobs selbst und liest den Zeitplan bei jedem Tick aus admin_config
// (einstellbar unter /admin/geplante-jobs). Die HTTP-Endpunkte in routes/cron.js bestehen weiter für manuelles/bedarfsweises Auslösen;
// dies ist nur ein zusätzlicher, selbstgenügsamer Auslösepfad, der von keinem externen Scheduler abhängt.
//
// `jobs` ist nur deshalb austauschbar (Standard: die echten Funktionen aus cronJobs.js), damit Tests Attrappen einsetzen können, ohne
// ChurchTools/SMTP/das Dateisystem nachzubilden.
/**
 * Startet alle geplanten Jobs (siehe Kopfkommentar). Im Wartungsmodus pausieren alle ausser der Datenbank-Sicherung.
 * @param {{db: object, config: object, mailer: object, jobs?: object}} opts
 */
export function startScheduler({
  db,
  config,
  mailer,
  jobs: {
    runSyncPersonenJob: syncJob,
    runPoolErinnerungenJob: erinnerungenJob,
    runPdfBereinigungJob: bereinigungJob,
    runZeitstempelNachholenJob: zeitstempelJob,
    runDatenbankSicherungJob: sicherungJob,
    runSplitGruppenNachholenJob: splitGruppenJob,
    runMailDigestJob: mailDigestJob,
    runFreigabe2ErinnerungenJob: freigabe2ErinnerungenJob,
    runKkBelegErinnerungenJob: kkBelegErinnerungenJob,
    runRapportErinnerungenJob: rapportErinnerungenJob = async () => ({ status: 'uebersprungen' }),
    // Aeltere Test-Fakes ohne diesen Eintrag bekommen einen wirkungslosen Platzhalter.
    runSicherheitsalarmeJob: sicherheitsalarmeJob = async () => ({ status: 'uebersprungen' }),
    runMailZustellungJob: mailZustellungJob = async () => ({ status: 'uebersprungen' }),
    runTsaCrlAktualisierungJob: tsaCrlJob = async () => ({ status: 'uebersprungen' }),
    runAuditExportJob: auditExportJob = async () => ({ status: 'uebersprungen' }),
    runAuditPruefnummerJob: auditPruefnummerJob = async () => ({ status: 'uebersprungen' }),
    runNutzungsdatenBereinigungJob: nutzungBereinigungJob = async () => ({ status: 'uebersprungen' }),
  } = {
    runSyncPersonenJob,
    runPoolErinnerungenJob,
    runPdfBereinigungJob,
    runZeitstempelNachholenJob,
    runDatenbankSicherungJob,
    runSplitGruppenNachholenJob,
    runMailDigestJob,
    runFreigabe2ErinnerungenJob,
    runKkBelegErinnerungenJob,
    runRapportErinnerungenJob,
    runSicherheitsalarmeJob,
    runMailZustellungJob,
    runTsaCrlAktualisierungJob,
    runAuditExportJob,
    runAuditPruefnummerJob,
    runNutzungsdatenBereinigungJob,
  },
}) {
  // Wartungsmodus: alle geplanten Jobs pausieren (verpasste Läufe verfallen; Intervalljobs laufen beim
  // nächsten Tick, tägliche zur nächsten Fälligkeit). Ausnahme: die Datenbank-Sicherung, sie liest nur.
  // (Jobs mit `trotzWartung` laufen auch im Wartungsmodus.)
  const mitWartung = (aufgabe, trotzWartung) => async () => {
    if (!trotzWartung && istWartungsmodusAktiv(db)) return;
    return aufgabe();
  };
  const scheduleDaily = (stunde, minute, aufgabe, { trotzWartung = false } = {}) => planeTaeglich(stunde, minute, mitWartung(aufgabe, trotzWartung));
  const scheduleInterval = (intervall, aufgabe, { trotzWartung = false } = {}) => planeIntervall(intervall, mitWartung(aufgabe, trotzWartung));

  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_sync_personen_stunde'), 2),
    () => zahlOderStandard(getConfigValue(db, 'cron_sync_personen_minute'), 0),
    async () => {
      const result = await syncJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter sync-personen-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_pdf_bereinigung_stunde'), 2),
    () => zahlOderStandard(getConfigValue(db, 'cron_pdf_bereinigung_minute'), 30),
    () => {
      const result = bereinigungJob(db, config);
      if (result.status === 'fehler') console.error('Geplanter pdf-bereinigung-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten'), 60) * MINUTE_MS,
    async () => {
      const result = await erinnerungenJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter pool-erinnerungen-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'), 60) * MINUTE_MS,
    async () => {
      const result = await freigabe2ErinnerungenJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter freigabe2-erinnerungen-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_rapport_erinnerungen_intervall_minuten'), 60) * MINUTE_MS,
    async () => {
      const result = await rapportErinnerungenJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter rapport-erinnerungen-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten'), 5) * MINUTE_MS,
    async () => {
      const result = await zeitstempelJob(db, config);
      if (result.status === 'fehler') console.error('Geplanter zeitstempel-nachholen-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_split_gruppen_nachholen_intervall_minuten'), 15) * MINUTE_MS,
    async () => {
      const result = await splitGruppenJob(db, config);
      if (result.status === 'fehler') console.error('Geplanter split-gruppen-nachholen-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'backup_cron_stunde'), 3),
    () => zahlOderStandard(getConfigValue(db, 'backup_cron_minute'), 0),
    () => {
      const result = sicherungJob(db, config);
      if (result.status === 'fehler') console.error('Geplanter datenbank-sicherung-Lauf fehlgeschlagen:', result.error);
    },
    { trotzWartung: true }
  );

  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'mail_batching_stunde'), 7),
    () => zahlOderStandard(getConfigValue(db, 'mail_batching_minute'), 0),
    async () => {
      const result = await mailDigestJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter mail-digest-Lauf fehlgeschlagen:', result.error);
    }
  );

  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_kk_beleg_erinnerungen_stunde'), 8),
    () => zahlOderStandard(getConfigValue(db, 'cron_kk_beleg_erinnerungen_minute'), 0),
    async () => {
      const result = await kkBelegErinnerungenJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter kk-beleg-erinnerungen-Lauf fehlgeschlagen:', result.error);
    }
  );

  // Wiederholt eingereihte Mails nach SMTP-Fehlern oder Neustart (services/mailZustellung.js).
  // Läuft kurz nach dem Start und danach im Intervall -- ohne fällige Mails ohne Protokolleintrag.
  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_mail_zustellung_intervall_minuten'), 5) * MINUTE_MS,
    async () => {
      const result = await mailZustellungJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter mail-zustellung-Lauf mit Zustellfehlern:', result.error);
    }
  );

  // Erneuert die lokalen TSA-Sperrlisten (nur mit TSA_CRL_AUTO_UPDATE=true, services/tsaCrlUpdate.js).
  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_tsa_crl_stunde'), 4),
    () => zahlOderStandard(getConfigValue(db, 'cron_tsa_crl_minute'), 15),
    async () => {
      const result = await tsaCrlJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplante TSA-Sperrlisten-Erneuerung fehlgeschlagen:', result.error);
    }
  );

  // Naechtlicher Audit-Export mit RFC3161-Zeitstempel (services/auditNachweisJobs.js).
  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_audit_export_stunde'), 3),
    () => zahlOderStandard(getConfigValue(db, 'cron_audit_export_minute'), 15),
    async () => {
      const result = await auditExportJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter audit-export-Lauf fehlgeschlagen:', result.error);
    }
  );

  // Loescht Nutzungsdaten nach Ablauf der Aufbewahrungsfrist (services/nutzungBereinigung.js).
  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_nutzungsdaten_bereinigung_stunde'), 3),
    () => zahlOderStandard(getConfigValue(db, 'cron_nutzungsdaten_bereinigung_minute'), 45),
    async () => {
      const result = await nutzungBereinigungJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplante nutzungsdaten-bereinigung fehlgeschlagen:', result.error);
    }
  );

  // Taeglicher Lauf; versendet nur am konfigurierten Versandtag (siehe auditNachweisJobs.js).
  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_audit_pruefnummer_stunde'), 7),
    () => zahlOderStandard(getConfigValue(db, 'cron_audit_pruefnummer_minute'), 0),
    async () => {
      const result = await auditPruefnummerJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter audit-pruefnummer-Lauf fehlgeschlagen:', result.error);
    }
  );

  // Alarmierung offener Backup-Loeschabsichten (services/sicherheitsalarme.js). Fehlschlaege werden
  // dort persistiert und mit wachsendem Abstand wiederholt.
  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_sicherheitsalarme_intervall_minuten'), 30) * MINUTE_MS,
    async () => {
      const result = await sicherheitsalarmeJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter sicherheitsalarme-Lauf fehlgeschlagen:', result.error || result.fehler);
    }
  );
}
