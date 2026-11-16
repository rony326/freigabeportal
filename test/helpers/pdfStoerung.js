// Nur für Tests (B2): stellt die gemeinsame PDF-Fassade (services/pdfArbeit.js) für die Dauer von `fn` auf eine
// Störung um und danach wieder auf den Normalbetrieb.
// - 'zeitlimit': Worker mit dem Testmodul pdfTestAufgabenBeleg.js; Belege bzw. zu stempelnde PDFs mit LANGSAM_* überschreiten
//   ein Zeitlimit von 300 ms.
// - 'ueberlastet': Warteschlange 0 – jeder Auftrag scheitert sofort mit PdfWorkerUeberlastet.
// - 'verzoegert': keine Störung, aber Worker mit dem Testmodul; Belege mit VERZOEGERT_ANHAENGEN brauchen 400 ms
//   (zwei gleichzeitige Anfragen warten so sicher beide auf den Worker, B2 Etappe 4).
import { konfigurierePdfArbeit, schliessePdfWorker } from '../../src/services/pdfArbeit.js';

const STILL = { log() {}, warn() {}, error() {} };

export async function mitPdfStoerung(art, fn) {
  if (art === 'zeitlimit') {
    konfigurierePdfArbeit({
      modus: 'an',
      aufgabenModul: new URL('./pdfTestAufgabenBeleg.js', import.meta.url).href,
      zeitlimits: { eingangPruefen: 300, belegDateiErstellen: 300, belegAnhaengen: 300, freigabeStempeln: 300, kenntnisnahmeStempeln: 300 },
      logger: STILL,
    });
  } else if (art === 'verzoegert') {
    konfigurierePdfArbeit({ modus: 'an', aufgabenModul: new URL('./pdfTestAufgabenBeleg.js', import.meta.url).href, logger: STILL });
  } else if (art === 'ueberlastet') {
    konfigurierePdfArbeit({ modus: 'an', maxWarteschlange: 0, logger: STILL });
  } else {
    throw new Error(`Unbekannte Störung: ${art}`);
  }
  try {
    return await fn();
  } finally {
    await schliessePdfWorker();
    // Zurück auf den Betrieb dieses Testlaufs (Standard Worker; PDF_WORKER=aus über test/helpers/pdfWorkerAus.js).
    konfigurierePdfArbeit({ modus: process.env.PDF_WORKER === 'aus' ? 'aus' : 'an' });
  }
}
