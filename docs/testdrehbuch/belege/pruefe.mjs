import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const P = new URL('../../../src/services/', import.meta.url).href;
const { pruefeEingangsPdf } = await import(P + 'pdfEingang.js');
const { scanQrBill } = await import(P + 'qrBillScan.js');
const { extrahierePdfText } = await import(P + 'pdfText.js');
const { analysiereText, findeEndziffern, berechneVorschlaege } = await import(P + 'kkTextAnalyse.js');
const iu = await import(P + 'ibanUtils.js');
const OUT = new URL('./out/', import.meta.url).pathname;
for (const d of readdirSync(OUT).filter((x) => !x.endsWith('.json')).sort()) {
  for (const f of readdirSync(join(OUT, d)).sort()) {
    if (!f.endsWith('.pdf')) continue;
    const buf = readFileSync(join(OUT, d, f));
    let ein = 'ok'; try { await pruefeEingangsPdf(buf); } catch (e) { ein = 'ABGELEHNT ' + (e.code || e.message); }
    let qr = '-'; try { const q = scanQrBill(buf); if (q) qr = `${q.iban} ${q.betrag} ${q.waehrung} ${q.creditorName}`; } catch (e) { qr = 'err ' + e.message; }
    console.log(f.padEnd(62), '|', ein.padEnd(30), '|', qr);
  }
}
const ib = JSON.parse(readFileSync(OUT + 'ibans.json'));
console.log('IBAN-Prüfung:', Object.entries(ib).map(([k, v]) => `${k}=${(iu.isValidIban || iu.istGueltigeIban || iu.isValidSwissIban)?.(v)}`).join(' '), Object.keys(iu));
const text = extrahierePdfText(readFileSync(OUT + '2_Kreditkarte/KK1_Monatsabrechnung_Test-Visa_Oktober-2026.pdf'));
const a = analysiereText(text);
console.log('KK1 Endziffern:', findeEndziffern(text), 'Total:', a.total);
const belege = [[1,'45.20','2026-10-08'],[2,'120.00','2026-10-12'],[3,'30.10','2026-10-15'],[4,'-15.00','2026-10-18']].map(([id,betrag,kaufdatum])=>({id,betrag,kaufdatum}));
console.log('Vorschläge:', [...berechneVorschlaege(belege, a)]);
