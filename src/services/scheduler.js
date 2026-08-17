import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob } from './cronJobs.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

const ZEITZONE = 'Europe/Zurich';
const MINUTE_MS = 60 * 1000;

// Swiss org, hardcoded rather than derived from the server's OS timezone — Infomaniak's hosting
// runs in UTC, and "nachts" (nightly) here always means Europe/Zurich local time regardless of
// where the process happens to run.
//
// Exported for unit testing: milliseconds from `now` until the next occurrence of `stunde:minute`
// in `zeitzone` — later today if that time hasn't passed yet, otherwise tomorrow. Recomputed fresh
// after every run (see scheduleDaily) rather than driven by a fixed 24h setInterval, which would
// silently drift by an hour across each Swiss clock change; the one remaining edge case is the
// day of the DST change itself, where the computed delay can be off by up to an hour — acceptable
// for a once-nightly maintenance job, not worth the complexity to close entirely.
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

function zahlOderStandard(wert, standard) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : standard;
}

// stundeGetter/minuteGetter (not fixed numbers) so a schedule change saved in
// /admin/geplante-jobs takes effect from the next tick onward, without a process restart.
function scheduleDaily(stundeGetter, minuteGetter, aufgabe) {
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

// intervallMsGetter is re-read before every reschedule (recursive setTimeout, not setInterval)
// for the same reason as scheduleDaily above: a saved interval change applies to the next tick.
function scheduleInterval(intervallMsGetter, aufgabe) {
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

// Replaces the external "Infomaniak Task Scheduler calls /internal/cron/* on a timer" setup
// (README) for hosting plans where that isn't actually available — the always-running Node
// process schedules the same three jobs itself, reading their schedule from admin_config
// (configurable under /admin/geplante-jobs) on every tick. The HTTP endpoints in routes/cron.js
// still exist for manual/on-demand triggering; this is just an additional, self-sufficient
// trigger path that doesn't depend on any external scheduler at all.
//
// `jobs` is injectable (defaults to the real cronJobs.js functions) purely so tests can swap in
// fakes without needing to fake ChurchTools/SMTP/the filesystem.
export function startScheduler({
  db,
  config,
  mailer,
  jobs: { runSyncPersonenJob: syncJob, runPoolErinnerungenJob: erinnerungenJob, runPdfBereinigungJob: bereinigungJob } = {
    runSyncPersonenJob,
    runPoolErinnerungenJob,
    runPdfBereinigungJob,
  },
}) {
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
}
