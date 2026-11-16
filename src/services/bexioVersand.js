// Versandquittung für Bexio (docs/n8n-schnittstelle.md «Versand an Bexio bestätigen»): n8n schickt den fertigen
// Beleg per Mail an das Bexio-Eingangspostfach und meldet danach die Antwort des Mailservers. Das Portal prüft, dass
// die gemeldete Export-ID zum Vorgang gehört (Exportnachweis aus services/archiveReceipt.js), und speichert die
// Quittung unveränderlich in `bexio_versand` (Audit über die zentralen Trigger, db/securitySchema.js).
// Die SMTP-Antwort belegt nur, dass der eigene Mailserver die Mail angenommen hat, nicht die Zustellung bei Bexio.

import { getJobById } from '../db/jobsRepo.js';

// Fehler mit HTTP-Status (400 Eingabe, 404 unbekannt, 409 Zustand, 422 Versand nicht erfolgreich).
export class BexioVersandFehler extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MAX_EMPFAENGER = 10;
const MAX_ADRESSE = 254;
const MAX_MESSAGE_ID = 255;
const MAX_SMTP_ANTWORT = 500;
// Schlichte Prüfung einer nackten Adresse (ohne Anzeigename), wie sie nodemailer in accepted/rejected liefert.
const ADRESSE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
// ISO-Zeitpunkt mit Uhrzeit und Zeitzone (Z oder ±hh:mm), damit der Zeitpunkt eindeutig ist.
const ISO_ZEITPUNKT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
// Steuerzeichen (inkl. Zeilenumbrüche): in der Message-ID abgelehnt, in der SMTP-Antwort zu Leerzeichen.
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;

function eingabefehler(meldung) { return new BexioVersandFehler(400, meldung); }

// Eine Adressliste: nur Text-Einträge mit gültiger Adresse. `pflicht` verlangt mindestens einen Eintrag.
function adressListe(wert, feld, { pflicht }) {
  const liste = typeof wert === 'string' && pflicht ? [wert] : wert;
  if (!Array.isArray(liste) || (pflicht && liste.length === 0) || liste.length > MAX_EMPFAENGER) {
    throw eingabefehler(`${feld} muss ${pflicht ? 'eine Mailadresse oder eine Liste von' : 'eine Liste von'} höchstens ${MAX_EMPFAENGER} Mailadressen sein.`);
  }
  return liste.map((adresse) => {
    if (typeof adresse !== 'string' || adresse.trim().length > MAX_ADRESSE || !ADRESSE.test(adresse.trim())) {
      throw eingabefehler(`${feld} enthält keine gültige Mailadresse.`);
    }
    return adresse.trim();
  });
}

/**
 * Prüft den Body der Versandquittung und bringt ihn in Speicherform.
 * @returns {{export_id, empfaenger: string[], akzeptiert: string[]|null, abgelehnt: string[], message_id, smtp_antwort, gesendet_am}}
 * @throws {BexioVersandFehler} 400 bei Form-/Längenfehlern
 */
export function pruefeVersandMeldung(body) {
  const { export_id, empfaenger, message_id, smtp_antwort, gesendet_am, akzeptiert, abgelehnt } = body || {};
  if (typeof export_id !== 'string' || !export_id || export_id.length > 64) throw eingabefehler('export_id (Text, aus dem Exportnachweis) fehlt oder ist ungültig.');
  const empfaengerListe = adressListe(empfaenger, 'empfaenger', { pflicht: true });
  if (typeof message_id !== 'string' || !message_id.trim() || message_id.trim().length > MAX_MESSAGE_ID || STEUERZEICHEN.test(message_id)) {
    throw eingabefehler(`message_id muss ein einzeiliger Text mit höchstens ${MAX_MESSAGE_ID} Zeichen sein.`);
  }
  if (typeof smtp_antwort !== 'string') throw eingabefehler('smtp_antwort (Text) fehlt.');
  // Mehrzeilige SMTP-Antworten sind zulässig, werden aber einzeilig gespeichert: so kann der Wert weder
  // Logzeilen noch Anzeigezeilen vortäuschen.
  const antwort = smtp_antwort.replace(new RegExp(STEUERZEICHEN.source, 'g'), ' ').replace(/ {2,}/g, ' ').trim();
  if (!antwort || antwort.length > MAX_SMTP_ANTWORT) throw eingabefehler(`smtp_antwort muss Text mit höchstens ${MAX_SMTP_ANTWORT} Zeichen sein.`);
  if (typeof gesendet_am !== 'string' || gesendet_am.length > 40 || !ISO_ZEITPUNKT.test(gesendet_am) || !Number.isFinite(Date.parse(gesendet_am))) {
    throw eingabefehler('gesendet_am muss ein ISO-Zeitpunkt mit Zeitzone sein (z. B. 2026-11-16T10:15:00+01:00).');
  }
  return {
    export_id,
    empfaenger: empfaengerListe,
    akzeptiert: akzeptiert === undefined || akzeptiert === null ? null : adressListe(akzeptiert, 'akzeptiert', { pflicht: false }),
    abgelehnt: abgelehnt === undefined || abgelehnt === null ? [] : adressListe(abgelehnt, 'abgelehnt', { pflicht: false }),
    message_id: message_id.trim(),
    smtp_antwort: antwort,
    gesendet_am: new Date(gesendet_am).toISOString(),
  };
}

// Nur ein vollständig erfolgreicher Versand wird quittiert: 2xx-Antwort und kein Bexio-Empfänger abgelehnt bzw.
// (falls n8n die Liste mitschickt) jeder Bexio-Empfänger akzeptiert. Ein Fehlversand wird nicht gespeichert,
// der Beleg bleibt in `bexio-versand-ausstehend`. @throws {BexioVersandFehler} 422
function pruefeErfolg(meldung) {
  if (!/^2\d\d(?:[ -]|$)/.test(meldung.smtp_antwort)) {
    throw new BexioVersandFehler(422, 'Der Mailserver hat den Versand nicht bestätigt (keine 2xx-Antwort).');
  }
  const klein = (liste) => new Set(liste.map((adresse) => adresse.toLowerCase()));
  const abgelehnt = klein(meldung.abgelehnt);
  const akzeptiert = meldung.akzeptiert ? klein(meldung.akzeptiert) : null;
  for (const adresse of meldung.empfaenger.map((a) => a.toLowerCase())) {
    if (abgelehnt.has(adresse) || (akzeptiert && !akzeptiert.has(adresse))) {
      throw new BexioVersandFehler(422, 'Der Mailserver hat mindestens einen Bexio-Empfänger nicht angenommen.');
    }
  }
}

/**
 * Speichert die Versandquittung eines exportierten Belegs (Einzelbeleg oder Splitgruppen-Elternjob). Gleiche
 * Message-ID am selben Vorgang: bestehender Eintrag mit `neu: false` (idempotent); neue Message-ID: weiterer Eintrag.
 * @returns {{neu: boolean, versand: object}}
 * @throws {BexioVersandFehler} 400/404/409/422
 */
export function bestaetigeBexioVersand(db, id, body) {
  const meldung = pruefeVersandMeldung(body);
  pruefeErfolg(meldung);
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = getJobById(db, id);
    // Rapporte gehen nie an Bexio; im Rechnungsweg gelten sie als nicht vorhanden (wie bei der Archivquittung).
    if (!job || job.typ === 'rapport') throw new BexioVersandFehler(404, 'Job nicht gefunden.');
    const vorher = db.prepare('SELECT * FROM bexio_versand WHERE message_id = ?').get(meldung.message_id);
    if (vorher) {
      if (vorher.job_id !== id) throw new BexioVersandFehler(409, 'Diese Message-ID ist bereits einem anderen Vorgang zugeordnet.');
      db.exec('COMMIT');
      return { neu: false, versand: vorher };
    }
    // Exportiert ist ein Vorgang, sobald sein Exportnachweis festgeschrieben ist (GET /:id/exportnachweis). Teilbelege
    // einer Splitgruppe haben keinen eigenen; die Gruppe wird über den Elternjob quittiert.
    const nachweis = db.prepare('SELECT id FROM export_nachweise WHERE job_id = ?').get(id);
    if (!nachweis) throw new BexioVersandFehler(409, 'Der Vorgang ist noch nicht exportiert (kein Exportnachweis).');
    if (nachweis.id !== meldung.export_id) throw new BexioVersandFehler(409, 'Die export_id gehört nicht zu diesem Vorgang.');
    const versand = {
      job_id: id,
      export_id: meldung.export_id,
      empfaenger: meldung.empfaenger.join(', '),
      message_id: meldung.message_id,
      smtp_antwort: meldung.smtp_antwort,
      gesendet_am: meldung.gesendet_am,
      gemeldet_am: new Date().toISOString(),
    };
    const { lastInsertRowid } = db.prepare(`INSERT INTO bexio_versand (job_id, export_id, empfaenger, message_id, smtp_antwort, gesendet_am, gemeldet_am)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(versand.job_id, versand.export_id, versand.empfaenger, versand.message_id, versand.smtp_antwort, versand.gesendet_am, versand.gemeldet_am);
    db.exec('COMMIT');
    return { neu: true, versand: { id: Number(lastInsertRowid), ...versand } };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// Exportierte Rechnungen (mit Exportnachweis) ohne Versandquittung, Cursor über die Job-ID, höchstens 100.
// Rapporte und Teilbelege sind ausgenommen.
export function listBexioVersandAusstehend(db, nachId) {
  return db.prepare(`SELECT j.id, j.status, e.id AS export_id FROM jobs j
    JOIN export_nachweise e ON e.job_id = j.id
    WHERE j.id > ? AND j.aufgesplittet_von IS NULL AND COALESCE(j.typ, '') <> 'rapport'
      AND NOT EXISTS (SELECT 1 FROM bexio_versand b WHERE b.job_id = j.id)
    ORDER BY j.id LIMIT 100`).all(nachId);
}

// Für die Anzeige: alle Versandquittungen eines Belegs (bei einem Teilbeleg die der Splitgruppe), älteste zuerst.
// null bei Rapporten (gehen nie an Bexio) und Vorgängen, die noch nicht abgeschlossen sind.
export function bexioVersandFuerAnzeige(db, job) {
  if (!job || job.typ === 'rapport') return null;
  if (!['abgeschlossen', 'abgeholt', 'archiviert', 'aufgesplittet'].includes(job.status)) return null;
  return db.prepare('SELECT * FROM bexio_versand WHERE job_id = ? ORDER BY gesendet_am, id').all(job.aufgesplittet_von || job.id);
}
