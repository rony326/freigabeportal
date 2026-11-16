// Nur für Tests (B2, Etappen 2 bis 5): Aufgabenmodul ohne mupdf für die Beleg-Aufrufer (Spesen, Kreditkarten-Belege,
// KK-Abgleich, Beleg anhängen in Kontierung/Aufsplitten), die Stempel (Freigabe 2, Rapport) und das Splitgruppen-Dokument.
// Normale Bytes laufen sofort durch; enthält ein Beleg bzw. das zu stempelnde PDF bzw. das Basis-PDF der Gruppe die Marke
// LANGSAM_PRUEFEN, LANGSAM_ERSTELLEN, LANGSAM_ANHAENGEN, LANGSAM_STEMPELN bzw. LANGSAM_GRUPPE, blockiert die jeweilige
// Aufgabe, bis das (im Test klein gesetzte) Zeitlimit greift. Mit der Marke VERZOEGERT_ANHAENGEN bzw. VERZOEGERT_GRUPPE
// braucht belegAnhaengen bzw. gruppenDokumentErstellen 400 ms (Gleichzeitigkeitstests).
// belegAnhaengen, die Stempel und das Gruppendokument rechnen echt (pdf-lib, ohne mupdf), damit Inhalte geprüft werden können.
import { belegInPdfAnhaengen } from '../../src/services/belegAnhaengen.js';
import { stampAndFinalize, stampKenntnisnahme } from '../../src/services/pdfStamp.js';
import { erstelleGruppenDokument } from '../../src/services/splitGruppenPdf.js';

const blockiere = (ms) => { const ende = Date.now() + ms; while (Date.now() < ende) { /* rechnen */ } };
const hat = (buf, marke) => Buffer.isBuffer(buf) && buf.includes(marke);

export const AUFGABEN = {
  eingangPruefen: (buf) => {
    if (hat(buf, 'LANGSAM_PRUEFEN')) blockiere(60_000);
    return { seiten: 1 };
  },
  belegDateiErstellen: (buf) => {
    if (hat(buf, 'LANGSAM_ERSTELLEN')) blockiere(60_000);
    return { pdf: Buffer.concat([Buffer.from('%PDF-1.4\n'), buf]), vorschaubild: Buffer.from('PNG-Testbild'), vorschaubildFehler: null };
  },
  belegAnhaengen: (pdf, beleg, mimetype) => {
    if (hat(beleg, 'LANGSAM_ANHAENGEN')) blockiere(60_000);
    if (hat(beleg, 'VERZOEGERT_ANHAENGEN')) blockiere(400);
    return belegInPdfAnhaengen(pdf, beleg, mimetype);
  },
  freigabeStempeln: (pdf, daten) => {
    if (hat(pdf, 'LANGSAM_STEMPELN')) blockiere(60_000);
    return stampAndFinalize(pdf, daten);
  },
  kenntnisnahmeStempeln: (pdf, daten) => {
    if (hat(pdf, 'LANGSAM_STEMPELN')) blockiere(60_000);
    return stampKenntnisnahme(pdf, daten);
  },
  gruppenDokumentErstellen: (basis, teile, daten) => {
    if (hat(basis, 'LANGSAM_GRUPPE')) blockiere(60_000);
    if (hat(basis, 'VERZOEGERT_GRUPPE')) blockiere(400);
    return erstelleGruppenDokument(basis, teile, daten);
  },
  textExtrahieren: () => '',
  qrErkennen: () => null,
};
