// Nur für Testläufe (B2): übernimmt PDF_WORKER aus der Umgebung in die gemeinsame PDF-Fassade, wie es src/index.js
// mit config.pdfWorker tut. Ohne diesen Vorlader rechnen Tests im Worker-Betrieb (Standard der Fassade).
// Ganze Suite im Inline-Betrieb:
//   PDF_WORKER=aus node --import ./test/helpers/pdfBetrieb.js --test --test-concurrency=2 'test/{unit,integration,sicherheit}/**/*.test.js'
import { konfigurierePdfArbeit } from '../../src/services/pdfArbeit.js';

konfigurierePdfArbeit({ modus: process.env.PDF_WORKER === 'aus' ? 'aus' : 'an' });
