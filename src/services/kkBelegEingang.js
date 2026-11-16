// Eingang von Kreditkartenbelegen per Mail (über n8n, später nativ): Absender prüfen, Betrag/Datum vorschlagen, Entwurf anlegen (docs/kreditkarten-belege.md).
import { findActivePersonByEmail, countActivePersonsByEmail } from '../db/personenRepo.js';
import { normalizeAbsender } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { createKkBeleg, logKkBelegEreignis } from '../db/kkBelegeRepo.js';
import { detectBelegMimetype, pruefeBelegBild } from './belegAnhaengen.js';
import { listErfassbareKarten } from './kkRechte.js';
import { speichereKkBelegDatei } from './kkBelegDatei.js';
import { analysiereText } from './kkTextAnalyse.js';
import { pdfArbeit, PdfWorkerFehler } from './pdfArbeit.js';
import { sendNotification } from './notify.js';

// Gemeinsamer Einstieg für Belege, die per Mail eintreffen -- heute über n8n
// (routes/n8n/kkBelege.js), später auch vom nativen Mail-Modul aufrufbar. Liefert Status + Body,
// damit der Aufrufer selbst entscheidet, wie er antwortet.
/**
 * Verarbeitet einen per Mail eingegangenen Kreditkartenbeleg: Absender → Person, Dateityp prüfen, Betrag per QR/Text-Analyse und
 * Kaufdatum vorschlagen, Entwurf anlegen und die Person benachrichtigen.
 * @returns {Promise<{status: number, body: object}>} 201 mit `{id, status: 'entwurf'}`, sonst 409 (Modul aus), 422 (Absender unbekannt/mehrdeutig), 400 (Datei ungültig),
 *   503 `{fehler: 'pdf_verarbeitung_ausgelastet'}`, wenn die Belegdatei im PDF-Worker vorübergehend nicht erstellt werden kann (nichts angelegt)
 */
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
  // Bild über 40 Megapixel oder mit unlesbarem Kopf: gar nicht erst dekodieren (siehe pruefeBelegBild).
  if (pruefeBelegBild(buffer, mimetype)) return { status: 400, body: { fehler: 'datei_ungueltig' } };

  let betrag = null;
  let kaufdatum = null;
  // QR und Text im PDF-Worker (B2, Spur hintergrund). Zeitlimit/Überlastung wie jeder andere Fehler:
  // nur kein Vorschlag, der Beleg wird trotzdem angelegt.
  if (mimetype === 'application/pdf') {
    try {
      const qr = await pdfArbeit().ausfuehren('qrErkennen', [buffer], { spur: 'hintergrund' });
      if (qr?.betrag) betrag = Number(qr.betrag).toFixed(2);
    } catch (err) {
      console.error('QR-Erkennung für Mail-Beleg fehlgeschlagen:', err.message);
    }
    try {
      // analysiereText begrenzt Text- und Zeilenlänge -- Mail-Anhänge sind nicht vertrauenswürdig.
      const analyse = analysiereText(await pdfArbeit().ausfuehren('textExtrahieren', [buffer], { spur: 'hintergrund' }));
      betrag = betrag ?? analyse.total;
      const heute = new Date().toISOString().slice(0, 10);
      kaufdatum = analyse.daten.map((d) => d.datum).find((d) => d <= heute) ?? null;
    } catch (err) {
      console.error('Textanalyse für Mail-Beleg fehlgeschlagen:', err.message);
    }
  }

  const karten = listErfassbareKarten(db, person.churchtools_person_id);
  // Die Belegdatei (PDF + Vorschaubild) entsteht ebenfalls im Worker (Etappe 2). Ohne sie gibt es keinen Entwurf:
  // vorübergehende Störung → 503, der Aufrufer (n8n) wiederholt die Einreichung; es wurde nichts angelegt.
  let pdfPfad;
  let thumbnailPfad;
  try {
    ({ pdfPfad, thumbnailPfad } = await speichereKkBelegDatei(config, buffer, mimetype, { spur: 'hintergrund' }));
  } catch (err) {
    if (!(err instanceof PdfWorkerFehler)) throw err;
    console.warn(`Mail-Beleg: PDF-Verarbeitung vorübergehend nicht verfügbar (${err.name}), Einreichung abgewiesen.`);
    return { status: 503, body: { fehler: 'pdf_verarbeitung_ausgelastet' } };
  }
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
