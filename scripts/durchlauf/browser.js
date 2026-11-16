// Durchlauf-Test (docs/durchlauf-test.md): Browser-Schritte mit Playwright (Chromium).
// Seiten zum Abfragen (Aufgaben, Abgeschlossene Rechnungen) werden ohne Rendering über den Request-Kontext der
// Browser-Sitzung geholt; Kontierung und Freigabe 2 laufen in einer echten Seite, wie eine Person sie bedient.
// Selektoren: nur id-/name-Attribute aus views/kontierung.ejs, views/freigabe2.ejs, views/_job_aktionen.ejs.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { angemeldetAls, fehlerMeldungen, auffaelligkeitenTitel, abgeschlossenStatus, seitenAnzahl } from './seiten.js';
import { kontierungsWerte } from './formular.js';
import { dateiTeil } from './bericht.js';

// Fehler eines Schritts mit kurzer Ursache und (falls vorhanden) gesicherten Fehlerdateien.
export class SchrittFehler extends Error {
  constructor(ursache, { dateien = [] } = {}) {
    super(ursache);
    this.name = 'SchrittFehler';
    this.dateien = dateien;
  }
}

export class SitzungAbgelaufen extends Error {}

export async function starteBrowser({ sichtbar = false } = {}) {
  return chromium.launch({ headless: !sichtbar });
}

// Browser-Kontext einer Person aus ihrer gespeicherten Sitzung.
export async function personKontext(browser, storageStatePfad) {
  return browser.newContext({ storageState: storageStatePfad, viewport: { width: 1400, height: 1000 }, locale: 'de-CH' });
}

// Holt eine Seite ohne Umleitung zu folgen. Eine Umleitung zur Anmeldung heisst: Sitzung abgelaufen.
export async function holeHtml(kontext, url, { person = 'a' } = {}) {
  const antwort = await kontext.request.get(url, { maxRedirects: 0, failOnStatusCode: false, timeout: 60_000 });
  const ort = antwort.headers().location || '';
  if (antwort.status() === 302 && /\/auth\/login/.test(ort)) {
    throw new SitzungAbgelaufen(`Die Sitzung von Person ${person.toUpperCase()} ist abgelaufen: zuerst npm run durchlauf:anmelden -- ${person}`);
  }
  if (antwort.status() === 401) {
    throw new SitzungAbgelaufen(`Person ${person.toUpperCase()} ist nicht angemeldet: zuerst npm run durchlauf:anmelden -- ${person}`);
  }
  return { status: antwort.status(), html: await antwort.text(), ort };
}

// Prüft die Anmeldung einer Person auf der Aufgabenseite. @returns {{ name, html }}
export async function pruefeAnmeldung(kontext, zielUrl, person) {
  const { status, html } = await holeHtml(kontext, new URL('/pool', zielUrl).href, { person });
  const name = angemeldetAls(html);
  if (status !== 200 || !name) {
    throw new SitzungAbgelaufen(`Person ${person.toUpperCase()}: Aufgabenseite nicht erreichbar (HTTP ${status}). Zuerst npm run durchlauf:anmelden -- ${person}`);
  }
  return { name, html };
}

// Sichert Bildschirmfoto und HTML einer Seite in <ordner>/fehler/. @returns {string[]} Dateipfade
export async function sichereFehlerbild(page, ordner, name) {
  const dir = join(ordner, 'fehler');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const basis = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${dateiTeil(name)}`);
  const dateien = [];
  try {
    await page.screenshot({ path: `${basis}.png`, fullPage: true, timeout: 15_000 });
    chmodSync(`${basis}.png`, 0o600);
    dateien.push(`${basis}.png`);
  } catch { /* Seite schon zu */ }
  try { writeFileSync(`${basis}.html`, await page.content(), { mode: 0o600 }); dateien.push(`${basis}.html`); } catch { /* Seite schon zu */ }
  return dateien;
}

// Setzt ein <select> (auch das durchsuchbare der Kontierung, dessen Original visuell versteckt ist) und meldet die Änderung.
async function waehleOption(page, selektor, wert) {
  await page.locator(selektor).evaluate((select, v) => {
    select.value = v;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const suche = select.id ? document.getElementById(`${select.id}-suche`) : null;
    if (suche) suche.value = select.options[select.selectedIndex]?.textContent ?? '';
  }, wert);
}

// Kreuzt Radio/Checkbox an (die Konflikt-Karten verstecken das eigentliche Eingabefeld optisch).
async function kreuzeAn(page, selektor) {
  await page.locator(selektor).evaluate((feld) => {
    feld.checked = true;
    feld.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// Schickt das Formular über `knopf` ab und wartet auf die Antwort des POST und die Folgeseite.
async function sendeAb(page, knopf, pfad, zeitlimitMs) {
  const antwort = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === pfad, { timeout: zeitlimitMs });
  await page.locator(knopf).click({ timeout: zeitlimitMs });
  const r = await antwort;
  await page.waitForLoadState('domcontentloaded', { timeout: zeitlimitMs });
  return r.status();
}

const aufPool = (page) => new URL(page.url()).pathname === '/pool';

// Wirft mit Fehlerbild, wenn die Seite eine Fehlermeldung zeigt.
async function fehlerMitBild(page, ordner, name, ursache) {
  const meldungen = fehlerMeldungen(await page.content().catch(() => ''));
  const dateien = await sichereFehlerbild(page, ordner, name);
  throw new SchrittFehler(meldungen.length ? `${ursache}: ${meldungen.join(' / ')}` : ursache, { dateien });
}

// Kontierung (Freigabe 1) als Person A. Beansprucht einen Pool-Beleg vorher.
// @returns {{ dateiname, lieferant, betrag, rechnungsnummer, hinweise: string[] }}
export async function kontiere(kontext, zielUrl, beleg, konfig) {
  const page = await kontext.newPage();
  page.setDefaultTimeout(konfig.zeitlimitSchrittMs);
  const hinweise = [];
  try {
    if (beleg.bereich === 'pool') {
      await page.goto(new URL('/pool', zielUrl).href);
      const knopf = page.locator(`.beanspruchen-btn[data-job-id="${beleg.id}"]`).filter({ visible: true }).first();
      if (await knopf.count() === 0) await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-beanspruchen`, 'Beleg ist nicht mehr im Pool');
      await Promise.all([page.waitForURL(`**/kontierung/${beleg.id}`), knopf.click()]);
    } else {
      const r = await page.goto(new URL(`/kontierung/${beleg.id}`, zielUrl).href);
      if (!r || r.status() !== 200) await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-kontierung-laden`, `Kontierung nicht erreichbar (HTTP ${r?.status()})`);
    }
    if (!(await page.locator('#kontierung-form').count())) {
      await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-kontierung-laden`, 'Kein Kontierungsformular');
    }

    // Typ zuerst: das Konto-Filter-Skript leert ein Konto, das nicht zum Typ passt.
    await kreuzeAn(page, '#typRechnung');
    const formular = await page.evaluate(() => {
      const wert = (id) => document.getElementById(id)?.value ?? '';
      const optionen = (id) => Array.from(document.getElementById(id)?.options ?? []).map((o) => ({
        value: o.value, text: o.textContent.trim(), ibanPflicht: o.getAttribute('data-iban-pflicht') === '1', disabled: o.disabled,
      }));
      return {
        kontoOptionen: optionen('kontoId').filter((o) => !o.disabled),
        kreditorOptionen: optionen('kreditorId'),
        kreditorId: wert('kreditorId'),
        absender: wert('absender'),
        betrag: wert('betrag'),
        zahlungsziel: wert('zahlungsziel'),
        rechnungsnummer: wert('rechnungsnummer'),
        qrIban: wert('qrIban'),
        titel: document.querySelector('h1.seitenkopf-titel')?.textContent ?? '',
      };
    });
    const { werte, fehler, herkunft } = kontierungsWerte(formular, konfig, { jobId: beleg.id });
    if (!werte) await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-kontierung-werte`, fehler.join(' '));
    if (formular.qrIban) hinweise.push('QR erkannt');
    if (herkunft.lieferant) hinweise.push(`Lieferant ${herkunft.lieferant}`);
    if (herkunft.betrag) hinweise.push(`Betrag ${herkunft.betrag}`);

    await waehleOption(page, '#kontoId', werte.kontoId);
    await waehleOption(page, '#kreditorId', werte.kreditorId);
    await page.locator('#absender').fill(werte.absender);
    await page.locator('#rechnungsnummer').fill(werte.rechnungsnummer);
    await page.locator('#betrag').fill(werte.betrag);
    await page.locator('#zahlungsziel').fill(werte.zahlungsziel);
    if (werte.ibanEndung) await page.locator('#ibanEndung').fill(werte.ibanEndung);
    await kreuzeAn(page, '#konfliktNein');

    const pfad = `/kontierung/${beleg.id}`;
    await sendeAb(page, 'button[name="aktion"][value="kontieren"][data-konflikt-knopf]', pfad, konfig.zeitlimitSchrittMs);

    if (!aufPool(page)) {
      const befunde = auffaelligkeitenTitel(await page.content());
      if (befunde.length === 0) await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-kontierung`, 'Kontierung nicht gespeichert');
      if (konfig.auffaelligkeiten !== 'bestaetigen') {
        await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-auffaelligkeiten`, `Prüf-Popup (DURCHLAUF_AUFFAELLIGKEITEN=abbrechen): ${befunde.join('; ')}`);
      }
      // Prüf-Popup (views/_auffaelligkeiten_modal.ejs): Bemerkung setzen und «Geprüft, trotzdem speichern».
      const bestaetigen = page.locator('[data-auffaelligkeiten-bestaetigen]');
      await bestaetigen.waitFor({ state: 'visible' });
      await page.locator('#pruefBemerkung').fill('Automatischer Durchlauf-Test (Testinstanz)');
      await sendeAb(page, '[data-auffaelligkeiten-bestaetigen]', pfad, konfig.zeitlimitSchrittMs);
      hinweise.push(`Auffälligkeiten bestätigt: ${befunde.join('; ')}`);
      if (!aufPool(page)) await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-kontierung`, 'Kontierung nach Prüf-Popup nicht gespeichert');
    }
    const dateiname = formular.titel.replace(/^\s*Kontierung:\s*/, '').replace(/\s*#\d+\s*$/, '').replace(/\s+/g, ' ').trim() || null;
    return { dateiname, lieferant: werte.lieferant, betrag: werte.betrag, rechnungsnummer: werte.rechnungsnummer, hinweise };
  } catch (err) {
    if (err instanceof SchrittFehler || err instanceof SitzungAbgelaufen) throw err;
    const dateien = await sichereFehlerbild(page, konfig.ordner, `beleg${beleg.id}-kontierung`);
    throw new SchrittFehler(kurz(err), { dateien });
  } finally {
    await page.close().catch(() => {});
  }
}

// Freigabe 2 als Person B (Zahlungsdaten-Bestätigung, Befangenheit «Nein», Freigeben).
// @returns {{ hinweise: string[] }}
export async function gibFrei(kontext, zielUrl, beleg, konfig) {
  const page = await kontext.newPage();
  page.setDefaultTimeout(konfig.zeitlimitSchrittMs);
  const hinweise = [];
  try {
    const pfad = `/freigabe2/${beleg.id}`;
    const r = await page.goto(new URL(pfad, zielUrl).href);
    if (!r || r.status() !== 200 || !(await page.locator('#freigabe2-form').count())) {
      await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-freigabe2-laden`, `Freigabe 2 nicht möglich (HTTP ${r?.status()})`);
    }
    if (await page.locator('#zahlungsdatenBestaetigt').count()) {
      await kreuzeAn(page, '#zahlungsdatenBestaetigt');
      hinweise.push('Zahlungsdaten bestätigt');
    }
    if (await page.locator('#zahlungshinweiseBestaetigt').count()) {
      await kreuzeAn(page, '#zahlungshinweiseBestaetigt');
      hinweise.push('Zahlungshinweise bestätigt');
    }
    await kreuzeAn(page, '#f2konfliktNein');
    await sendeAb(page, '#freigabe2-form button[name="aktion"][value="freigeben"]', pfad, konfig.zeitlimitSchrittMs);
    if (!aufPool(page)) await fehlerMitBild(page, konfig.ordner, `beleg${beleg.id}-freigabe2`, 'Freigabe 2 nicht gespeichert');
    return { hinweise };
  } catch (err) {
    if (err instanceof SchrittFehler || err instanceof SitzungAbgelaufen) throw err;
    const dateien = await sichereFehlerbild(page, konfig.ordner, `beleg${beleg.id}-freigabe2`);
    throw new SchrittFehler(kurz(err), { dateien });
  } finally {
    await page.close().catch(() => {});
  }
}

// Status der gesuchten Belege auf «Abgeschlossene Rechnungen» (alle Seiten, bis alle gefunden sind).
// @returns {Map<number,string>}
export async function abgeschlosseneStatus(kontext, zielUrl, ids, person = 'b') {
  const gesucht = new Set(ids);
  const status = new Map();
  let seiten = 1;
  for (let seite = 1; seite <= seiten && seite <= 50; seite += 1) {
    const { html } = await holeHtml(kontext, new URL(`/meine-abgeschlossenen?seite=${seite}`, zielUrl).href, { person });
    seiten = seitenAnzahl(html);
    for (const [id, s] of abgeschlossenStatus(html)) if (gesucht.has(id)) status.set(id, s);
    if (status.size === gesucht.size) break;
  }
  return status;
}

// IDs ohne Archivquittung aus GET /api/n8n/jobs/archivierung-ausstehend (nur lesend, setzt nichts).
// Nie /abholbereit verwenden: das markiert Belege als abgeholt und stört den echten n8n-Ablauf.
export async function archivAusstehend(zielUrl, apiKey) {
  const ids = new Set();
  let nach = 0;
  for (let runde = 0; runde < 100; runde += 1) {
    const url = new URL('/api/n8n/jobs/archivierung-ausstehend', zielUrl);
    url.searchParams.set('nach_id', String(nach));
    const antwort = await fetch(url, { headers: { 'X-API-Key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!antwort.ok) throw new Error(`archivierung-ausstehend: HTTP ${antwort.status}`);
    const zeilen = await antwort.json();
    for (const z of zeilen) ids.add(Number(z.id));
    if (zeilen.length < 100) break;
    nach = Math.max(...zeilen.map((z) => Number(z.id)));
  }
  return ids;
}

// Kurze, einzeilige Ursache aus einer Ausnahme (Playwright-Meldungen sind mehrzeilig).
export function kurz(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, 300);
}
