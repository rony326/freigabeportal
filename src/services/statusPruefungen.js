import fs from 'node:fs';
import path from 'node:path';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { countZeitstempelUeberfaellig } from '../db/jobsRepo.js';
import { loadTsaCrls } from './tsaRevocation.js';
import { listPaketeOhneZeitstempel } from './auditNachweisJobs.js';
import { einrichtungsStand } from './ersteinrichtung.js';
import { pruefeTechnik } from './einrichtungTests.js';

const MIN = 60 * 1000;
const H = 60 * MIN;
const TAG = 24 * H;
const MAIL_FENSTER_MS = 24 * H;
const RANG = { ok: 0, warnung: 1, fehler: 2 };
const NICHT_EINGERICHTET = () => ({ status: 'ok', aktiv: false, grund: 'nicht eingerichtet' });

// Grenzwert aus admin_config; ungueltige oder fehlende Werte fallen auf den Standard zurueck.
export const DEFAULTS = {
  status_sicherung_warnung_stunden: 26,
  status_sicherung_fehler_stunden: 50,
  status_mail_wartezeit_fehler_minuten: 60,
  status_churchtools_warnung_stunden: 26,
  status_churchtools_fehler_stunden: 50,
  status_zeitstempel_crl_warnung_tage: 7,
  status_archiv_warnung_stunden: 48,
  status_archiv_fehler_tage: 7,
  status_speicher_warnung_prozent: 15,
  status_speicher_fehler_prozent: 5,
  zeitstempel_warnung_ab_stunden: 2,
  audit_zeitstempel_alarm_tage: 3,
};
function grenze(db, key) {
  const roh = getConfigValue(db, key);
  const wert = Number(roh);
  return roh !== null && roh !== '' && Number.isFinite(wert) && wert >= 0 ? wert : DEFAULTS[key];
}

const zeit = (iso) => Date.parse(iso);
const jetztMs = (ctx) => (ctx.jetzt ?? new Date()).getTime();

// Installationsdatum: aeltestes Audit-Ereignis, sonst jetzt (siehe Rulings).
function installationsMs(db, ctx) {
  const row = db.prepare('SELECT MIN(zeitpunkt) AS z FROM audit_ereignisse').get();
  const t = row?.z ? zeit(row.z) : NaN;
  return Number.isFinite(t) ? t : jetztMs(ctx);
}

// Gemeinsame Logik fuer "letzter Erfolg"-Dienste (Sicherung, ChurchTools).
function pruefeLetzterErfolg(db, ctx, { letzterErfolg, letzterLauf, warnH, fehlerH, name }) {
  const jetzt = jetztMs(ctx);
  const erfolgMs = letzterErfolg ? zeit(letzterErfolg) : NaN;
  if (!Number.isFinite(erfolgMs)) {
    const seitInstall = jetzt - installationsMs(db, ctx);
    if (seitInstall <= fehlerH * H) return { status: 'ok', grund: 'noch kein Lauf' };
    return { status: 'fehler', grund: 'noch nie erfolgreich' };
  }
  const alter = jetzt - erfolgMs;
  let status = 'ok';
  let grund = `${name} aktuell`;
  if (alter > fehlerH * H) { status = 'fehler'; grund = `letzter Erfolg vor mehr als ${fehlerH} Stunden`; }
  else if (alter > warnH * H) { status = 'warnung'; grund = `letzter Erfolg vor mehr als ${warnH} Stunden`; }
  else if (letzterLauf === 'fehler') { status = 'warnung'; grund = 'letzter Lauf fehlgeschlagen'; }
  return { status, grund, seit: letzterErfolg };
}

export function pruefeDatenbank(db) {
  try {
    db.prepare('SELECT 1').get();
    return { status: 'ok', grund: 'erreichbar' };
  } catch {
    return { status: 'fehler', grund: 'Datenbank nicht erreichbar' };
  }
}

export function pruefeSicherung(db, config, ctx = {}) {
  const erfolg = db.prepare("SELECT beendet_am FROM cron_log WHERE job = 'datenbank-sicherung' AND status = 'erfolg' ORDER BY id DESC LIMIT 1").get();
  const letzter = db.prepare("SELECT status FROM cron_log WHERE job = 'datenbank-sicherung' AND status != 'laufend' ORDER BY id DESC LIMIT 1").get();
  // Fehlgeschlagener letzter Lauf ist immer Fehler, auch ohne bisherigen Erfolg.
  if (letzter?.status === 'fehler') return { status: 'fehler', grund: 'Letzte Sicherung fehlgeschlagen', ...(erfolg?.beendet_am ? { seit: erfolg.beendet_am } : {}) };
  return pruefeLetzterErfolg(db, ctx, {
    letzterErfolg: erfolg?.beendet_am, letzterLauf: letzter?.status, name: 'Sicherung',
    warnH: grenze(db, 'status_sicherung_warnung_stunden'), fehlerH: grenze(db, 'status_sicherung_fehler_stunden'),
  });
}

export function pruefeMailversand(db, config, ctx = {}) {
  const jetzt = jetztMs(ctx);
  const wartegrenze = new Date(jetzt - grenze(db, 'status_mail_wartezeit_fehler_minuten') * MIN).toISOString();
  const fensterStart = new Date(jetzt - MAIL_FENSTER_MS).toISOString();
  // 'geplant' (Sammelmail) zaehlt nie als wartend.
  const wartend = db.prepare("SELECT COUNT(*) AS n FROM mail_log WHERE status = 'eingereiht' AND eingereiht_am < ?").get(wartegrenze).n;
  if (wartend > 0) return { status: 'fehler', grund: `${wartend} Mail(s) warten zu lange auf den Versand` };
  // Fehlversuch: endgueltig fehlgeschlagen, wiederholt (auch spaeter versendet) oder mit Fehlerdetails,
  // einschliesslich Sammelmail-Wiederholungen ('geplant' mit versuche > 0).
  const fehl = db.prepare(`SELECT COUNT(*) AS n FROM mail_log WHERE versucht_am >= ?
    AND (status = 'fehlgeschlagen' OR versuche > 1 OR fehler_details IS NOT NULL OR (status = 'geplant' AND versuche > 0))`).get(fensterStart).n;
  if (fehl > 0) return { status: 'warnung', grund: `${fehl} Mail(s) mit Fehlversuch in den letzten 24 Stunden` };
  const letzte = db.prepare("SELECT versendet_am FROM mail_log WHERE status = 'versendet' AND versendet_am IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  return { status: 'ok', grund: 'keine Störungen', ...(letzte ? { seit: letzte.versendet_am } : {}) };
}

export function pruefeChurchtools(db, config, ctx = {}) {
  const erfolg = db.prepare("SELECT beendet_am FROM sync_log WHERE status = 'erfolg' AND beendet_am IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  const letzter = db.prepare("SELECT status FROM sync_log WHERE beendet_am IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  return pruefeLetzterErfolg(db, ctx, {
    letzterErfolg: erfolg?.beendet_am, letzterLauf: letzter?.status === 'erfolg' ? 'erfolg' : letzter ? 'fehler' : null, name: 'Abgleich',
    warnH: grenze(db, 'status_churchtools_warnung_stunden'), fehlerH: grenze(db, 'status_churchtools_fehler_stunden'),
  });
}

export function pruefeZeitstempel(db, config, ctx = {}) {
  if (!String(getConfigValue(db, 'zeitstempel_tsa_url') ?? '').trim()) return NICHT_EINGERICHTET();
  const jetzt = jetztMs(ctx);
  const probleme = [];
  let status = 'ok';
  const hebe = (s, grund) => { if (RANG[s] > RANG[status]) status = s; probleme.push(grund); };

  if (ctx.tsaErgebnis?.erreichbar === false) hebe('fehler', 'Zeitstempeldienst nicht erreichbar');

  if (config?.tsaCrlFile) {
    try {
      const crls = (ctx.ladeCrls ?? loadTsaCrls)(config.tsaCrlFile);
      const enden = crls.map((c) => c.nextUpdate?.value?.getTime()).filter(Number.isFinite);
      if (!enden.length) throw new Error('kein nextUpdate');
      const frueh = Math.min(...enden);
      if (frueh <= jetzt) hebe('fehler', 'Sperrliste abgelaufen');
      else if (frueh - jetzt < grenze(db, 'status_zeitstempel_crl_warnung_tage') * TAG) hebe('warnung', 'Sperrliste läuft bald ab');
    } catch {
      hebe('warnung', 'Sperrliste nicht lesbar');
    }
  }

  const ueberfaellig = countZeitstempelUeberfaellig(db, grenze(db, 'zeitstempel_warnung_ab_stunden'));
  if (ueberfaellig > 0) hebe('warnung', `${ueberfaellig} Beleg(e) ohne Zeitstempel`);

  return { status, grund: probleme.length ? probleme.join('; ') : 'in Ordnung' };
}

export function pruefeAuditNachweis(db, config, ctx = {}) {
  if (String(getConfigValue(db, 'modul_audit_nachweis_aktiv') ?? '0') !== '1') return NICHT_EINGERICHTET();
  const offen = listPaketeOhneZeitstempel(db);
  if (!offen.length) return { status: 'ok', grund: 'alle Pakete mit Zeitstempel' };
  const aelteste = Math.min(...offen.map((p) => zeit(p.erstellt_am)).filter(Number.isFinite));
  const alter = jetztMs(ctx) - aelteste;
  const seit = new Date(aelteste).toISOString();
  if (alter > grenze(db, 'audit_zeitstempel_alarm_tage') * TAG) return { status: 'fehler', grund: `${offen.length} Paket(e) zu lange ohne Zeitstempel`, seit };
  return { status: 'warnung', grund: `${offen.length} Paket(e) ohne Zeitstempel`, seit };
}

export function pruefeArchivuebergabe(db, config, ctx = {}) {
  const jetzt = jetztMs(ctx);
  // Gesperrte (nicht abholbare) Belege zaehlen mit, daher der Hinweis im Grund.
  // Einzelbelege (abgeschlossen) und fertige Splitgruppen (Elternjob 'aufgesplittet', noch nicht abgeholt).
  // Bereit-Zeitpunkt der Gruppe: Gruppen-Zeitstempel, sonst letzter Abschluss eines Kindes.
  const row = db.prepare(`SELECT COUNT(*) AS n, MIN(bereit) AS aelteste FROM (
    SELECT abgeschlossen_am AS bereit FROM jobs WHERE status = 'abgeschlossen' AND aufgesplittet_von IS NULL AND abgeschlossen_am IS NOT NULL
    UNION ALL
    SELECT COALESCE(p.gruppe_zeitstempel_gesetzt_am, (SELECT MAX(c.abgeschlossen_am) FROM jobs c WHERE c.aufgesplittet_von = p.id), p.eingang_am) AS bereit
    FROM jobs p WHERE p.status = 'aufgesplittet' AND p.aufgesplittet_von IS NULL AND p.gruppe_pdf_pfad IS NOT NULL AND p.gruppe_abgeholt_am IS NULL)`).get();
  if (!row.n) return { status: 'ok', grund: 'nichts offen' };
  const alter = jetzt - zeit(row.aelteste);
  let status = 'ok';
  if (alter > grenze(db, 'status_archiv_fehler_tage') * TAG) status = 'fehler';
  else if (alter > grenze(db, 'status_archiv_warnung_stunden') * H) status = 'warnung';
  return { status, grund: status === 'ok' ? `${row.n} Beleg(e) noch nicht abgeholt (inkl. gesperrter Belege)` : `${row.n} Beleg(e) zu lange nicht abgeholt (inkl. gesperrter Belege)`, seit: row.aelteste };
}

export function pruefeSpeicher(db, config, ctx = {}) {
  let frei;
  try {
    const s = (ctx.statfs ?? fs.statfsSync)(path.dirname(config.dbPath));
    frei = (Number(s.bavail) / Number(s.blocks)) * 100;
    if (!Number.isFinite(frei)) throw new Error('ungueltig');
  } catch {
    return { status: 'ok', aktiv: false, grund: 'nicht prüfbar' };
  }
  const gerundet = Math.round(frei * 10) / 10;
  if (frei < grenze(db, 'status_speicher_fehler_prozent')) return { status: 'fehler', grund: `nur noch ${gerundet} % Speicher frei` };
  if (frei < grenze(db, 'status_speicher_warnung_prozent')) return { status: 'warnung', grund: `nur noch ${gerundet} % Speicher frei` };
  return { status: 'ok', grund: `${gerundet} % Speicher frei` };
}

const JOBS_FENSTER_MS = 7 * TAG;

// Letzter abgeschlossener Lauf je Job; wer seit 7 Tagen nichts protokolliert hat, zaehlt nicht mehr.
export function pruefeJobs(db, config, ctx = {}) {
  const ab = new Date(jetztMs(ctx) - JOBS_FENSTER_MS).toISOString();
  const rows = db.prepare(`SELECT c.job, c.status FROM cron_log c
    WHERE c.id = (SELECT MAX(id) FROM cron_log WHERE job = c.job AND status != 'laufend')
      AND COALESCE(c.beendet_am, c.gestartet_am) >= ? ORDER BY c.job`).all(ab);
  const kaputt = rows.filter((r) => r.status === 'fehler').map((r) => r.job);
  if (kaputt.length) return { status: 'warnung', grund: `Letzter Lauf fehlgeschlagen: ${kaputt.join(', ')}` };
  return { status: 'ok', grund: 'alle Läufe erfolgreich' };
}

export function pruefeSicherheitsalarme(db) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM sicherheitsalarme WHERE status != 'erledigt'").get().n;
  if (n > 0) return { status: 'fehler', grund: `${n} offene(r) Sicherheitsalarm(e)` };
  return { status: 'ok', grund: 'keine offenen Alarme' };
}

// Offene Pflichtschritte der Ersteinrichtung: nur eine Warnung, nie ein Fehler.
export function pruefeEinrichtung(db, config, ctx = {}) {
  const technik = ctx.technik ?? pruefeTechnik(config);
  const { pflichtOffen, pflichtGesamt } = einrichtungsStand(db, config, { jetzt: ctx.jetzt ?? new Date(), technik });
  if (pflichtOffen === 0) return { status: 'ok', grund: 'alle Pflichtschritte erledigt' };
  return { status: 'warnung', grund: `${pflichtOffen} von ${pflichtGesamt} Pflichtschritten offen` };
}

const PRUEFUNGEN = [
  ['datenbank', pruefeDatenbank],
  ['sicherung', pruefeSicherung],
  ['mailversand', pruefeMailversand],
  ['churchtools', pruefeChurchtools],
  ['zeitstempel', pruefeZeitstempel],
  ['audit_nachweis', pruefeAuditNachweis],
  ['archivuebergabe', pruefeArchivuebergabe],
  ['speicher', pruefeSpeicher],
  ['jobs', pruefeJobs],
  ['sicherheitsalarme', pruefeSicherheitsalarme],
  ['einrichtung', pruefeEinrichtung],
];

export function pruefeAlleDienste(db, config, { jetzt = new Date(), tsaErgebnis = null, statfs = fs.statfsSync, ladeCrls } = {}) {
  const ctx = { jetzt, tsaErgebnis, statfs, ladeCrls };
  const dienste = {};
  let status = 'ok';
  for (const [key, fn] of PRUEFUNGEN) {
    let r;
    try { r = fn(db, config, ctx); } catch { r = { status: 'fehler', grund: 'Prüfung fehlgeschlagen' }; }
    dienste[key] = r;
    if (RANG[r.status] > RANG[status]) status = r.status;
  }
  return { status, geprueft_am: jetzt.toISOString(), dienste };
}

export const STATUS_CACHE_TTL_MS = 30 * 1000;

// Gemeinsamer Zwischenspeicher fuer /healthz, Dashboard-Karte und Statusseite (eine Instanz pro App).
// neu=true umgeht ihn ("Jetzt neu pruefen"); leeren() nach geaenderten Grenzwerten.
export function createStatusCache({
  db, config, tsaErreichbarkeit = null, tsaVersuch, ttlMs = STATUS_CACHE_TTL_MS,
  pruefe = pruefeAlleDienste, jetzt = Date.now,
} = {}) {
  let eintrag = null;
  return {
    ergebnis({ neu = false } = {}) {
      const t = jetzt();
      if (!neu && eintrag && t - eintrag.zeit < ttlMs) return eintrag.wert;
      let tsaErgebnis = null;
      try { if (tsaErreichbarkeit) tsaErgebnis = tsaErreichbarkeit(db, config, tsaVersuch ? { versuch: tsaVersuch } : {}); } catch { /* bleibt null */ }
      const wert = pruefe(db, config, { jetzt: new Date(t), tsaErgebnis });
      eintrag = { zeit: t, wert };
      return wert;
    },
    leeren() { eintrag = null; },
  };
}
