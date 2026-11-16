// Durchlauf-Test (docs/durchlauf-test.md): passende Testbelege aus docs/testdrehbuch/belege/out/1_Rechnungen/ vorschlagen.
// Reine Logik. Sonderfälle (Kopie/Dublette, falsche IBAN, Sammelrechnung, Gutschrift, Lieferant ohne hinterlegte IBAN)
// sind bewusst keine Standardbelege: sie lösen Prüf-Popups, Sperren oder andere Abläufe aus.

export const BELEG_ORDNER = 'docs/testdrehbuch/belege/out/1_Rechnungen';

// Reihenfolge = Empfehlung. `praefix` ist der Anfang des Dateinamens aus belege/gen.mjs.
export const EMPFOHLENE_BELEGE = [
  { praefix: 'R1_', text: 'QR-Rechnung «Testlieferant AG», IBAN hinterlegt: Lieferant und Betrag werden vorbelegt (Standardfall)' },
  { praefix: 'R4_', text: 'ohne QR-Code: braucht DURCHLAUF_LIEFERANT, DURCHLAUF_BETRAG und DURCHLAUF_IBAN_ENDUNG' },
  { praefix: 'R4b_', text: 'ohne QR-Code, wie R4 (für einen zweiten Beleg im selben Lauf)' },
  { praefix: 'R4c_', text: 'ohne QR-Code, wie R4' },
];

// Nicht als Standard: Grund je Präfix (für die Doku und die Ausgabe).
export const SONDERFAELLE = {
  'R2_': 'Kopie von R1 (Dubletten-Prüfung)',
  'R2b_': 'gleicher Betrag wie R1 (Dubletten-Verdacht)',
  'R3_': 'falsche IBAN (Betrugserkennung)',
  'R5_': 'Sammelrechnung zum Aufsplitten',
  'R6_': 'Gutschrift',
  'R7a_': 'Lieferant ohne hinterlegte IBAN',
  'R7b_': 'Lieferant ohne hinterlegte IBAN',
};

// Vorschläge aus den vorhandenen Dateien. @returns {{ datei: string, text: string }[]}
export function belegVorschlaege(dateien = []) {
  const vorschlaege = [];
  for (const { praefix, text } of EMPFOHLENE_BELEGE) {
    const datei = dateien.filter((d) => d.startsWith(praefix) && d.toLowerCase().endsWith('.pdf')).sort()[0];
    if (datei) vorschlaege.push({ datei, text });
  }
  return vorschlaege;
}
