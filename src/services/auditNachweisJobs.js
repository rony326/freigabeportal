import { auditedJob } from './auditOperation.js';
import { erstelleAuditExportPaket } from './auditExport.js';
import { stempleAuditPaket, tsaConfigAusDb } from './auditZeitstempel.js';
import { kanonischesJson } from './tsaNachweis.js';
import { resolveEmpfaenger, sendRenderedMail, sendNotification } from './notify.js';
import { getConfigValue, setConfigValue } from '../db/adminConfigRepo.js';

const TAG_MS = 24 * 3600 * 1000;
const ALARM_KEY = 'audit_zeitstempel_alarm_gesendet_am';

export function listPaketeOhneZeitstempel(db) {
  return db.prepare(`SELECT p.* FROM audit_export_pakete p
    LEFT JOIN audit_export_zeitstempel z ON z.paket_nr = p.id
    WHERE z.paket_nr IS NULL ORDER BY p.id`).all().map((row) => ({ ...row }));
}

export function ladeAuditZeitstempel(db, paketNr) {
  return db.prepare('SELECT * FROM audit_export_zeitstempel WHERE paket_nr = ?').get(paketNr);
}

function alarmSchwelleMs(db) {
  const tage = Number(getConfigValue(db, 'audit_zeitstempel_alarm_tage'));
  return (Number.isFinite(tage) && tage >= 1 ? tage : 3) * TAG_MS;
}

// Hoechstens alle 24 h eine Mail, solange das aelteste Paket laenger als die Schwelle ohne Zeitstempel ist.
async function alarmiereBeiRueckstand(db, config, mailer, offen, jetzt) {
  const aeltestes = offen[0];
  if (!aeltestes) return false;
  // Ohne TSA-Konfiguration bleibt der Rueckstand nur auf der Admin-Seite sichtbar, kein Dauer-Alarm.
  if (!tsaConfigAusDb(db, config)) return false;
  if (jetzt.getTime() - new Date(aeltestes.erstellt_am).getTime() <= alarmSchwelleMs(db)) return false;
  const zuletzt = Date.parse(getConfigValue(db, ALARM_KEY) ?? '');
  if (Number.isFinite(zuletzt) && jetzt.getTime() - zuletzt < TAG_MS) return false;
  const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sicherheitsalarm_empfaenger') ?? 'gruppe:admin').filter(Boolean);
  if (!empfaenger.length) return false;
  await sendRenderedMail(db, mailer, {
    to: empfaenger.join(', '),
    typ: 'sicherheitsalarm',
    jobId: null,
    subject: 'Freigabeportal: Audit-Pakete ohne Zeitstempel',
    text: `Für ${offen.length} Audit-Paket(e) liegt seit längerer Zeit kein Zeitstempel vor.\n\n`
      + `Ältestes Paket: Paketnummer ${aeltestes.id}, erstellt am ${aeltestes.erstellt_am}.\n\n`
      + 'Bitte die TSA-Konfiguration unter Admin → Zeitstempel prüfen: '
      + `${config.publicBaseUrl}/admin/zeitstempel\n\n${getConfigValue(db, 'seiten_titel') || 'Freigabeportal'}`,
  });
  setConfigValue(db, ALARM_KEY, jetzt.toISOString());
  return true;
}

async function runAuditExportJobInternal(db, config, mailer, { jetzt = new Date(), stemple = stempleAuditPaket } = {}) {
  if (getConfigValue(db, 'modul_audit_nachweis_aktiv') !== '1') return { status: 'uebersprungen' };
  let neuePakete = 0;
  while (erstelleAuditExportPaket(db, { jetzt })) neuePakete += 1;

  let gestempelt = 0;
  let error;
  const tsaConfig = tsaConfigAusDb(db, config);
  if (tsaConfig) {
    for (const paket of listPaketeOhneZeitstempel(db)) {
      try {
        const { token, genTime, nachweis } = await stemple(paket.paket_sha256, tsaConfig);
        db.prepare(`INSERT INTO audit_export_zeitstempel (paket_nr, token, gen_time, nachweis, erstellt_am)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(paket_nr) DO NOTHING`)
          .run(paket.id, token, genTime.toISOString(), kanonischesJson(nachweis), jetzt.toISOString());
        gestempelt += 1;
      } catch (err) {
        error = `Paket ${paket.id}: ${err.message}`;
        break;
      }
    }
  }

  const offen = listPaketeOhneZeitstempel(db);
  const alarmiert = await alarmiereBeiRueckstand(db, config, mailer, offen, jetzt);
  const result = { status: error ? 'fehler' : 'erfolg', neuePakete, gestempelt, ohneZeitstempel: offen.length, alarmiert };
  if (error) result.error = error;
  return result;
}

export const runAuditExportJob = auditedJob('audit-export', runAuditExportJobInternal);

const ZEITZONE = 'Europe/Zurich';
const ZULETZT_KEY = 'audit_pruefnummer_zuletzt_monat';
const RHYTHMUS_MONATE = { monatlich: null, quartalsweise: [1, 4, 7, 10], jaehrlich: [1] };

export function parseEmpfaengerListe(wert) {
  const adressen = [];
  const ungueltig = [];
  for (const roh of String(wert ?? '').split(',')) {
    const adresse = roh.trim();
    if (!adresse) continue;
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(adresse)) { if (!ungueltig.includes(adresse)) ungueltig.push(adresse); continue; }
    if (!adressen.includes(adresse)) adressen.push(adresse);
  }
  return { adressen, ungueltig };
}

export function formatierePruefnummer(hex) {
  return String(hex).match(/.{1,8}/g)?.join(' ') ?? '';
}

function zuericherTeile(datum) {
  const teile = new Intl.DateTimeFormat('en-US', {
    timeZone: ZEITZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(datum);
  const p = Object.fromEntries(teile.map((t) => [t.type, t.value]));
  return { jahr: p.year, monat: Number(p.month), tag: Number(p.day), stunde: p.hour === '24' ? '00' : p.hour, minute: p.minute };
}

// dd.MM.yyyy HH:mm in Zuercher Zeit
function formatiereZeit(wert) {
  const d = new Date(wert);
  if (Number.isNaN(d.getTime())) return String(wert ?? '');
  const z = zuericherTeile(d);
  return `${String(z.tag).padStart(2, '0')}.${String(z.monat).padStart(2, '0')}.${z.jahr} ${z.stunde}:${z.minute}`;
}

export function istVersandtag(jetzt, { rhythmus, tag }) {
  const z = zuericherTeile(jetzt);
  const monate = RHYTHMUS_MONATE[rhythmus] === undefined ? null : RHYTHMUS_MONATE[rhythmus];
  if (monate && !monate.includes(z.monat)) return false;
  return z.tag === Number(tag);
}

function revisionsEmpfaenger(db) {
  return parseEmpfaengerListe(getConfigValue(db, 'audit_revision_empfaenger')).adressen;
}

export async function sendeAuditPruefnummer(db, config, mailer) {
  const empfaenger = revisionsEmpfaenger(db);
  if (!empfaenger.length) return { status: 'kein_empfaenger' };
  const letztes = db.prepare('SELECT * FROM audit_export_pakete ORDER BY id DESC LIMIT 1').get();
  if (!letztes) return { status: 'kein_paket' };
  const erstes = db.prepare('SELECT * FROM audit_export_pakete ORDER BY id LIMIT 1').get();
  const zeitpunkt = (id) => db.prepare('SELECT zeitpunkt FROM audit_ereignisse WHERE id = ?').get(id)?.zeitpunkt;
  const anzahl = db.prepare('SELECT COALESCE(SUM(anzahl), 0) AS n FROM audit_export_pakete').get().n;
  const stempel = ladeAuditZeitstempel(db, letztes.id);
  const pruefseite = `${config.publicBaseUrl}/audit-pruefen`;
  const variablen = {
    paketNr: String(letztes.id),
    pruefnummer: formatierePruefnummer(letztes.paket_sha256),
    vonZeit: formatiereZeit(zeitpunkt(erstes.von_id)),
    bisZeit: formatiereZeit(zeitpunkt(letztes.bis_id)),
    anzahlEreignisse: String(anzahl),
    zeitstempelZeit: stempel ? formatiereZeit(stempel.gen_time) : 'noch keiner',
    ohneZeitstempel: String(listPaketeOhneZeitstempel(db).length),
    pruefseite,
    link: `${pruefseite}?paket=${letztes.id}&pruefnummer=${letztes.paket_sha256}`,
  };
  for (const to of empfaenger) {
    await sendNotification(db, mailer, { to, typ: 'audit-pruefnummer', jobId: null, variablen });
  }
  return { status: 'versendet', paketNr: letztes.id, empfaenger: empfaenger.length };
}

async function runAuditPruefnummerJobInternal(db, config, mailer, { jetzt = new Date() } = {}) {
  if (getConfigValue(db, 'modul_audit_nachweis_aktiv') !== '1') return { status: 'uebersprungen' };
  const rhythmus = getConfigValue(db, 'audit_pruefnummer_rhythmus') ?? 'monatlich';
  const tag = Number(getConfigValue(db, 'audit_pruefnummer_tag') ?? 1);
  if (!istVersandtag(jetzt, { rhythmus, tag })) return { status: 'uebersprungen' };
  const z = zuericherTeile(jetzt);
  const monat = `${z.jahr}-${String(z.monat).padStart(2, '0')}`;
  if (getConfigValue(db, ZULETZT_KEY) === monat) return { status: 'uebersprungen' };
  const result = await sendeAuditPruefnummer(db, config, mailer);
  if (result.status === 'versendet') setConfigValue(db, ZULETZT_KEY, monat);
  return { ...result, status: result.status === 'versendet' ? 'erfolg' : 'uebersprungen', grund: result.status };
}

export const runAuditPruefnummerJob = auditedJob('audit-pruefnummer', runAuditPruefnummerJobInternal);

function personName(person) {
  return `${person?.vorname ?? ''} ${person?.nachname ?? ''}`.trim() || 'unbekannt';
}

async function sendeAnAlle(db, mailer, adressen, subject, text) {
  for (const to of adressen) {
    await sendRenderedMail(db, mailer, { to, subject, text, typ: 'audit-pruefnummer', jobId: null });
  }
}

// zusaetzlicheEmpfaenger: z. B. die bisherigen Adressen, damit auch sie die Aenderung erfahren.
export async function meldeAuditNachweisAenderung(db, config, mailer, { aenderungen, person, zusaetzlicheEmpfaenger = [] }) {
  const portal = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
  const text = 'Guten Tag\n\nDie Einstellungen des Audit-Nachweises wurden geändert:\n\n'
    + aenderungen.map((a) => `- ${a}`).join('\n')
    + `\n\nGeändert von ${personName(person)} am ${formatiereZeit(new Date())}.\n\nFreundliche Grüsse\n${portal}`;
  const gesehen = new Set();
  const empfaenger = [...revisionsEmpfaenger(db), ...zusaetzlicheEmpfaenger].filter((a) => {
    const k = String(a).toLowerCase();
    if (!k || gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
  await sendeAnAlle(db, mailer, empfaenger, 'Freigabeportal: Einstellungen des Audit-Nachweises geändert', text);
}

export async function meldeAuditEmpfaengerWechsel(db, config, mailer, { alt, neu, person }) {
  const portal = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
  const altListe = parseEmpfaengerListe(alt).adressen;
  const neuListe = parseEmpfaengerListe(neu).adressen;
  const alle = [...new Set([...altListe, ...neuListe])];
  const text = 'Guten Tag\n\nDie Empfänger der Audit-Prüfnummer wurden geändert.\n\n'
    + `Bisher: ${altListe.join(', ') || '(keine)'}\nNeu: ${neuListe.join(', ') || '(keine)'}\n\n`
    + `Geändert von ${personName(person)} am ${formatiereZeit(new Date())}.\n\nFreundliche Grüsse\n${portal}`;
  await sendeAnAlle(db, mailer, alle, 'Freigabeportal: Empfänger der Audit-Prüfnummer geändert', text);
}
