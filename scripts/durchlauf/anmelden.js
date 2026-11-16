#!/usr/bin/env node
// Durchlauf-Test (docs/durchlauf-test.md): Person A oder B einmal anmelden und die Sitzung speichern.
// Öffnet einen sichtbaren Chromium auf <Ziel>/auth/login. Die Person meldet sich bei ChurchTools an; sobald die
// Portal-Startseite erreicht ist, speichert das Werkzeug den Playwright-storageState in <DURCHLAUF_ORDNER>/person-<a|b>.json
// (nur für den eigenen Benutzer lesbar, git-ignoriert). Die Sitzung gilt 8 Stunden (src/app.js).
//
// Aufruf: npm run durchlauf:anmelden -- a   bzw.   npm run durchlauf:anmelden -- b   [--konfig <datei>]
// `--kopflos` (ohne sichtbares Fenster) ist nur für die automatische Prüfung gegen ein lokales Portal gedacht.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { parseKonfigText, pruefeZielUrl, STANDARD_KONFIGDATEI, STANDARD_ORDNER } from './konfiguration.js';
import { pruefeNichtLive, pruefeSitzungsDatei, pruefePersonenVerschieden, sitzungsDatei, nurPortalSitzung } from './sicherheit.js';
import { angemeldetAls } from './seiten.js';

const ZEITLIMIT_MS = 10 * 60 * 1000;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

function abbruch(text) {
  console.error(`Abbruch: ${text}`);
  process.exitCode = 2;
  return 2;
}

export async function main(argv = process.argv.slice(2)) {
  let person = null;
  let konfigDatei = STANDARD_KONFIGDATEI;
  let kopflos = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--konfig') { konfigDatei = argv[i + 1]; i += 1; }
    else if (argv[i] === '--kopflos') kopflos = true;
    else if (/^[ab]$/i.test(argv[i])) person = argv[i].toLowerCase();
    else return abbruch(`Unbekannte Angabe: ${argv[i]}`);
  }
  if (!person) return abbruch('Welche Person? npm run durchlauf:anmelden -- a  (Kontierung)  oder  -- b  (Freigabe 2)');
  if (!konfigDatei || !existsSync(konfigDatei)) return abbruch(`Konfigurationsdatei ${konfigDatei} fehlt. Vorlage kopieren: cp .env.durchlauf.example .env.durchlauf`);
  const werte = parseKonfigText(readFileSync(konfigDatei, 'utf8'));
  const { url: ziel, fehler } = pruefeZielUrl(werte.DURCHLAUF_ZIEL_URL);
  if (fehler) return abbruch(fehler);
  const liveFehler = pruefeNichtLive(ziel, process.env);
  if (liveFehler) return abbruch(liveFehler);
  const ordner = resolve(werte.DURCHLAUF_ORDNER?.trim() || STANDARD_ORDNER);

  console.log(`Anmeldung Person ${person.toUpperCase()} (${person === 'a' ? 'Kontierung / Freigabe 1' : 'Freigabe 2'}) an ${ziel.origin}`);
  console.log('Im Browserfenster mit dem ChurchTools-Testkonto anmelden. Das Fenster schliesst sich danach von selbst.');

  const browser = await chromium.launch({ headless: kopflos });
  try {
    const kontext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-CH' });
    const page = await kontext.newPage();
    await page.goto(new URL('/auth/login', ziel).href);
    const start = Date.now();
    let name = null;
    while (Date.now() - start < ZEITLIMIT_MS) {
      if (page.isClosed()) return abbruch('Browserfenster geschlossen, bevor die Anmeldung fertig war.');
      let aktuell;
      try { aktuell = new URL(page.url()); } catch { aktuell = null; }
      if (aktuell && aktuell.origin === ziel.origin && !aktuell.pathname.startsWith('/auth/')) {
        name = angemeldetAls(await page.content().catch(() => ''));
        if (name) break;
      }
      await warte(1000);
    }
    if (!name) return abbruch('Keine Anmeldung innert 10 Minuten.');

    mkdirSync(ordner, { recursive: true, mode: 0o700 });
    const pfad = join(ordner, sitzungsDatei(person));
    const state = nurPortalSitzung(await kontext.storageState(), ziel);
    writeFileSync(pfad, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(pfad, 0o600);
    const pruefung = pruefeSitzungsDatei(state, ziel, Date.now(), person);
    const bis = pruefung.gueltigBis ? pruefung.gueltigBis.toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : 'unbekannt';
    console.log(`Angemeldet als ${name}. Sitzung gespeichert in ${pfad} (gültig bis ${bis}, 8 Stunden).`);

    // Hinweis, falls die andere Person schon mit demselben Konto gespeichert ist (Vier-Augen-Prinzip).
    const andere = person === 'a' ? 'b' : 'a';
    const anderePfad = join(ordner, sitzungsDatei(andere));
    if (existsSync(anderePfad)) {
      const anderer = await browser.newContext({ storageState: anderePfad });
      try {
        const antwort = await anderer.request.get(new URL('/pool', ziel).href, { maxRedirects: 0, failOnStatusCode: false });
        const andererName = antwort.status() === 200 ? angemeldetAls(await antwort.text()) : null;
        if (andererName && pruefePersonenVerschieden(name, andererName)) {
          console.warn(`Achtung: Person ${andere.toUpperCase()} ist ebenfalls als ${andererName} gespeichert. A und B müssen verschiedene Testkonten sein.`);
        }
      } finally {
        await anderer.close().catch(() => {});
      }
    } else {
      console.log(`Als Nächstes: npm run durchlauf:anmelden -- ${andere}`);
    }
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
