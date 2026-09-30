import { randomUUID } from 'node:crypto';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { getVorlage, renderTemplate } from './mailTemplates.js';

// Persistente Zustellung aller Benachrichtigungen über mail_log (Outbox-Muster).
//
// Status einer mail_log-Zeile:
//   'eingereiht'     dauerhaft gespeichert, wartet auf den (ersten oder nächsten) SMTP-Versuch
//   'geplant'        dauerhaft gespeichert, wartet auf den Digest (Batching aktiv)
//   'versendet'      der SMTP-Server hat die Nachricht angenommen
//   'fehlgeschlagen' endgültig: Wiederholungen ausgeschöpft oder nicht zustellbar (z.B. Vorlage
//                    nicht renderbar) -- nur noch manuell über /admin/mails wiederholbar
//
// - Einreihen ist synchron und kann in derselben Transaktion wie der fachliche Marker erfolgen
//   (z.B. reminder_gesendet_at): entweder beides ist gespeichert oder nichts.
// - Versand: Zeilen werden unter einer befristeten Sperre (sperre_token/sperre_bis) beansprucht.
//   Parallele Auslöser (Scheduler, manueller Cron-Aufruf, Request) versenden dieselbe Zeile
//   deshalb nicht doppelt. Das Ergebnis wird nur unter demselben Token gespeichert.
// - Fehler pro Zeile (= pro Empfänger) führen zu einem Wiederholungsversuch mit wachsendem
//   Abstand (BASIS_BACKOFF_MS * 2^(Versuch-1), höchstens MAX_BACKOFF_MS), bis
//   mail_zustellung_max_versuche erreicht ist. Erfolgreiche Empfänger werden nie erneut bedient.
// - Prozessneustart: Zeilen bleiben 'eingereiht'/'geplant' und werden vom Job mail-zustellung
//   aufgegriffen; eine Sperre eines abgestürzten Prozesses läuft nach SPERRE_MS ab.
// - Restrisiko (mindestens einmal, nicht genau einmal): stürzt der Prozess ab, nachdem der
//   SMTP-Server die Nachricht angenommen hat, aber bevor 'versendet' gespeichert ist, wird die
//   Nachricht nach Ablauf der Sperre erneut versendet. SMTP bietet keine Idempotenz, die das
//   ausschliessen könnte.

export const SPERRE_MS = 10 * 60 * 1000;
export const BASIS_BACKOFF_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const STANDARD_MAX_VERSUCHE = 8;
const MAX_ZEILEN_PRO_LAUF = 200;

function iso(ms) {
  return new Date(ms).toISOString();
}

export function maxVersuche(db) {
  const wert = Number(getConfigValue(db, 'mail_zustellung_max_versuche'));
  return Number.isInteger(wert) && wert >= 1 ? wert : STANDARD_MAX_VERSUCHE;
}

export function wartezeitNachVersuch(versuche) {
  return Math.min(MAX_BACKOFF_MS, BASIS_BACKOFF_MS * 2 ** Math.max(0, versuche - 1));
}

function inTransaktion(db, action) {
  if (db.isTransaction) return action();
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

export function reiheMailEin(db, { typ, jobId, empfaenger, betreff, text, geplant = false, jetzt = Date.now() }) {
  const zeit = iso(jetzt);
  const result = db
    .prepare(
      `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am, eingereiht_am, versuche, naechster_versuch_am)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(typ, jobId ?? null, empfaenger, betreff, text, geplant ? 'geplant' : 'eingereiht', zeit, zeit, geplant ? null : zeit);
  return Number(result.lastInsertRowid);
}

function beanspruche(db, ids, status, jetzt) {
  if (!ids.length) return { token: null, zeilen: [] };
  const token = randomUUID();
  const platzhalter = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE mail_log SET sperre_token = ?, sperre_bis = ?
     WHERE id IN (${platzhalter}) AND status = ? AND (sperre_bis IS NULL OR sperre_bis <= ?)`
  ).run(token, iso(jetzt + SPERRE_MS), ...ids, status, iso(jetzt));
  const zeilen = db.prepare('SELECT * FROM mail_log WHERE sperre_token = ? ORDER BY id').all(token);
  return { token, zeilen };
}

// Speichert das Ergebnis eines Versuchs für alle unter `token` beanspruchten Zeilen und liefert
// den neuen Status je Zeile ('versendet' | 'eingereiht' | 'geplant' | 'fehlgeschlagen').
function vermerkeErgebnis(db, zeilen, token, fehler, jetzt) {
  const grenze = maxVersuche(db);
  return inTransaktion(db, () => zeilen.map((zeile) => {
    const versuche = zeile.versuche + 1;
    if (!fehler) {
      db.prepare(
        `UPDATE mail_log SET status = 'versendet', versuche = ?, versucht_am = ?, versendet_am = ?, fehler_details = NULL,
           naechster_versuch_am = NULL, sperre_token = NULL, sperre_bis = NULL WHERE id = ? AND sperre_token = ?`
      ).run(versuche, iso(jetzt), iso(jetzt), zeile.id, token);
      return 'versendet';
    }
    const endgueltig = versuche >= grenze;
    const status = endgueltig ? 'fehlgeschlagen' : zeile.status;
    const details = endgueltig ? `${fehler} (nach ${versuche} Versuchen aufgegeben)` : `${fehler} (Versuch ${versuche} von ${grenze})`;
    db.prepare(
      `UPDATE mail_log SET status = ?, versuche = ?, versucht_am = ?, fehler_details = ?, naechster_versuch_am = ?,
         sperre_token = NULL, sperre_bis = NULL WHERE id = ? AND sperre_token = ?`
    ).run(status, versuche, iso(jetzt), details, endgueltig ? null : iso(jetzt + wartezeitNachVersuch(versuche)), zeile.id, token);
    return status;
  }));
}

function fehlerText(err) {
  return (err && err.message) || String(err) || 'Versand fehlgeschlagen';
}

// Ein Versuch für genau eine 'eingereiht'-Zeile. Ist die Zeile gerade von einem anderen Auslöser
// beansprucht oder schon erledigt, wird nichts versendet und der aktuelle Status gemeldet.
export async function stelleMailZu(db, mailer, id, { jetzt = Date.now() } = {}) {
  const { token, zeilen } = beanspruche(db, [id], 'eingereiht', jetzt);
  if (!zeilen.length) {
    const aktuell = db.prepare('SELECT status FROM mail_log WHERE id = ?').get(id);
    return { id, status: aktuell ? aktuell.status : 'fehlgeschlagen', beansprucht: false };
  }
  const zeile = zeilen[0];
  let fehler = null;
  try {
    await mailer.sendMail({ to: zeile.empfaenger, subject: zeile.betreff, text: zeile.text });
  } catch (err) {
    fehler = fehlerText(err);
  }
  const [status] = vermerkeErgebnis(db, zeilen, token, fehler, jetzt);
  return { id, status, beansprucht: true, ...(fehler ? { fehler } : {}) };
}

export function neueBilanz() {
  return { versendet: 0, wiederholung: 0, fehlgeschlagen: 0, geplant: 0 };
}

export function bilanzHatFehler(bilanz) {
  return bilanz.wiederholung + bilanz.fehlgeschlagen > 0;
}

export function bilanzText(bilanz) {
  return `Mails versendet: ${bilanz.versendet}, zur Wiederholung eingereiht: ${bilanz.wiederholung}, endgültig fehlgeschlagen: ${bilanz.fehlgeschlagen}, für Digest geplant: ${bilanz.geplant}`;
}

function zaehle(bilanz, status) {
  if (status === 'versendet') bilanz.versendet += 1;
  else if (status === 'fehlgeschlagen') bilanz.fehlgeschlagen += 1;
  else if (status === 'geplant') bilanz.geplant += 1;
  else bilanz.wiederholung += 1;
}

// Stellt bereits eingereihte Einträge ({ id, status }) zu -- 'geplant' bleibt dem Digest überlassen.
export async function stelleEintraegeZu(db, mailer, eintraege, bilanz = neueBilanz()) {
  for (const eintrag of eintraege) {
    if (eintrag.status === 'geplant') {
      zaehle(bilanz, 'geplant');
      continue;
    }
    const ergebnis = await stelleMailZu(db, mailer, eintrag.id);
    zaehle(bilanz, ergebnis.status);
  }
  return bilanz;
}

export function ladeDigestVorlage(db) {
  const vorlage = getVorlage(db, 'digest');
  if (!vorlage.betreff || !vorlage.text) {
    throw new Error('Digest-Vorlage ist unvollständig (Betreff oder Text fehlt)');
  }
  return vorlage;
}

// Setzt wartende Digest-Zeilen sichtbar auf 'fehlgeschlagen', wenn die Digest-Vorlage selbst
// nicht renderbar ist -- das beträfe jeden Empfänger gleich und würde sonst endlos warten.
export function markiereDigestZeilenFehlgeschlagen(db, zeilen, meldung, jetzt = Date.now()) {
  inTransaktion(db, () => {
    for (const zeile of zeilen) {
      db.prepare(
        `UPDATE mail_log SET status = 'fehlgeschlagen', fehler_details = ?, versucht_am = ?, naechster_versuch_am = NULL
         WHERE id = ? AND status = 'geplant' AND (sperre_bis IS NULL OR sperre_bis <= ?)`
      ).run(meldung, iso(jetzt), zeile.id, iso(jetzt));
    }
  });
}

// Ein Digest-Versuch für einen Empfänger über die übergebenen 'geplant'-Zeilen. Liefert
// 'versendet' | 'geplant' (Wiederholung vorgesehen) | 'fehlgeschlagen' | null (nichts beansprucht).
export async function stelleDigestZu(db, config, mailer, { empfaenger, ids, vorlage, jetzt = Date.now() }) {
  const { token, zeilen } = beanspruche(db, ids, 'geplant', jetzt);
  if (!zeilen.length) return null;
  const variablen = {
    empfaengerName: empfaenger,
    anzahl: zeilen.length,
    eintraege: zeilen.map((z) => (z.job_id != null ? `- ${z.betreff} (Job #${z.job_id})` : `- ${z.betreff}`)).join('\n'),
    link: `${config.publicBaseUrl}/pool`,
    portalName: getConfigValue(db, 'seiten_titel') || 'Freigabeportal',
  };
  let fehler = null;
  try {
    await mailer.sendMail({ to: empfaenger, subject: renderTemplate(vorlage.betreff, variablen), text: renderTemplate(vorlage.text, variablen) });
  } catch (err) {
    fehler = fehlerText(err);
  }
  const status = vermerkeErgebnis(db, zeilen, token, fehler, jetzt);
  return status.includes('fehlgeschlagen') ? 'fehlgeschlagen' : status[0];
}

export function gruppiereNachEmpfaenger(zeilen) {
  const gruppen = new Map();
  for (const zeile of zeilen) {
    if (!gruppen.has(zeile.empfaenger)) gruppen.set(zeile.empfaenger, []);
    gruppen.get(zeile.empfaenger).push(zeile);
  }
  return gruppen;
}

export function hatFaelligeMails(db, jetzt = Date.now()) {
  return db
    .prepare(
      `SELECT 1 FROM mail_log WHERE naechster_versuch_am <= ? AND (sperre_bis IS NULL OR sperre_bis <= ?)
       AND (status = 'eingereiht' OR (status = 'geplant' AND versuche > 0)) LIMIT 1`
    )
    .get(iso(jetzt), iso(jetzt)) != null;
}

// Wiederholungslauf: fällige Einzelmails und fällige Digest-Wiederholungen (erste Digest-Zustellung
// bleibt dem täglichen mail-digest-Termin vorbehalten).
export async function stelleFaelligeMailsZu(db, config, mailer, { jetzt = Date.now() } = {}) {
  const bilanz = neueBilanz();
  const einzel = db
    .prepare(
      `SELECT id FROM mail_log WHERE status = 'eingereiht' AND naechster_versuch_am <= ? AND (sperre_bis IS NULL OR sperre_bis <= ?)
       ORDER BY naechster_versuch_am, id LIMIT ?`
    )
    .all(iso(jetzt), iso(jetzt), MAX_ZEILEN_PRO_LAUF);
  for (const { id } of einzel) {
    const ergebnis = await stelleMailZu(db, mailer, id, { jetzt });
    if (ergebnis.beansprucht) zaehle(bilanz, ergebnis.status);
  }

  const digestZeilen = db
    .prepare(
      `SELECT * FROM mail_log WHERE status = 'geplant' AND versuche > 0 AND naechster_versuch_am <= ? AND (sperre_bis IS NULL OR sperre_bis <= ?)
       ORDER BY id LIMIT ?`
    )
    .all(iso(jetzt), iso(jetzt), MAX_ZEILEN_PRO_LAUF);
  let digestEmpfaenger = 0;
  if (digestZeilen.length) {
    let vorlage;
    try {
      vorlage = ladeDigestVorlage(db);
    } catch (err) {
      markiereDigestZeilenFehlgeschlagen(db, digestZeilen, `Digest-Vorlage konnte nicht gerendert werden: ${err.message}`);
      bilanz.fehlgeschlagen += digestZeilen.length;
      return { ...bilanz, digestEmpfaenger };
    }
    for (const [empfaenger, zeilen] of gruppiereNachEmpfaenger(digestZeilen)) {
      const status = await stelleDigestZu(db, config, mailer, { empfaenger, ids: zeilen.map((z) => z.id), vorlage, jetzt });
      if (status === null) continue;
      digestEmpfaenger += 1;
      zaehle(bilanz, status === 'geplant' ? 'eingereiht' : status);
    }
  }
  return { ...bilanz, digestEmpfaenger };
}
