// Nur für Tests (B2, Etappen 2, 3 und 4): Aufgabenmodul ohne mupdf für die Beleg-Aufrufer (Spesen, Kreditkarten-Belege,
// KK-Abgleich, Beleg anhängen in Kontierung/Aufsplitten) und die Stempel (Freigabe 2, Rapport). Normale Bytes laufen sofort
// durch; enthält ein Beleg bzw. das zu stempelnde PDF die Marke LANGSAM_PRUEFEN, LANGSAM_ERSTELLEN, LANGSAM_ANHAENGEN bzw.
// LANGSAM_STEMPELN, blockiert die jeweilige Aufgabe, bis das (im Test klein gesetzte) Zeitlimit greift. Mit der Marke
// VERZOEGERT_ANHAENGEN braucht belegAnhaengen 400 ms (Gleichzeitigkeitstests).
// belegAnhaengen und die Stempel rechnen echt (pdf-lib, ohne mupdf), damit Seitenzahlen und Inhalte geprüft werden können.
import { belegInPdfAnhaengen } from '../../src/services/belegAnhaengen.js';
import { stampAndFinalize, stampKenntnisnahme } from '../../src/services/pdfStamp.js';

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
  textExtrahieren: () => '',
  qrErkennen: () => null,
};
