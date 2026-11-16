// Gemeinsame Regeln für Texteingaben aus Formularen: Höchstlängen an EINER Stelle (Server-Prüfung und maxlength in den
// Formularen lesen dieselben Werte) und das Lesen eines Formularfelds als Text. Hintergrund: Ein mehrfach gesendetes
// Feld (`feld=a&feld=b`) oder eine verschachtelte Form (`feld[x]=y`) kommt bei Express als Array bzw. Objekt an;
// `.trim()` darauf endete bisher in Fehler 500. Jetzt ergibt es einen verständlichen Feldfehler (400).

// Höchstlängen in Zeichen. Bestehende Grenzen bleiben: Fehlermeldung/Rapport-Bemerkung 2000, Prüf-Bemerkung 500.
export const MAX_LAENGE = Object.freeze({
  einzeilig: 200, // Absender, Lieferantenname, Titel, Position, Verwendungszweck-Kurzfelder
  rechnungsnummer: 100,
  text: 2000, // Begründungen, Verwendungszweck/Beschreibung, Bemerkungen, Notizen, Fehlerbeschreibung
  betrag: 30, // Betrag/Gesamtbetrag als Text (Zahlen sind kürzer; verhindert nur absurd lange Eingaben)
  kennung: 50, // technische Werte (Konto-ID, Datum, Auswahlfelder)
});

// Middleware: stellt die Höchstlängen den Views bereit (`maxlength="<%= maxLen.text %>"`).
export function eingabeGrenzen(req, res, next) {
  res.locals.maxLen = MAX_LAENGE;
  next();
}

/**
 * Liest ein Formularfeld als Text: getrimmt, nie ein Array/Objekt, höchstens `max` Zeichen.
 * Ein fehlendes Feld ergibt '' ohne Fehler (ob es Pflicht ist, prüft die Route).
 * @param {unknown} wert Wert aus req.body
 * @param {{max: number, feld: string}} opts max: Höchstlänge; feld: Bezeichnung für die Meldung (z. B. «Begründung»)
 * @returns {{wert: string, fehler: string|null}} wert: getrimmter Text ('' bei Fehler durch Nicht-Text); fehler: Meldung oder null
 */
export function leseText(wert, { max, feld }) {
  if (wert === undefined || wert === null) return { wert: '', fehler: null };
  if (typeof wert !== 'string') return { wert: '', fehler: `${feld}: Bitte genau einen Text angeben.` };
  const text = wert.trim();
  if (text.length > max) return { wert: text, fehler: `${feld} darf höchstens ${max} Zeichen lang sein.` };
  return { wert: text, fehler: null };
}
