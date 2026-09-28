import * as mupdf from 'mupdf';

const MAX_SEITEN = 20;

// Reiner Text aller Seiten (höchstens MAX_SEITEN) -- Grundlage für Kartenerkennung und
// Zuordnungs-Vorschläge. Gescannte Bild-PDFs liefern schlicht leeren Text; das ist kein Fehler.
export function extrahierePdfText(pdfBuffer) {
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  try {
    const seiten = Math.min(doc.countPages(), MAX_SEITEN);
    const teile = [];
    for (let i = 0; i < seiten; i++) {
      const page = doc.loadPage(i);
      try {
        const st = page.toStructuredText();
        try {
          teile.push(st.asText());
        } finally {
          st.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return teile.join('\n');
  } finally {
    doc.destroy();
  }
}
