// Hilfsfunktionen für Formularvalidierung mit Feldzuordnung (Barrierefreiheit: aria-invalid).
// Verwendung: Route sammelt Fehler mit `neueFehler()`, View markiert die Felder mit `feldFehlerAttr()`.

// Sammelt Formularfehler samt Zuordnung zum Eingabefeld (id des Elements; null = ohne Feld).
export function neueFehler() {
  const liste = [];
  const proFeld = {};
  return {
    add(feld, text) {
      liste.push(text);
      if (feld && !(feld in proFeld)) proFeld[feld] = text;
    },
    get liste() { return liste; },
    get proFeld() { return proFeld; },
  };
}

// Attribute für ein fehlerhaftes Feld (in der View mit <%- ausgeben).
export function feldFehlerAttr(feldFehler, id) {
  return feldFehler && Object.hasOwn(feldFehler, id) ? ` aria-invalid="true" aria-describedby="${id}-fehler"` : '';
}
