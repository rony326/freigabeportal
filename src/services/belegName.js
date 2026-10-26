import { zeitpunktAnzeige } from './auditLog.js';

// Anzeigename eines Belegs in Listen, Auswahlfeldern und Seitenköpfen.
//
// n8n liefert zum Rechnungseingang zwei Namen: das Formularfeld `dateiname` (jobs.dateiname, wird
// unverändert an n8n zurückgegeben) und den Dateinamen des hochgeladenen PDF-Teils
// (jobs.pdf_dateiname). Im Live-Portal stand im Formularfeld der Name eines Bild-Anhangs der Mail
// (Signatur-Logo "image002.png") — für die Buchhaltung bedeutungslos. Darum:
//   1. PDF-Dateiname des Uploads, wenn er auf .pdf endet,
//   2. sonst der Anzeigename, wenn er auf .pdf endet oder keine Bild-Endung hat,
//   3. sonst "Eingang <TT.MM.JJJJ HH:MM>".
// Spesen-Positionen behalten den Namen, den die einreichende Person hochgeladen hat.
const BILD_ENDUNG = /\.(png|jpe?g|gif|bmp|tiff?|webp|heic|heif|svg)$/i;
const PDF_ENDUNG = /\.pdf$/i;

export function belegName(job) {
  const pdfName = String(job?.pdf_dateiname ?? '').trim();
  const anzeige = String(job?.dateiname ?? '').trim();
  if (job?.quelle === 'spesen' && anzeige) return anzeige;
  if (PDF_ENDUNG.test(pdfName)) return pdfName;
  if (anzeige && (PDF_ENDUNG.test(anzeige) || !BILD_ENDUNG.test(anzeige))) return anzeige;
  return job?.eingang_am ? `Eingang ${zeitpunktAnzeige(job.eingang_am)}` : 'Beleg ohne Namen';
}

// "#<id> <Name>": die Nummer erscheint auch auf Kacheln, Tabellen und Seitenköpfen, damit ein
// Eintrag in einer Auswahl eindeutig einem Beleg zugeordnet werden kann.
export function belegLabel(job) {
  return job?.id ? `#${job.id} ${belegName(job)}` : belegName(job);
}
