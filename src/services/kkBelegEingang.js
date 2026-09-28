import { findActivePersonByEmail, countActivePersonsByEmail } from '../db/personenRepo.js';
import { normalizeAbsender } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { createKkBeleg, logKkBelegEreignis } from '../db/kkBelegeRepo.js';
import { detectBelegMimetype } from './belegAnhaengen.js';
import { listErfassbareKarten } from './kkRechte.js';
import { speichereKkBelegDatei } from './kkBelegDatei.js';
import { extrahierePdfText } from './pdfText.js';
import { analysiereText } from './kkTextAnalyse.js';
import { scanQrBill } from './qrBillScan.js';
import { sendNotification } from './notify.js';

// Gemeinsamer Einstieg für Belege, die per Mail eintreffen -- heute über n8n
// (routes/n8n/kkBelege.js), später auch vom nativen Mail-Modul aufrufbar. Liefert Status + Body,
// damit der Aufrufer selbst entscheidet, wie er antwortet.
export async function nimmKkBelegEntgegen(db, config, mailer, { absender, buffer }) {
  if (getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1') return { status: 409, body: { fehler: 'modul_deaktiviert' } };
  const email = normalizeAbsender(absender);
  const person = findActivePersonByEmail(db, email);
  if (!person) {
    const fehler = countActivePersonsByEmail(db, email) > 1 ? 'absender_mehrdeutig' : 'absender_unbekannt';
    return { status: 422, body: { fehler } };
  }
  const mimetype = buffer ? detectBelegMimetype(buffer) : null;
  if (!mimetype) return { status: 400, body: { fehler: 'datei_ungueltig' } };

  let betrag = null;
  let kaufdatum = null;
  if (mimetype === 'application/pdf') {
    try {
      const qr = scanQrBill(buffer);
      if (qr?.betrag) betrag = Number(qr.betrag).toFixed(2);
    } catch (err) {
      console.error('QR-Erkennung für Mail-Beleg fehlgeschlagen:', err.message);
    }
    try {
      // analysiereText begrenzt Text- und Zeilenlänge -- Mail-Anhänge sind nicht vertrauenswürdig.
      const analyse = analysiereText(extrahierePdfText(buffer));
      betrag = betrag ?? analyse.total;
      const heute = new Date().toISOString().slice(0, 10);
      kaufdatum = analyse.daten.map((d) => d.datum).find((d) => d <= heute) ?? null;
    } catch (err) {
      console.error('Textanalyse für Mail-Beleg fehlgeschlagen:', err.message);
    }
  }

  const karten = listErfassbareKarten(db, person.churchtools_person_id);
  const { pdfPfad, thumbnailPfad } = await speichereKkBelegDatei(config, buffer, mimetype);
  const id = createKkBeleg(db, {
    kreditkarteId: karten.length === 1 ? karten[0].id : null,
    hochgeladenVon: person.churchtools_person_id,
    gekauftVon: person.churchtools_person_id,
    quelle: 'mail',
    pdfPfad,
    thumbnailPfad,
    betrag,
    kaufdatum,
    beschreibung: null,
    kontoId: null,
    status: 'entwurf',
  });
  logKkBelegEreignis(db, { belegId: id, personId: person.churchtools_person_id, aktion: 'kk_beleg_erfasst', kommentar: 'per Mail eingegangen' });
  await sendNotification(db, mailer, {
    to: person.email,
    typ: 'kk-beleg-eingegangen',
    jobId: null,
    variablen: { empfaengerName: `${person.vorname} ${person.nachname}`, link: `${config.publicBaseUrl}/kreditkarte/belege/${id}/bearbeiten` },
  });
  return { status: 201, body: { id, status: 'entwurf' } };
}
