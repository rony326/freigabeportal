// Nur für Tests (B2, Etappen 2 und 4): Aufgabenmodul ohne mupdf für die Beleg-Aufrufer (Spesen, Kreditkarten-Belege,
// KK-Abgleich, Beleg anhängen in Kontierung/Aufsplitten). Normale Bytes laufen sofort durch; enthält ein Beleg die Marke
// LANGSAM_PRUEFEN, LANGSAM_ERSTELLEN bzw. LANGSAM_ANHAENGEN, blockiert die jeweilige Aufgabe, bis das (im Test klein
// gesetzte) Zeitlimit greift. Mit der Marke VERZOEGERT_ANHAENGEN braucht belegAnhaengen 400 ms (Gleichzeitigkeitstests).
// belegAnhaengen führt echt zusammen (pdf-lib, ohne mupdf), damit Seitenzahlen geprüft werden können.
import { belegInPdfAnhaengen } from '../../src/services/belegAnhaengen.js';

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
  textExtrahieren: () => '',
  qrErkennen: () => null,
};
