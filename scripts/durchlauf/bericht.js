// Durchlauf-Test (docs/durchlauf-test.md): Ergebnis sammeln und als Tabelle, Handprüf-Liste und Exit-Code ausgeben.
// Reine Logik ohne Ein-/Ausgabe.

// Schritte je Beleg, in dieser Reihenfolge.
export const SCHRITTE = [
  ['eingang', 'Eingang im Portal'],
  ['kontierung', 'Kontierung (Person A)'],
  ['freigabe2', 'Freigabe 2 (Person B)'],
  ['abgeholt', 'Von n8n abgeholt'],
  ['archiv', 'Archiv bestätigt'],
];

// Status eines Schritts:
//   ok             erledigt
//   fehler         fehlgeschlagen oder Zeitlimit
//   offen          wegen eines früheren Fehlers nicht ausgeführt
//   uebersprungen  bewusst ausgelassen (--nur-portal)
//   nicht_gemeldet n8n meldet die Archivierung nicht (DURCHLAUF_ENDE=abgeholt): Handprüfung in Paperless
export const ZEICHEN = { ok: '✓', fehler: '✗', offen: '·', uebersprungen: '–', nicht_gemeldet: '?' };
const OK_FUER_EXIT = new Set(['ok', 'uebersprungen', 'nicht_gemeldet']);

const TEXT_NICHT_GEMELDET = 'nicht gemeldet – in Paperless von Hand prüfen';

// Neuer Beleg im Ergebnis, alle Schritte offen.
export function neuerBeleg(id) {
  const schritte = {};
  for (const [schluessel] of SCHRITTE) schritte[schluessel] = { status: 'offen', dauerMs: null, ursache: null };
  return { id, dateiname: null, betrag: null, lieferant: null, rechnungsnummer: null, hinweise: [], schritte };
}

// Setzt einen Schritt. `ursache` bei Fehlern (kurz, ohne Geheimnisse), bei ok optional als Hinweis.
export function setzeSchritt(beleg, schritt, status, { dauerMs = null, ursache = null } = {}) {
  if (!beleg.schritte[schritt]) throw new Error(`Unbekannter Schritt: ${schritt}`);
  beleg.schritte[schritt] = { status, dauerMs, ursache };
}

// Dauer lesbar: «850 ms», «42 s», «3 min 05 s».
export function formatDauer(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// Breite einer Zeichenkette in Spalten (Kombinationszeichen zählen nicht; ✓/✗ als eins).
const breite = (s) => [...String(s).normalize('NFC')].length;
const fuelle = (s, n) => String(s) + ' '.repeat(Math.max(0, n - breite(s)));

// Tabelle aller Belege und Schritte. `allgemein`: Fehler ausserhalb einzelner Belege (z. B. zu wenige Eingänge).
export function formatBericht({ belege = [], allgemein = [] } = {}) {
  const zeilen = [['Beleg', 'Schritt', 'Status', 'Dauer', 'Ursache / Hinweis']];
  for (const eintrag of allgemein) {
    zeilen.push(['–', eintrag.schritt, ZEICHEN[eintrag.status] ?? eintrag.status, formatDauer(eintrag.dauerMs), eintrag.ursache ?? '']);
  }
  for (const beleg of belege) {
    for (const [schluessel, titel] of SCHRITTE) {
      const s = beleg.schritte[schluessel];
      const ursache = s.status === 'nicht_gemeldet' ? (s.ursache ?? TEXT_NICHT_GEMELDET)
        : s.status === 'uebersprungen' ? (s.ursache ?? 'übersprungen (--nur-portal)')
          : (s.ursache ?? '');
      zeilen.push([`#${beleg.id}`, titel, ZEICHEN[s.status] ?? s.status, formatDauer(s.dauerMs), ursache]);
    }
  }
  const spalten = zeilen[0].length;
  const breiten = Array.from({ length: spalten - 1 }, (_, i) => Math.max(...zeilen.map((z) => breite(z[i]))));
  const formatZeile = (z) => z.map((zelle, i) => (i < spalten - 1 ? fuelle(zelle, breiten[i]) : zelle)).join('  ').trimEnd();
  const trenner = breiten.map((b) => '-'.repeat(b)).join('  ') + '  ' + '-'.repeat(17);
  return [formatZeile(zeilen[0]), trenner, ...zeilen.slice(1).map(formatZeile)].join('\n');
}

// Liste für die Handprüfung in Paperless und im Bexio-Postfach.
export function formatHandpruefung(belege = []) {
  const fertig = belege.filter((b) => b.schritte.freigabe2.status === 'ok');
  if (fertig.length === 0) return 'Handprüfung: keine freigegebenen Belege.';
  const zeilen = ['Handprüfung (Paperless und Versand an Bexio kennt das Portal nicht):'];
  for (const b of fertig) {
    zeilen.push(`  Portal-ID #${b.id} · ${b.dateiname ?? '(Dateiname unbekannt)'} · CHF ${b.betrag ?? '?'} · ${b.lieferant ?? '(Lieferant unbekannt)'} · Rechnungsnummer ${b.rechnungsnummer ?? '?'}`);
    zeilen.push('    [ ] Dokument in Paperless vorhanden (Suche nach Rechnungsnummer oder Dateiname)');
    zeilen.push('    [ ] Mail an Bexio angekommen und Beleg dort erfasst');
  }
  return zeilen.join('\n');
}

// Exit-Code: 0 nur, wenn kein Schritt fehlgeschlagen oder offen ist und kein allgemeiner Fehler vorliegt.
export function exitCode({ belege = [], allgemein = [] } = {}) {
  if (allgemein.some((e) => e.status === 'fehler')) return 1;
  if (belege.length === 0) return 1;
  for (const beleg of belege) {
    for (const [schluessel] of SCHRITTE) {
      if (!OK_FUER_EXIT.has(beleg.schritte[schluessel].status)) return 1;
    }
  }
  return 0;
}

// Für Dateinamen von Fehlerbildern: nur harmlose Zeichen.
export function dateiTeil(text) {
  return String(text ?? '').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}
