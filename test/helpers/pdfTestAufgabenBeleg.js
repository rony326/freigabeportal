// Nur für Tests (B2, Etappe 2): Aufgabenmodul ohne mupdf für die Beleg-Aufrufer (Spesen, Kreditkarten-Belege,
// KK-Abgleich). Normale Bytes laufen sofort durch; enthält ein Beleg die Marke LANGSAM_PRUEFEN bzw. LANGSAM_ERSTELLEN,
// blockiert die jeweilige Aufgabe, bis das (im Test klein gesetzte) Zeitlimit greift.
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
  textExtrahieren: () => '',
  qrErkennen: () => null,
};
