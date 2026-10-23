import { auditedJob } from './auditOperation.js';
import { erstelleAuditExportPaket } from './auditExport.js';
import { stempleAuditPaket, tsaConfigAusDb } from './auditZeitstempel.js';
import { kanonischesJson } from './tsaNachweis.js';
import { resolveEmpfaenger, sendRenderedMail } from './notify.js';
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
