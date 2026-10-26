// PDF-Seiten am Handy/Tablet (Responsive-Durchgang, Ziel 5): unter 992 px Umschalter
// "Beleg / Formular", Vorschaubild und "PDF öffnen" (neuer Tab) statt eingebettetem PDF; ab 992 px
// wie bisher. Prüft das Markup der echten Seiten (Test-Instanz mit Beispieldaten wie
// npm run test:responsive) und die CSS-/Skript-Regeln, die ohne JS beide Bereiche zeigen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { starteResponsiveServer } from '../responsive/server.js';

const portalCss = readFileSync(new URL('../../public/css/portal.css', import.meta.url), 'utf8');
const skript = readFileSync(new URL('../../public/js/belegUmschalter.js', import.meta.url), 'utf8');

let server;
before(async () => { server = await starteResponsiveServer(); });
after(async () => { await server?.stop(); });

async function seite(pfad, als) {
  const res = await fetch(`${server.url}${pfad}${pfad.includes('?') ? '&' : '?'}als=${als}`);
  assert.equal(res.status, 200, `${pfad}: HTTP ${res.status}`);
  return res.text();
}

// Formularseiten: Umschalter + Formularspalte. einbetten: ab 992 px eingebettetes PDF (wie bisher).
const FORMULARSEITEN = [
  { name: 'Kontierung', pfad: (ids) => `/kontierung/${ids.anna}`, als: 'test-1', job: 'anna', iframe: 'kontierung-preview-frame', einbetten: true },
  { name: 'Freigabe 2', pfad: (ids) => `/freigabe2/${ids.freigabe2}`, als: 'test-2', job: 'freigabe2', iframe: 'freigabe2-preview-frame', einbetten: true },
  { name: 'Spesen-Freigabe 1', pfad: (ids) => `/spesen-freigabe1/${ids.spesen}`, als: 'test-1', job: 'spesen', iframe: 'spesen-freigabe1-preview-frame', einbetten: true },
  { name: 'KK-Abgleich', pfad: (ids) => `/kontierung/${ids.kkAbrechnung}/kk-abgleich`, als: 'test-1', job: 'kkAbrechnung', iframe: 'kontierung-preview-frame', einbetten: true, ohneThumbnail: true },
  // Aufsplitten hatte nie ein eingebettetes PDF: ab 992 px bleibt es so, darunter kommt der Beleg dazu.
  { name: 'Aufsplitten', pfad: (ids) => `/kontierung/${ids.anna}/aufsplitten`, als: 'test-1', job: 'anna', einbetten: false },
];

for (const s of FORMULARSEITEN) {
  test(`${s.name}: Umschalter Beleg/Formular, Vorschaubild und "PDF öffnen" mit frischer URL`, async () => {
    const id = server.ids[s.job];
    const html = await seite(s.pfad(server.ids), s.als);

    const container = html.match(/<div class="row[^"]*\bbeleg-umschalter\b[^"]*"[^>]*data-beleg-umschalter[^>]*>/);
    assert.ok(container, 'Container mit data-beleg-umschalter fehlt');
    assert.doesNotMatch(container[0], /data-ansicht|js-aktiv/, 'ohne JS darf nichts ausgeblendet sein');
    assert.match(container[0], new RegExp(`data-refresh-url="/downloads/${id}/refresh-url"`));

    // Knöpfe: erst mit JS sichtbar (hidden), nur unter 992 px, Formular vorgewählt.
    const knoepfe = html.match(/<div class="[^"]*\bbeleg-umschalter-knoepfe\b[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(knoepfe, 'Umschalter-Knöpfe fehlen');
    assert.match(knoepfe[0], /\bd-lg-none\b/);
    assert.match(knoepfe[0], /\shidden[\s>]/);
    assert.match(knoepfe[0], /<button type="button"[^>]*data-beleg-ansicht="beleg"[^>]*aria-pressed="false"[^>]*>Beleg<\/button>/);
    assert.match(knoepfe[0], /<button type="button"[^>]*data-beleg-ansicht="formular"[^>]*aria-pressed="true"[^>]*>Formular<\/button>/);

    // Belegbereich unter 992 px: Vorschaubild (oder Platzhalter) und "PDF öffnen" im neuen Tab.
    const pdfUrl = `/downloads/${id}/oeffnen`;
    assert.match(html, new RegExp(`<a class="btn btn-primary[^"]*" href="${pdfUrl}" target="_blank" rel="noopener">PDF öffnen</a>`));
    if (s.ohneThumbnail) {
      assert.doesNotMatch(html, new RegExp(`/downloads/${id}/thumbnail`));
      assert.match(html, /class="[^"]*beleg-umschalter-leer[^"]*"[^>]*>Keine Vorschau verfügbar</);
    } else {
      assert.match(html, new RegExp(`<a href="${pdfUrl}" target="_blank" rel="noopener"[^>]*><img [^>]*src="/downloads/${id}/thumbnail"[^>]*loading="lazy"`));
    }
    // Keine langlebige signierte URL als Link im Markup: "PDF öffnen" holt sie beim Klick frisch.
    assert.doesNotMatch(html, /<a [^>]*href="\/downloads\/\d+\?expires=/);

    // Formularspalte ist markiert, damit der Umschalter sie ausblenden kann.
    assert.match(html, /<div class="col-lg-\d+ beleg-umschalter-formular"/);

    if (s.einbetten) {
      // Desktop wie bisher: eingebettetes PDF, src erst per Skript (nur ab 992 px).
      assert.match(html, new RegExp(`<div class="d-none d-lg-block">\\s*<iframe id="${s.iframe}" data-preview-url="/downloads/${id}\\?expires=\\d+&amp;signature=[0-9a-f]{64}" src="" class="w-100 rounded pdf-preview"`));
    } else {
      assert.doesNotMatch(html, /<iframe[^>]*pdf-preview/);
    }
    assert.match(html, /<script src="\/js\/belegUmschalter\.js" defer><\/script>/);
  });
}

test('Pool-Vorschau: Vorschaubild ist ein Link "PDF öffnen" (neuer Tab, frische URL); Dialog nur ab 992 px', async () => {
  const id = server.ids.pool;
  const html = await seite('/pool', 'test-4');
  assert.match(html, new RegExp(`<a href="/downloads/${id}/oeffnen" target="_blank" rel="noopener" class="thumbnail-link"[^>]*aria-label="PDF öffnen[^"]*"><img class="thumbnail-preview`));
  // Klick-Handler: ab 992 px Dialog mit eingebettetem PDF wie bisher, darunter Standardverhalten des Links.
  assert.match(html, /matchMedia\('\(min-width: 992px\)'\)\.matches/);
  assert.match(html, /preventDefault\(\)/);
});

test('portal.css: Bereiche werden nur mit aktivem Skript und nur unter 992 px ausgeblendet', () => {
  const regeln = portalCss.match(/@media \(max-width: 991\.98px\) \{\s*\.beleg-umschalter\.js-aktiv\[data-ansicht="formular"\] \.beleg-umschalter-beleg,\s*\.beleg-umschalter\.js-aktiv\[data-ansicht="beleg"\] \.beleg-umschalter-formular \{\s*display: none;/);
  assert.ok(regeln, 'Ausblende-Regel für den Umschalter fehlt oder ist nicht an .js-aktiv gebunden');
  // Keine andere Regel blendet die Bereiche aus (ohne JS sind beide sichtbar).
  const alle = [...portalCss.matchAll(/([^{}]*\.beleg-umschalter-(?:beleg|formular)[^{}]*)\{([^}]*)\}/g)];
  for (const [, selektor, inhalt] of alle) {
    if (/display:\s*none/.test(inhalt)) assert.match(selektor, /\.js-aktiv\[data-ansicht=/, `blendet ohne JS aus: ${selektor.trim()}`);
  }
  assert.match(portalCss, /\.beleg-umschalter-knoepfe \.btn \{[^}]*min-height: 44px/);
});

test('belegUmschalter.js: iframe lädt nur ab 992 px, Auffrischen wie bisher über refresh-url, Knöpfe mit aria-pressed', () => {
  assert.match(skript, /matchMedia\('\(min-width: 992px\)'\)/);
  assert.match(skript, /'\/vendor\/pdfjs\/web\/viewer\.html\?file=' \+ encodeURIComponent\(absoluteUrl\)/);
  assert.match(skript, /new URL\([^)]*previewUrl, window\.location\.origin\)/);
  assert.match(skript, /preview-refresh-btn/);
  assert.match(skript, /dataset\.refreshUrl/);
  assert.match(skript, /setAttribute\('aria-pressed'/);
  assert.match(skript, /classList\.add\('js-aktiv'\)/);
  assert.match(skript, /removeAttribute\('hidden'\)/);
});
