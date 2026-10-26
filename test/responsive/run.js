// Responsive-Browsertest: jede Seite aus seiten.js in 360/768/1024/1280 px.
// Prüft: seitliches Scrollen (ueberlauf), Touch-Ziele < 44 px (touch, nur Touch-Breiten, inkl.
// Reiter und Seitenleisten-Punkte — unter 992 px im geöffneten Menü), Knopf-/Menütext passt in
// seinen Kasten (text), Bedienelemente überdecken sich nicht (ueberlappung), Menü unter 992 px
// (menue), Testmodus-Band höchstens 30 % hoch und Inhalt erreichbar (band), PDF-Seiten mit
// Beleg/Formular-Umschalter (pdf: true in seiten.js) laden unter 992 px weder PDF.js-Viewer noch
// signiertes PDF, ab 992 px ist das eingebettete PDF geladen (iframe). Dialoge (modal: in seiten.js)
// werden über ihren Knopf geöffnet und samt iframe-Dokument geprüft (modal). Das ✕ einer Meldung
// (.alert .btn-close) liegt in seiner Meldung, bei kompakten Meldungen mittig (schliessen). Text in
// farbig hinterlegten Tabellenzeilen (überfällig/hängt) hat ≥ 4.5:1 Kontrast (kontrast). Ab 1200 px
// passt die Dateiauswahl ("Datei auswählen | Keine ausgewählt") ungekürzt in ihr Feld (text).
// Farbschema: alle Breiten hell, zusätzlich 360 und 1280 px dunkel (DUNKEL_BREITEN).
// Aufruf: npm run test:responsive [-- --seite=<Teil des Namens> --breite=360 --farbschema=dunkel]
// Ausgabe: eine Zeile je Verstoss "Breite Seite Art Selektor Masse", danach Zusammenfassung.
// Exit-Codes: 0 alles gut, 1 Verstösse, 2 Test selbst gescheitert (Browser/Server startet nicht,
// Seite lädt nicht oder falscher HTTP-Status, Filter passt auf nichts) — getrennt ausgegeben.
// Gibt es beides, kommt Exit 2; die Verstösse werden trotzdem ausgegeben und ausdrücklich erwähnt.
// Screenshots der betroffenen Seiten nach test-results/responsive/.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { starteResponsiveServer } from './server.js';
import { SEITEN, BREITEN } from './seiten.js';

const MIN_TOUCH = 44;
const MENUE_BIS = 992;
const BAND_MAX_ANTEIL = 0.3;
const PARALLEL = 4;
const DUNKEL_BREITEN = new Set([360, 1280]);
const MIN_KONTRAST = 4.5;
const DATEIAUSWAHL_AB = 1200;
const SCREENSHOT_DIR = new URL('../../test-results/responsive/', import.meta.url).pathname;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const filterSeite = arg('seite');
const filterBreite = arg('breite') ? Number(arg('breite')) : null;
const filterSchema = arg('farbschema') || null;

function slug(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function pfadFuer(seite, ids) {
  let pfad = seite.pfad.replace(/\{(\w+)\}/g, (_, k) => {
    if (ids[k] === undefined) throw new Error(`seiten.js: unbekannter Platzhalter {${k}} in ${seite.name}`);
    return encodeURIComponent(ids[k]);
  });
  if (seite.als) pfad += `${pfad.includes('?') ? '&' : '?'}als=${seite.als}`;
  return pfad;
}

// Läuft im Browser: sammelt Verstösse gegen Überlauf, Touch-Ziele und Band-Höhe.
// wurzel: nur Elemente darin prüfen (geöffnetes Menü), dann ohne Überlauf und Band.
function pruefeImBrowser({ minTouch, touch, bandMaxAnteil, minKontrast, dateiauswahlAb, wurzel = null }) {
  const verstoesse = [];
  const bereich = wurzel ? document.querySelector(wurzel) : document;
  if (!bereich) return verstoesse;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const masse = (r) => `${Math.round(r.width)}×${Math.round(r.height)}`;
  const markiere = (el) => el.setAttribute('data-responsive-verstoss', '');
  function selektor(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    else {
      const klassen = [...el.classList].filter((k) => !k.startsWith('responsive-')).slice(0, 3);
      if (klassen.length) s += `.${klassen.join('.')}`;
      if (el.name) s += `[name="${el.name}"]`;
      else if (el.type && el.tagName === 'INPUT') s += `[type=${el.type}]`;
    }
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (text && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) s += ` "${text}"`;
    return s;
  }
  const sichtbar = (el) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false; // leer oder .visually-hidden
    // geschlossenes Offcanvas (Seitenleiste unter 992 px) oder eingeklappter Bereich
    if (el.closest('.offcanvas:not(.show):not(.showing), .offcanvas-lg:not(.show):not(.showing)')) {
      const oc = el.closest('.offcanvas, .offcanvas-lg');
      const st = getComputedStyle(oc);
      if (st.visibility === 'hidden' || st.position === 'fixed') return false;
    }
    if (el.closest('.collapse:not(.show), .modal:not(.show), [hidden], [inert]')) return false;
    return true;
  };

  // 1. Seitliches Scrollen. Tabellen in .table-responsive (bzw. jedes Element in einem eigenen
  // Scroll-Rahmen mit overflow-x auto/scroll) zählen nicht: nur ihr Rahmen scrollt.
  const scrollBreite = document.documentElement.scrollWidth;
  if (!wurzel && scrollBreite > vw + 1) {
    const inScrollRahmen = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        // Nur echte Scroll-Rahmen (z. B. .table-responsive); overflow hidden schneidet nur ab.
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    // Rechter Rand inkl. überlaufendem Inhalt (lange Wörter sind Textknoten, keine Elemente).
    const rechts = (el) => {
      const r = el.getBoundingClientRect();
      const ox = getComputedStyle(el).overflowX;
      const inhalt = ox === 'visible' ? r.left + el.scrollWidth : r.right;
      return Math.max(r.right, inhalt) + window.scrollX;
    };
    const zuBreit = (el) => el.getBoundingClientRect().width > 0 && rechts(el) > vw + 1;
    const kandidaten = [...document.body.querySelectorAll('*')].filter((el) => zuBreit(el) && !inScrollRahmen(el)
      && getComputedStyle(el).position !== 'fixed' && el.checkVisibility());
    // Verursacher: die tiefsten zu breiten Elemente (kein zu breites Kind-Element mehr).
    const menge = new Set(kandidaten);
    const ursachen = kandidaten.filter((el) => ![...el.children].some((k) => menge.has(k)));
    const liste = (ursachen.length ? ursachen : kandidaten).slice(0, 5);
    if (!liste.length) verstoesse.push({ art: 'ueberlauf', selektor: 'html', masse: `scrollWidth ${scrollBreite} > ${vw}` });
    for (const el of liste) {
      markiere(el);
      verstoesse.push({ art: 'ueberlauf', selektor: selektor(el), masse: `rechts ${Math.round(rechts(el))} > ${vw} (Seite ${scrollBreite})` });
    }
  }

  const ZIELE = 'a.btn, button, input:not([type=hidden]), select, textarea, .form-check-input, .nav-link, .portal-punkt, .dropdown-item';
  const sichtbareZiele = [...bereich.querySelectorAll(ZIELE)].filter(sichtbar);

  // 2. Touch-Ziele (nur Touch-Breiten).
  if (touch) {
    for (const el of sichtbareZiele) {
      let r = el.getBoundingClientRect();
      let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      // Checkbox/Radio: das zugehörige Label vergrössert die Klickfläche.
      if (el.matches('input[type=checkbox], input[type=radio]') && el.labels) {
        for (const label of el.labels) {
          if (!sichtbar(label)) continue;
          const l = label.getBoundingClientRect();
          box = { left: Math.min(box.left, l.left), top: Math.min(box.top, l.top), right: Math.max(box.right, l.right), bottom: Math.max(box.bottom, l.bottom) };
        }
      }
      const b = box.right - box.left;
      const h = box.bottom - box.top;
      if (b + 0.5 < minTouch || h + 0.5 < minTouch) {
        markiere(el);
        verstoesse.push({ art: 'touch', selektor: selektor(el), masse: `${Math.round(b)}×${Math.round(h)}` });
      }
    }
  }

  // 3. Text passt: Knopf- und Menütext ragt nicht über den Rand seines Kastens hinaus (abgeschnitten
  // oder in den Nachbarn hinein). Gemessen wird der Inhalt selbst (Range), nicht scrollWidth: Text,
  // der nur ins Innenpolster ragt, ist noch ganz im Kasten sichtbar.
  for (const el of sichtbareZiele) {
    if (!el.matches('a.btn, button, .nav-link, .portal-punkt, .dropdown-item')) continue;
    const bereichText = document.createRange();
    bereichText.selectNodeContents(el);
    const t = bereichText.getBoundingClientRect();
    if (t.width < 1 || t.height < 1) continue;
    const r = el.getBoundingClientRect();
    if (t.left < r.left - 1 || t.right > r.right + 1 || t.top < r.top - 1 || t.bottom > r.bottom + 1) {
      markiere(el);
      verstoesse.push({ art: 'text', selektor: selektor(el), masse: `Inhalt ${Math.round(t.width)}×${Math.round(t.height)} ragt aus Kasten ${masse(r)}` });
    }
  }

  // 4. Überlappung: zwei Bedienelemente (keines im anderen) überdecken sich um mehr als 1 px in
  // beiden Richtungen. Knopfgruppen/Eingabegruppen teilen sich nur den 1-px-Rand.
  const kaesten = sichtbareZiele.map((el) => ({ el, r: el.getBoundingClientRect() }));
  for (let i = 0; i < kaesten.length; i += 1) {
    for (let j = i + 1; j < kaesten.length; j += 1) {
      const a = kaesten[i];
      const b = kaesten[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (x > 1 && y > 1) {
        markiere(a.el);
        markiere(b.el);
        verstoesse.push({ art: 'ueberlappung', selektor: `${selektor(a.el)} ⟷ ${selektor(b.el)}`, masse: `${Math.round(x)}×${Math.round(y)}` });
      }
    }
  }
  // 5. Schliessen-✕ einer Meldung: liegt ganz in der Meldung (hing bei "Gespeichert." darunter
  // heraus); bei kompakten einzeiligen Meldungen (.alert-kompakt) zusätzlich senkrecht mittig.
  for (const knopf of bereich.querySelectorAll('.alert .btn-close')) {
    if (!sichtbar(knopf)) continue;
    const meldung = knopf.closest('.alert');
    const a = meldung.getBoundingClientRect();
    const k = knopf.getBoundingClientRect();
    if (k.left < a.left - 1 || k.right > a.right + 1 || k.top < a.top - 1 || k.bottom > a.bottom + 1) {
      markiere(knopf);
      verstoesse.push({ art: 'schliessen', selektor: selektor(meldung).replace(/ ".*$/, ''), masse: `✕ ${masse(k)} bei y ${Math.round(k.top - a.top)} ragt aus Meldung ${masse(a)}` });
    } else if (meldung.classList.contains('alert-kompakt') && Math.abs((k.top + k.bottom) / 2 - (a.top + a.bottom) / 2) > 2) {
      markiere(knopf);
      verstoesse.push({ art: 'schliessen', selektor: selektor(meldung).replace(/ ".*$/, ''), masse: `✕ nicht mittig (${Math.round(k.top - a.top)} oben, ${Math.round(a.bottom - k.bottom)} unten)` });
    }
  }

  // 6. Kontrast in farbig hinterlegten Tabellenzeilen (.table-warning/.table-danger …): jeder
  // Textträger (Elemente mit eigenem Text, Knöpfe) gegen den tatsächlichen Hintergrund.
  // rgb()/rgba() und color(srgb …) (Ergebnis von color-mix, Werte 0–1).
  const rgba = (farbe) => {
    const m = /rgba?\(([^)]+)\)/.exec(farbe);
    const srgb = /color\(srgb ([^)]+)\)/.exec(farbe);
    if (!m && !srgb) return null;
    const t = (m || srgb)[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const f = srgb ? 255 : 1;
    return { r: t[0] * f, g: t[1] * f, b: t[2] * f, a: t.length > 3 ? t[3] : 1 };
  };
  const mische = (vorne, hinten) => ({ r: vorne.r * vorne.a + hinten.r * (1 - vorne.a), g: vorne.g * vorne.a + hinten.g * (1 - vorne.a), b: vorne.b * vorne.a + hinten.b * (1 - vorne.a), a: 1 });
  const hintergrund = (el) => {
    const schichten = [];
    for (let p = el; p; p = p.parentElement) {
      const f = rgba(getComputedStyle(p).backgroundColor);
      if (f && f.a > 0) { schichten.push(f); if (f.a >= 1) break; }
    }
    return schichten.reverse().reduce((h, f) => mische(f, h), { r: 255, g: 255, b: 255, a: 1 });
  };
  const leucht = ({ r, g, b }) => {
    const k = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * k(r) + 0.7152 * k(g) + 0.0722 * k(b);
  };
  const kontrast = (x, y) => { const [h, d] = [leucht(x), leucht(y)].sort((m, n) => n - m); return (h + 0.05) / (d + 0.05); };
  for (const el of bereich.querySelectorAll('tbody tr[class*="table-"] *')) {
    const eigenerText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!eigenerText || !sichtbar(el)) continue;
    const bg = hintergrund(el);
    const st = getComputedStyle(el);
    const farbe = rgba(st.color);
    if (!farbe) {
      verstoesse.push({ art: 'kontrast', selektor: selektor(el), masse: `Farbe nicht lesbar: ${st.color}` });
      continue;
    }
    const fg = mische({ ...farbe, a: farbe.a * Number(st.opacity) }, bg);
    const wert = kontrast(fg, bg);
    if (wert + 0.005 < minKontrast) {
      markiere(el);
      verstoesse.push({ art: 'kontrast', selektor: selektor(el), masse: `${wert.toFixed(2)}:1 < ${minKontrast}:1 (${st.color} auf rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}))` });
    }
  }

  // 7. Dateiauswahl ab dateiauswahlAb px: Knopf und "Keine ausgewählt" passen ungekürzt ins Feld.
  if (vw >= dateiauswahlAb) {
    for (const el of bereich.querySelectorAll('input[type=file]')) {
      if (!sichtbar(el)) continue;
      const probe = el.cloneNode();
      Object.assign(probe.style, { width: 'max-content', position: 'absolute', visibility: 'hidden', left: '0', top: '0' });
      el.parentElement.append(probe);
      const noetig = probe.getBoundingClientRect().width;
      probe.remove();
      const breite = el.getBoundingClientRect().width;
      if (breite + 1 < noetig) {
        markiere(el);
        verstoesse.push({ art: 'text', selektor: selektor(el), masse: `Dateiauswahl ${Math.round(breite)} px breit, braucht ${Math.round(noetig)} px` });
      }
    }
  }
  if (wurzel) return verstoesse;

  // 8. Testmodus-Band höchstens 30 % des Bildschirms, Inhalt bleibt erreichbar.
  const band = document.querySelector('.testmodus-band');
  if (band) {
    const r = band.getBoundingClientRect();
    if (r.height > vh * bandMaxAnteil) {
      markiere(band);
      verstoesse.push({ art: 'band', selektor: selektor(band).replace(/ ".*$/, ''), masse: `Höhe ${Math.round(r.height)} > ${Math.round(vh * bandMaxAnteil)} (${masse(r)})` });
    }
    const main = document.querySelector('main');
    if (main && main.getBoundingClientRect().top >= vh) {
      verstoesse.push({ art: 'band', selektor: 'main', masse: `Inhalt beginnt bei ${Math.round(main.getBoundingClientRect().top)} ≥ ${vh}` });
    }
  }
  return verstoesse;
}

async function pruefeMenue(page, optionen) {
  const hatLeiste = await page.locator('#portal-seitenleiste').count();
  if (!hatLeiste) return []; // Seiten ohne Rahmen (z. B. Aufsplitten im Modal) haben kein Menü
  const knopf = page.locator('#seitenleiste-toggle');
  if (!(await knopf.count()) || !(await knopf.isVisible())) {
    return [{ art: 'menue', selektor: '#seitenleiste-toggle', masse: 'Menü-Knopf fehlt oder unsichtbar' }];
  }
  try {
    await knopf.click({ timeout: 3000 });
    await page.waitForFunction(() => {
      const leiste = document.querySelector('#portal-seitenleiste');
      if (!leiste || !leiste.classList.contains('show')) return false;
      const r = leiste.getBoundingClientRect();
      return r.width > 0 && r.right > 0 && r.left < document.documentElement.clientWidth && getComputedStyle(leiste).visibility !== 'hidden';
    }, null, { timeout: 3000 });
    // Menüpunkte im geöffneten Menü messen (Touch-Grösse, Text, Überlappung); Einblenden abwarten.
    await page.waitForFunction(() => !document.querySelector('#portal-seitenleiste.showing'), null, { timeout: 3000 }).catch(() => {});
    const imMenue = await page.evaluate(pruefeImBrowser, { ...optionen, wurzel: '#portal-seitenleiste' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#portal-seitenleiste')?.classList.contains('show'), null, { timeout: 3000 }).catch(() => {});
    return imMenue;
  } catch (err) {
    return [{ art: 'menue', selektor: '#portal-seitenleiste', masse: `öffnet nicht (${String(err.message).split('\n')[0].slice(0, 80)})` }];
  }
}

// PDF-Seiten (Beleg/Formular-Umschalter): unter 992 px kein eingebettetes PDF (keine Anfrage an
// Viewer oder signiertes PDF, auch nicht nach dem Umschalten auf "Beleg"), ab 992 px ist das
// iframe geladen (src gesetzt) — sofern die Seite eines hat (Aufsplitten hat keins).
async function pruefePdf(page, b, pdfAnfragen) {
  if (b.breite < MENUE_BIS) {
    const knopf = page.locator('[data-beleg-ansicht="beleg"]');
    if (await knopf.count() && await knopf.isVisible()) {
      await knopf.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    return pdfAnfragen.length
      ? [{ art: 'iframe', selektor: 'iframe.pdf-preview', masse: `${pdfAnfragen.length} PDF-Anfragen unter ${MENUE_BIS} px (${pdfAnfragen[0]})` }]
      : [];
  }
  const src = await page.evaluate(() => {
    const frame = document.querySelector('[data-beleg-umschalter] iframe[data-preview-url]');
    return frame ? frame.getAttribute('src') || '' : null;
  });
  if (src === null || src.includes('/vendor/pdfjs/web/viewer.html')) return [];
  return [{ art: 'iframe', selektor: 'iframe.pdf-preview', masse: `src nicht gesetzt ab ${MENUE_BIS} px ("${src.slice(0, 40)}")` }];
}

// Dialog (seite.modal): über den Knopf öffnen, dann im offenen Dialog Touch/Text/Überlappung, ob
// der Schliessen-Knopf frei liegt (z. B. nicht unter dem Testmodus-Band) und — mit iframe — das
// iframe-Dokument wie eine eigene Seite prüfen, ohne Beleg/Formular-Umschalter (eingebettet).
async function pruefeModal(page, m, optionen) {
  const verstoesse = [];
  try {
    await page.locator(m.knopf).first().click({ timeout: 3000 });
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      // Eingeblendet: .show gesetzt und die Fade-Animation fertig (sonst misst man den Zwischenstand).
      return el && el.classList.contains('show') && getComputedStyle(el).opacity === '1'
        && getComputedStyle(el.querySelector('.modal-dialog') || el).transform === 'none';
    }, m.modal, { timeout: 5000 });
  } catch (err) {
    return [{ art: 'modal', selektor: m.modal, masse: `öffnet nicht (${String(err.message).split('\n')[0].slice(0, 80)})` }];
  }
  verstoesse.push(...await page.evaluate(pruefeImBrowser, { ...optionen, wurzel: m.modal }));
  const frei = await page.evaluate((sel) => {
    const knopf = document.querySelector(`${sel} .modal-header .btn-close`);
    if (!knopf) return null;
    const r = knopf.getBoundingClientRect();
    const oben = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return oben && (oben === knopf || knopf.contains(oben)) ? '' : `verdeckt von ${oben ? oben.tagName.toLowerCase() + (oben.className ? `.${String(oben.className).split(' ')[0]}` : '') : 'nichts'}`;
  }, m.modal);
  if (frei) verstoesse.push({ art: 'modal', selektor: `${m.modal} .btn-close`, masse: frei });
  if (m.iframe) {
    try {
      const handle = await page.waitForSelector(`${m.iframe}[src]:not([src=""])`, { timeout: 5000 });
      const frame = await handle.contentFrame();
      await frame.waitForLoadState('load', { timeout: 15000 });
      await frame.waitForSelector('main', { timeout: 15000 });
      await page.waitForTimeout(100);
      verstoesse.push(...(await frame.evaluate(pruefeImBrowser, optionen)).map((v) => ({ ...v, selektor: `iframe ${v.selektor}` })));
      const umschalter = await frame.evaluate(() => {
        const k = document.querySelector('.beleg-umschalter-knoepfe');
        return Boolean(k && k.checkVisibility({ checkVisibilityCSS: true }) && k.getBoundingClientRect().height > 1);
      });
      if (umschalter) verstoesse.push({ art: 'modal', selektor: 'iframe .beleg-umschalter-knoepfe', masse: 'Umschalter im eingebetteten Dokument sichtbar' });
    } catch (err) {
      verstoesse.push({ art: 'modal', selektor: m.iframe, masse: `lädt nicht (${String(err.message).split('\n')[0].slice(0, 80)})` });
    }
  }
  return verstoesse;
}

async function sendeFehlerzustand(page, fz) {
  // Auf die vollständig geladene Antwortseite warten (nicht nur auf die Antwort: sonst läuft die
  // Prüfung noch im alten oder halb aufgebauten Dokument und findet nichts).
  const navigation = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
  // Scheitert evaluate unten (oder fehlt das Formular), würde das Warten später ohne Abnehmer
  // abgelehnt (unhandled rejection) — der Fehler kommt stattdessen über das throw unten bzw. await.
  navigation.catch(() => {});
  const ok = await page.evaluate(({ formular, felder, knopf }) => {
    const form = document.querySelector(formular);
    if (!form) return false;
    form.noValidate = true;
    for (const [name, wert] of Object.entries(felder || {})) {
      for (const el of [...form.elements].filter((e) => e.name === name)) {
        el.removeAttribute('maxlength');
        el.removeAttribute('required');
        if (el.type === 'radio' || el.type === 'checkbox') el.checked = false;
        else el.value = wert;
      }
    }
    // Ungespeichert-Warnungen (beforeunload) würden das Absenden aufhalten.
    window.onbeforeunload = null;
    // Natives submit() umgeht die JS-Submit-Handler der Seite, schickt aber den Knopf nicht mit.
    const submitter = knopf ? document.querySelector(knopf) : null;
    if (submitter?.name) {
      const feld = Object.assign(document.createElement('input'), { type: 'hidden', name: submitter.name, value: submitter.value });
      form.append(feld);
    }
    HTMLFormElement.prototype.submit.call(form);
    return true;
  }, fz);
  if (!ok) throw new Error(`Formular ${fz.formular} nicht gefunden`);
  const res = await navigation;
  // POST → 302 → GET (Post/Redirect/Get) ist erlaubt: geprüft wird die Zielseite, deren Status zählt.
  let anfrage = res?.request();
  while (anfrage?.redirectedFrom()) anfrage = anfrage.redirectedFrom();
  if (!res || anfrage.method() !== 'POST') throw new Error(`Formular ${fz.formular}: keine POST-Antwort`);
  return res.status();
}

async function pruefeSeite(browser, server, seite, b, schema) {
  const context = await browser.newContext({
    viewport: { width: b.breite, height: b.hoehe },
    isMobile: b.isMobile,
    hasTouch: b.hasTouch,
    deviceScaleFactor: 1,
    locale: 'de-CH',
    colorScheme: schema === 'dunkel' ? 'dark' : 'light',
  });
  // Kein Netz für den Browser: alles ausser dem lokalen Server wird abgebrochen.
  await context.route((url) => !url.href.startsWith(`${server.url}/`), (route) => route.abort());
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  // PDF-Seiten: Anfragen an den PDF.js-Viewer bzw. an das signierte PDF (/downloads/:id?expires…)
  // mitschreiben — unter 992 px darf keine kommen (nur Vorschaubild /downloads/:id/thumbnail).
  const pdfAnfragen = [];
  if (seite.pdf) {
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname.startsWith('/vendor/pdfjs/web/viewer.html')
        || (/^\/downloads\/[^/]+$/.test(u.pathname) && u.searchParams.has('signature'))) {
        pdfAnfragen.push(u.pathname);
      }
    });
  }
  const verstoesse = [];
  const fehler = []; // Infrastruktur/Laden (falscher HTTP-Status, Zeitüberschreitung …): Exit 2
  try {
    const pfad = pfadFuer(seite, server.ids);
    const res = await page.goto(server.url + pfad, { waitUntil: 'load', timeout: 30000 });
    let status = res ? res.status() : 0;
    if (seite.fehlerzustand) {
      if (status !== 200) fehler.push(`${pfad}: Formularseite HTTP ${status}`);
      status = await sendeFehlerzustand(page, seite.fehlerzustand);
    }
    const erwartet = seite.status ?? 200;
    if (status !== erwartet) fehler.push(`${pfad}: HTTP ${status} statt ${erwartet}`);
    await page.waitForTimeout(50);
    const optionen = { minTouch: MIN_TOUCH, touch: b.hasTouch, bandMaxAnteil: BAND_MAX_ANTEIL, minKontrast: MIN_KONTRAST, dateiauswahlAb: DATEIAUSWAHL_AB };
    verstoesse.push(...await page.evaluate(pruefeImBrowser, optionen));
    if (b.breite < MENUE_BIS) verstoesse.push(...await pruefeMenue(page, optionen));
    if (seite.pdf) verstoesse.push(...await pruefePdf(page, b, pdfAnfragen));
    if (seite.modal) verstoesse.push(...await pruefeModal(page, seite.modal, optionen));
    if (verstoesse.length) {
      await page.addStyleTag({ content: '[data-responsive-verstoss]{outline:3px solid #e00 !important;outline-offset:-1px}' }).catch(() => {});
      // fullPage verliert bei isMobile/hasTouch die (pointer: coarse)-Emulation während der Aufnahme
      // (zeigt dann Desktop-Grössen): stattdessen das Fenster auf Seitenhöhe ziehen.
      const hoehe = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => b.hoehe);
      await page.setViewportSize({ width: b.breite, height: Math.min(Math.max(hoehe, b.hoehe), 16000) }).catch(() => {});
      await page.screenshot({ path: join(SCREENSHOT_DIR, `${b.breite}${schema === 'dunkel' ? '-dunkel' : ''}-${slug(seite.name)}.png`) }).catch(() => {});
    }
  } catch (err) {
    fehler.push(`${seite.pfad}: ${String(err.message).split('\n')[0].slice(0, 160)}`);
  } finally {
    await context.close().catch(() => {});
  }
  const seitenName = schema === 'dunkel' ? `${seite.name} (dunkel)` : seite.name;
  return {
    verstoesse: verstoesse.map((v) => ({ ...v, breite: b.breite, seite: seitenName })),
    fehler: fehler.map((text) => `${b.breite}  ${seitenName}  ${text}`),
  };
}

// Gleiche Verstösse (gleiche Art, Selektor, Masse) auf einer Seite zu einer Zeile zusammenfassen.
function zusammenfassen(verstoesse) {
  const map = new Map();
  for (const v of verstoesse) {
    const key = `${v.breite}|${v.seite}|${v.art}|${v.selektor}|${v.masse}`;
    const e = map.get(key);
    if (e) e.anzahl += 1;
    else map.set(key, { ...v, anzahl: 1 });
  }
  return [...map.values()];
}

function tabelle(verstoesse, breiten) {
  const arten = ['ueberlauf', 'touch', 'text', 'ueberlappung', 'menue', 'band', 'iframe', 'modal', 'schliessen', 'kontrast'];
  const zeilen = [['Art', ...breiten.map((b) => String(b.breite)), 'Summe']];
  for (const art of arten) {
    const proBreite = breiten.map((b) => verstoesse.filter((v) => v.art === art && v.breite === b.breite).length);
    zeilen.push([art, ...proBreite.map(String), String(proBreite.reduce((a, c) => a + c, 0))]);
  }
  const summe = breiten.map((b) => verstoesse.filter((v) => v.breite === b.breite).length);
  zeilen.push(['Summe', ...summe.map(String), String(verstoesse.length)]);
  const breite = zeilen[0].map((_, i) => Math.max(...zeilen.map((z) => z[i].length)));
  return zeilen.map((z) => z.map((c, i) => (i === 0 ? c.padEnd(breite[i]) : c.padStart(breite[i]))).join('  ')).join('\n');
}

// Aufräumen auch bei Abbruch (Ctrl-C, kill): Browser schliessen, Server und Temp-Verzeichnis weg.
let aufraeumen = async () => {};
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    console.error(`\nAbbruch (${signal}) — räume auf …`);
    await aufraeumen().catch(() => {});
    process.exit(code);
  });
}

function abbruch(meldung) {
  console.error(meldung);
  process.exitCode = 2;
}

async function main() {
  if (filterSchema && !['hell', 'dunkel'].includes(filterSchema)) {
    return abbruch(`--farbschema=${filterSchema} gibt es nicht. Gültig: hell, dunkel.`);
  }
  if (filterBreite !== null && !BREITEN.some((b) => b.breite === filterBreite)) {
    return abbruch(`--breite=${arg('breite')} gibt es nicht. Gültig: ${BREITEN.map((b) => b.breite).join(', ')}.`);
  }
  const seiten = SEITEN.filter((s) => !filterSeite || s.name.toLowerCase().includes(filterSeite.toLowerCase()));
  const breiten = BREITEN.filter((b) => !filterBreite || b.breite === filterBreite);
  if (!seiten.length) {
    return abbruch(`--seite=${filterSeite} passt auf keine Seite. Beispiele: ${SEITEN.slice(0, 8).map((s) => `"${s.name}"`).join(', ')} … (alle in test/responsive/seiten.js).`);
  }
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const schemata = (b) => ['hell', ...(DUNKEL_BREITEN.has(b.breite) || filterSchema === 'dunkel' ? ['dunkel'] : [])]
    .filter((schema) => !filterSchema || schema === filterSchema);
  const auftraege = breiten.flatMap((b) => schemata(b).flatMap((schema) => seiten.map((s) => ({ s, b, schema }))));
  const alle = [];
  const fehler = [];
  const start = Date.now();
  let server = null;
  let browser = null;
  aufraeumen = async () => {
    const b = browser;
    const sv = server;
    browser = null;
    server = null;
    if (b) await b.close().catch(() => {});
    if (sv) await sv.stop();
  };
  try {
    server = await starteResponsiveServer();
    browser = await chromium.launch();
    let naechster = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (naechster < auftraege.length && browser) {
        const { s, b, schema } = auftraege[naechster++];
        const ergebnis = await pruefeSeite(browser, server, s, b, schema);
        alle.push(...ergebnis.verstoesse);
        fehler.push(...ergebnis.fehler);
      }
    }));
  } finally {
    await aufraeumen();
  }

  const reihenfolge = (v) => [breiten.findIndex((b) => b.breite === v.breite), seiten.findIndex((s) => s.name === v.seite.replace(/ \(dunkel\)$/, ''))];
  const zeilen = zusammenfassen(alle).sort((a, b) => {
    const [ab, as] = reihenfolge(a);
    const [bb, bs] = reihenfolge(b);
    return ab - bb || as - bs || a.art.localeCompare(b.art);
  });
  for (const z of zeilen) {
    console.log(`${z.breite}  ${z.seite}  ${z.art}  ${z.selektor}  ${z.masse}${z.anzahl > 1 ? `  (×${z.anzahl})` : ''}`);
  }
  console.log(`\n${auftraege.length} Prüfungen (${seiten.length} Seiten × ${breiten.length} Breiten, hell${auftraege.some((a) => a.schema === 'dunkel') ? ` + dunkel bei ${[...new Set(auftraege.filter((a) => a.schema === 'dunkel').map((a) => a.b.breite))].join('/')} px` : ''}) in ${Math.round((Date.now() - start) / 1000)} s — ${alle.length} Verstösse (${zeilen.length} Zeilen)\n`);
  console.log(tabelle(alle, breiten));
  if (alle.length) {
    const proSeite = new Map();
    for (const v of alle) proSeite.set(v.seite, (proSeite.get(v.seite) || 0) + 1);
    const top = [...proSeite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\nMeiste Verstösse: ${top.map(([s, n]) => `${s} ${n}`).join(', ')}`);
    console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  }
  if (fehler.length) {
    console.error(`\n${fehler.length} Seiten liessen sich nicht prüfen (Infrastruktur/Laden — keine Layout-Verstösse):`);
    for (const f of fehler.sort()) console.error(`  ${f}`);
    if (alle.length) {
      console.error(`\nAchtung: zusätzlich ${alle.length} Verstösse (oben aufgelistet). Exit 2 hat Vorrang vor 1 — nach dem Beheben der Ladefehler bleiben diese Verstösse.`);
    }
    process.exitCode = 2;
    return;
  }
  process.exitCode = alle.length ? 1 : 0;
}

main().catch((err) => {
  // z. B. Browser startet nicht (fehlende Systembibliotheken): Server ist im finally bereits gestoppt.
  console.error(err);
  process.exitCode = 2;
});
