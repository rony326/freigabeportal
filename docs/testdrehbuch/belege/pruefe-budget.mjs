import { readFileSync } from 'node:fs';
import { leseTabelle, ordneZu, erkenneKopfzeile } from '../../../src/services/budgetImport.js';
import { pruefeEingangsPdf } from '../../../src/services/pdfEingang.js';
const konten = ['T1', 'T2', 'T3', 'T4'].map((k, i) => ({ id: i + 1, kontonummer: k }));
for (const [f, sk, sb] of [['out/5_Budgets/BU1_Budgets_2026.csv', 0, 1], ['out/5_Budgets/BU2_Budgets_2027.xlsx', 0, 2]]) {
  const z = await leseTabelle(readFileSync(f), f);
  const r = ordneZu(z, { spalteKonto: sk, spalteBetrag: sb, hatKopfzeile: erkenneKopfzeile(z, sb) }, konten);
  console.log(f.split('/').pop(), 'gueltig', r.gueltig.map((g) => `${g.kontonummer}=${g.betrag}`).join(' '), '| fehler', r.fehler.map((e) => `Z${e.zeile}: ${e.grund}`).join(' / '));
}
for (const f of ['out/1_Rechnungen/RP1_Rapport_Hauswartung_Oktober-2026.pdf', 'out/4_Sonderfaelle/X5_Rechnung 9001 – Kaffee 50 €.pdf']) {
  try { await pruefeEingangsPdf(readFileSync(f)); console.log('ok', f.split('/').pop()); } catch (e) { console.log('ABGELEHNT', f, e.code); }
}
