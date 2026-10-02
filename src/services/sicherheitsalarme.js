import { randomUUID } from 'node:crypto';
import { currentAuditActor } from './auditContext.js';
import { auditedJob } from './auditOperation.js';
import { listUnresolvedBackupDeletions } from './backupAudit.js';
import { resolveEmpfaenger } from './notify.js';
import { logMailAttempt } from '../db/mailLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

// Alarmierung offener Backup-Loeschabsichten ueber den bestehenden Mailweg (mailer + mail_log).
//
// - Erkennung ist wiederholbar: jeder Lauf liest alle offenen Absichten aus dem Auditprotokoll.
// - Deduplizierung ist persistent: je Absicht genau eine Zeile (UNIQUE alarm_typ/schluessel).
// - Versand: faellige Alarme werden unter einer befristeten Sperre beansprucht, sodass parallele
//   Laeufe nicht doppelt senden. Fehler fuehren zu Wiederholung mit wachsendem Abstand. Ein Absturz
//   nach dem Versand, aber vor dem Speichern, fuehrt nach Sperrablauf zu erneutem Versand
//   (mindestens einmal, nicht genau einmal).
// - Der Alarm liest das Auditprotokoll nur. Er markiert eine Absicht nie als geklaert; das bleibt
//   der manuellen Pruefung (backupAudit.reviewBackupDeletion) vorbehalten. Wird eine Absicht
//   zwischenzeitlich geklaert, endet nur der Alarm ('erledigt').
// - Mails enthalten Absichts-ID, Backup-Dateiname und Zeitpunkt, keine Schluessel oder Inhalte.

export const ALARM_TYP = 'backup_loeschung_offen';
export const MINDESTALTER_MS = 30 * 60 * 1000;
export const SPERRE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const BASIS_BACKOFF_MS = 5 * 60 * 1000;
const MAX_ALARME_PRO_MAIL = 50;

function iso(ms) { return new Date(ms).toISOString(); }

function alleOffenenAbsichten(db) {
  const offen = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const seite = listUnresolvedBackupDeletions(db, { before, limit: 100 });
    offen.push(...seite);
    if (seite.length < 100) return offen;
    before = seite.at(-1).id;
  }
}

function schreibeAudit(db, aktion, nachher) {
  const actor = currentAuditActor();
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, ?, ?, 'sicherheitsalarm', ?, ?, ?)`).run(new Date().toISOString(), actor.id, actor.name, ALARM_TYP, aktion, JSON.stringify(nachher));
}

function inTransaktion(db, action) {
  if (db.isTransaction) throw new Error('Sicherheitsalarme benoetigen eine eigene Transaktion.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

// Schritt 1: Zustand abgleichen (neue Alarme anlegen, geklaerte beenden, Erinnerungen faellig machen).
export function erkenneOffeneBackupLoeschungen(db, { jetzt = Date.now(), mindestAlterMs = MINDESTALTER_MS } = {}) {
  return inTransaktion(db, () => {
    const offen = alleOffenenAbsichten(db);
    const offeneIds = new Set(offen.map((absicht) => String(absicht.id)));
    let neu = 0;
    for (const absicht of offen) {
      if (Date.parse(absicht.zeitpunkt) > jetzt - mindestAlterMs) continue;
      neu += Number(db.prepare(`INSERT INTO sicherheitsalarme (alarm_typ, schluessel, erkannt_am, naechster_versuch_am)
        VALUES (?, ?, ?, ?) ON CONFLICT(alarm_typ, schluessel) DO NOTHING`).run(ALARM_TYP, String(absicht.id), iso(jetzt), iso(jetzt)).changes);
    }
    let erledigt = 0;
    for (const alarm of db.prepare("SELECT id, schluessel FROM sicherheitsalarme WHERE alarm_typ = ? AND status <> 'erledigt'").all(ALARM_TYP)) {
      if (offeneIds.has(alarm.schluessel)) continue;
      db.prepare("UPDATE sicherheitsalarme SET status = 'erledigt', erledigt_am = ?, sperre_token = NULL, sperre_bis = NULL WHERE id = ?").run(iso(jetzt), alarm.id);
      erledigt += 1;
    }
    const wiederholungStunden = Number(getConfigValue(db, 'sicherheitsalarm_wiederholung_stunden') ?? 24);
    if (Number.isFinite(wiederholungStunden) && wiederholungStunden > 0) {
      db.prepare(`UPDATE sicherheitsalarme SET status = 'ausstehend', erinnerungen = erinnerungen + 1, naechster_versuch_am = ?
        WHERE alarm_typ = ? AND status = 'versendet' AND versendet_am <= ?`).run(iso(jetzt), ALARM_TYP, iso(jetzt - wiederholungStunden * 3600 * 1000));
    }
    return { neu, erledigt, offen: offen.length };
  });
}

function beanspruche(db, jetzt) {
  const token = randomUUID();
  return inTransaktion(db, () => {
    const faellig = db.prepare(`SELECT * FROM sicherheitsalarme WHERE alarm_typ = ? AND status = 'ausstehend'
      AND naechster_versuch_am <= ? AND (sperre_bis IS NULL OR sperre_bis <= ?) ORDER BY id LIMIT ?`)
      .all(ALARM_TYP, iso(jetzt), iso(jetzt), MAX_ALARME_PRO_MAIL);
    for (const alarm of faellig) {
      db.prepare('UPDATE sicherheitsalarme SET sperre_token = ?, sperre_bis = ? WHERE id = ?').run(token, iso(jetzt + SPERRE_MS), alarm.id);
    }
    return { token, alarme: faellig };
  });
}

function mailInhalt(db, config, absichten) {
  const zeilen = absichten.map((a) => `- Vorgang ${a.id}: ${a.dateiname} (Absicht vom ${a.zeitpunkt}${a.operation_id ? `, operationId ${a.operation_id}` : ''})`);
  return {
    subject: `Freigabeportal: ${absichten.length} ungeklaerte Backup-Loeschung(en)`,
    text: `Fuer folgende Backup-Loeschungen fehlt ein Ergebnisprotokoll. Ob die Datei entfernt wurde, ist ungeklaert.\n\n${zeilen.join('\n')}\n\n`
      + 'Bitte Dateibestand pruefen und den Vorgang unter Admin -> Datenbank-Backup begruendet klaeren. '
      + 'Diese Nachricht klaert keinen Vorgang.\n\n'
      + `${config.publicBaseUrl ? `${config.publicBaseUrl}/admin/backup\n\n` : ''}${getConfigValue(db, 'seiten_titel') || 'Freigabeportal'}`,
  };
}

function fehlerCode(err) {
  if (typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)) return err.code;
  if (typeof err?.responseCode === 'number') return `SMTP_${err.responseCode}`;
  return 'VERSAND_FEHLGESCHLAGEN';
}

// Schritt 2: faellige Alarme beanspruchen und gebuendelt versenden.
export async function versendeFaelligeAlarme(db, config, mailer, { jetzt = Date.now() } = {}) {
  const { token, alarme } = beanspruche(db, jetzt);
  if (!alarme.length) return { versendet: 0, fehlgeschlagen: 0, erledigt: 0 };
  // Vor dem Versand erneut pruefen: zwischenzeitlich geklaerte Absichten nicht mehr melden.
  const offen = new Map(alleOffenenAbsichten(db).map((absicht) => [String(absicht.id), absicht]));
  const aktuell = alarme.filter((alarm) => offen.has(alarm.schluessel));
  const erledigt = alarme.filter((alarm) => !offen.has(alarm.schluessel));
  inTransaktion(db, () => {
    for (const alarm of erledigt) {
      db.prepare("UPDATE sicherheitsalarme SET status = 'erledigt', erledigt_am = ?, sperre_token = NULL, sperre_bis = NULL WHERE id = ? AND sperre_token = ?").run(iso(jetzt), alarm.id, token);
    }
  });
  if (!aktuell.length) return { versendet: 0, fehlgeschlagen: 0, erledigt: erledigt.length };

  const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sicherheitsalarm_empfaenger') ?? 'gruppe:admin').filter(Boolean);
  const { subject, text } = mailInhalt(db, config, aktuell.map((alarm) => offen.get(alarm.schluessel)));
  let fehler = null;
  try {
    if (!empfaenger.length) throw Object.assign(new Error('Keine Empfaenger fuer Sicherheitsalarme konfiguriert.'), { code: 'KEINE_EMPFAENGER' });
    await mailer.sendMail({ to: empfaenger.join(', '), subject, text });
  } catch (err) {
    fehler = fehlerCode(err);
  }
  const ids = aktuell.map((alarm) => Number(alarm.schluessel));
  inTransaktion(db, () => {
    for (const alarm of aktuell) {
      const versuche = alarm.versuche + 1;
      if (fehler) {
        const pause = Math.min(MAX_BACKOFF_MS, BASIS_BACKOFF_MS * 2 ** (versuche - 1));
        db.prepare(`UPDATE sicherheitsalarme SET versuche = ?, letzter_versuch_am = ?, letzter_fehler = ?, naechster_versuch_am = ?,
          sperre_token = NULL, sperre_bis = NULL WHERE id = ? AND sperre_token = ?`).run(versuche, iso(jetzt), fehler, iso(jetzt + pause), alarm.id, token);
      } else {
        db.prepare(`UPDATE sicherheitsalarme SET status = 'versendet', versuche = ?, letzter_versuch_am = ?, letzter_fehler = NULL,
          versendet_am = ?, sperre_token = NULL, sperre_bis = NULL WHERE id = ? AND sperre_token = ?`).run(versuche, iso(jetzt), iso(jetzt), alarm.id, token);
      }
    }
    logMailAttempt(db, {
      typ: 'sicherheitsalarm', jobId: null, empfaenger: empfaenger.join(', ') || '(keine)', betreff: subject, text,
      status: fehler ? 'fehlgeschlagen' : 'versendet', fehlerDetails: fehler,
    });
    schreibeAudit(db, fehler ? 'sicherheitsalarm_versand_fehlgeschlagen' : 'sicherheitsalarm_versendet', {
      absichtIds: ids, empfaengerAnzahl: empfaenger.length, ...(fehler ? { code: fehler } : {}),
    });
  });
  return fehler
    ? { versendet: 0, fehlgeschlagen: aktuell.length, erledigt: erledigt.length, fehler }
    : { versendet: aktuell.length, fehlgeschlagen: 0, erledigt: erledigt.length };
}

async function runSicherheitsalarmeJobInternal(db, config, mailer, options = {}) {
  try {
    const erkennung = erkenneOffeneBackupLoeschungen(db, options);
    const versand = await versendeFaelligeAlarme(db, config, mailer, options);
    return { status: versand.fehlgeschlagen ? 'fehler' : 'erfolg', ...erkennung, ...versand };
  } catch (err) {
    console.error('Sicherheitsalarm-Lauf fehlgeschlagen:', err.message);
    return { status: 'fehler', error: err.message };
  }
}

export const runSicherheitsalarmeJob = auditedJob('sicherheitsalarme', runSicherheitsalarmeJobInternal);
