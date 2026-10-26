// Responsive-Browsertest: jede Seite aus seiten.js in 360/768/1024/1280 px.
// Prüft: seitliches Scrollen (ueberlauf), Touch-Ziele < 44 px (touch, nur Touch-Breiten), Menü
// unter 992 px (menue), Testmodus-Band höchstens 30 % hoch und Inhalt erreichbar (band),
// HTTP-Status bzw. Ladefehler (status).
// Aufruf: npm run test:responsive [-- --seite=<Teil des Namens> --breite=360]
// Ausgabe: eine Zeile je Verstoss "Breite Seite Art Selektor Masse", danach Zusammenfassung.
// Exit-Code 1 bei Verstössen. Screenshots der betroffenen Seiten nach test-results/responsive/.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { starteResponsiveServer } from './server.js';
import { SEITEN, BREITEN } from './seiten.js';

const MIN_TOUCH = 44;
const MENUE_BIS = 992;
const BAND_MAX_ANTEIL = 0.3;
const PARALLEL = 4;
const SCREENSHOT_DIR = new URL('../../test-results/responsive/', import.meta.url).pathname;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const filterSeite = arg('seite');
const filterBreite = arg('breite') ? Number(arg('breite')) : null;

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
function pruefeImBrowser({ minTouch, touch, bandMaxAnteil }) {
  const verstoesse = [];
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
  // Scroll-Rahmen) zählen nicht: ihr Rahmen schneidet sie ab.
  const scrollBreite = document.documentElement.scrollWidth;
  if (scrollBreite > vw + 1) {
    const inScrollRahmen = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible' && ox !== 'clip') return true;
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

  // 2. Touch-Ziele (nur Touch-Breiten).
  if (touch) {
    const ziele = document.querySelectorAll('a.btn, button, input:not([type=hidden]), select, textarea, .form-check-input');
    for (const el of ziele) {
      if (!sichtbar(el)) continue;
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

  // 3. Testmodus-Band höchstens 30 % des Bildschirms, Inhalt bleibt erreichbar.
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

async function pruefeMenue(page) {
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
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#portal-seitenleiste')?.classList.contains('show'), null, { timeout: 3000 }).catch(() => {});
    return [];
  } catch (err) {
    return [{ art: 'menue', selektor: '#portal-seitenleiste', masse: `öffnet nicht (${String(err.message).split('\n')[0].slice(0, 80)})` }];
  }
}

async function sendeFehlerzustand(page, fz) {
  const antwort = page.waitForResponse((r) => r.request().method() === 'POST' && r.request().resourceType() === 'document', { timeout: 15000 });
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
  const res = await antwort;
  await page.waitForLoadState('load');
  return res.status();
}

async function pruefeSeite(browser, server, seite, b) {
  const context = await browser.newContext({
    viewport: { width: b.breite, height: b.hoehe },
    isMobile: b.isMobile,
    hasTouch: b.hasTouch,
    deviceScaleFactor: 1,
    locale: 'de-CH',
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const verstoesse = [];
  try {
    const pfad = pfadFuer(seite, server.ids);
    const res = await page.goto(server.url + pfad, { waitUntil: 'load', timeout: 30000 });
    let status = res ? res.status() : 0;
    if (seite.fehlerzustand) {
      if (status !== 200) verstoesse.push({ art: 'status', selektor: pfad, masse: `Formularseite HTTP ${status}` });
      status = await sendeFehlerzustand(page, seite.fehlerzustand);
    }
    const erwartet = seite.status ?? 200;
    if (status !== erwartet) verstoesse.push({ art: 'status', selektor: pfad, masse: `HTTP ${status} statt ${erwartet}` });
    await page.waitForTimeout(50);
    verstoesse.push(...await page.evaluate(pruefeImBrowser, { minTouch: MIN_TOUCH, touch: b.hasTouch, bandMaxAnteil: BAND_MAX_ANTEIL }));
    if (b.breite < MENUE_BIS) verstoesse.push(...await pruefeMenue(page));
    if (verstoesse.length) {
      await page.addStyleTag({ content: '[data-responsive-verstoss]{outline:3px solid #e00 !important;outline-offset:-1px}' }).catch(() => {});
      await page.screenshot({ path: join(SCREENSHOT_DIR, `${b.breite}-${slug(seite.name)}.png`), fullPage: true }).catch(() => {});
    }
  } catch (err) {
    verstoesse.push({ art: 'status', selektor: seite.pfad, masse: `Fehler: ${String(err.message).split('\n')[0].slice(0, 120)}` });
  } finally {
    await context.close();
  }
  return verstoesse.map((v) => ({ ...v, breite: b.breite, seite: seite.name }));
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
  const arten = ['ueberlauf', 'touch', 'menue', 'band', 'status'];
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

async function main() {
  const seiten = SEITEN.filter((s) => !filterSeite || s.name.toLowerCase().includes(filterSeite.toLowerCase()));
  const breiten = BREITEN.filter((b) => !filterBreite || b.breite === filterBreite);
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const server = await starteResponsiveServer();
  const browser = await chromium.launch();
  const auftraege = breiten.flatMap((b) => seiten.map((s) => ({ s, b })));
  const alle = [];
  const start = Date.now();
  try {
    let naechster = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (naechster < auftraege.length) {
        const { s, b } = auftraege[naechster++];
        alle.push(...await pruefeSeite(browser, server, s, b));
      }
    }));
  } finally {
    await browser.close();
    await server.stop();
  }

  const reihenfolge = (v) => [breiten.findIndex((b) => b.breite === v.breite), seiten.findIndex((s) => s.name === v.seite)];
  const zeilen = zusammenfassen(alle).sort((a, b) => {
    const [ab, as] = reihenfolge(a);
    const [bb, bs] = reihenfolge(b);
    return ab - bb || as - bs || a.art.localeCompare(b.art);
  });
  for (const z of zeilen) {
    console.log(`${z.breite}  ${z.seite}  ${z.art}  ${z.selektor}  ${z.masse}${z.anzahl > 1 ? `  (×${z.anzahl})` : ''}`);
  }
  console.log(`\n${seiten.length} Seiten × ${breiten.length} Breiten in ${Math.round((Date.now() - start) / 1000)} s — ${alle.length} Verstösse (${zeilen.length} Zeilen)\n`);
  console.log(tabelle(alle, breiten));
  if (alle.length) {
    const proSeite = new Map();
    for (const v of alle) proSeite.set(v.seite, (proSeite.get(v.seite) || 0) + 1);
    const top = [...proSeite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\nMeiste Verstösse: ${top.map(([s, n]) => `${s} ${n}`).join(', ')}`);
    console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  }
  process.exitCode = alle.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
