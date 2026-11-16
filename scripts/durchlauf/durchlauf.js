#!/usr/bin/env node
// Durchlauf-Test (docs/durchlauf-test.md): automatischer End-to-End-Durchlauf gegen eine TESTINSTANZ.
// Mail-Eingang (Betreiber schickt die Mail von Hand) → n8n → Portal → Kontierung (Person A) → Freigabe 2 (Person B)
// → Abholung durch n8n (und optional Archivquittung). Nie gegen das Live-Portal.
//
// Aufruf: npm run durchlauf [-- --ja] [-- --nur-portal] [-- --konfig <datei>] [-- --sichtbar]
// Exit-Code: 0 = alles erledigt, 1 = ein Schritt fehlgeschlagen, 2 = Konfiguration/Sitzung/Abbruch.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { leseArgumente, leseKonfiguration, parseKonfigText } from './konfiguration.js';
import { pruefeNichtLive, pruefeSitzungsDatei, pruefePersonenVerschieden, istBestaetigt, sitzungsDatei } from './sicherheit.js';
import { belegeAufDashboard, neueBelege, stand, versionAusFusszeile, exportStufe } from './seiten.js';
import { neuerBeleg, setzeSchritt, formatBericht, formatHandpruefung, exitCode, formatDauer } from './bericht.js';
import { BELEG_ORDNER, belegVorschlaege } from './testbelege.js';
import {
  starteBrowser, personKontext, pruefeAnmeldung, holeHtml, kontiere, gibFrei, abgeschlosseneStatus, archivAusstehend, bexioVersand,
  SchrittFehler, SitzungAbgelaufen, kurz,
} from './browser.js';

const ENDE_TEXT = { abgeholt: 'Abholung durch n8n', archiv_bestaetigt: 'Archivquittung von n8n', bexio_gemeldet: 'Abholung und Bexio-Versandquittung von n8n' };
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const zeit = (d) => d.toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });

function abbruch(text, code = 2) {
  console.error(`\nAbbruch: ${text}`);
  process.exitCode = code;
  return code;
}

// Liest die Sitzungsdatei einer Person (oder null).
function ladeSitzung(ordner, person) {
  const pfad = join(ordner, sitzungsDatei(person));
  if (!existsSync(pfad)) return { pfad, state: null };
  try { return { pfad, state: JSON.parse(readFileSync(pfad, 'utf8')) }; } catch { return { pfad, state: null }; }
}

async function frage(text) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(text); } finally { rl.close(); }
}

async function healthz(zielUrl) {
  try {
    const r = await fetch(new URL('/healthz', zielUrl), { signal: AbortSignal.timeout(15_000) });
    const body = await r.json().catch(() => ({}));
    return `${r.status} ${body.status ?? ''}`.trim();
  } catch (err) {
    return `nicht erreichbar (${err.cause?.code || err.name})`;
  }
}

function zeigeTestbelege() {
  const ordner = resolve(BELEG_ORDNER);
  const dateien = existsSync(ordner) ? readdirSync(ordner) : [];
  const vorschlaege = belegVorschlaege(dateien);
  if (vorschlaege.length === 0) {
    console.log(`  (Keine Testbelege in ${BELEG_ORDNER}/ – erzeugen mit: cd docs/testdrehbuch/belege && npm ci && npm run erzeugen)`);
    return;
  }
  console.log(`  Passende Testbelege aus ${BELEG_ORDNER}/:`);
  for (const v of vorschlaege) console.log(`    - ${v.datei}: ${v.text}`);
  console.log('  Jede Datei nimmt das Portal nur einmal an (gleiche Bytes = Duplikat). Für einen weiteren Lauf die Belege neu erzeugen.');
}

export async function main(argv = process.argv.slice(2)) {
  const args = leseArgumente(argv);
  if (args.fehler.length) return abbruch(args.fehler.join(' '));
  if (args.person) return abbruch(`Unbekannte Angabe: ${args.person} (Person nur bei npm run durchlauf:anmelden).`);

  if (!existsSync(args.konfigDatei)) {
    return abbruch(`Konfigurationsdatei ${args.konfigDatei} fehlt. Vorlage kopieren: cp .env.durchlauf.example .env.durchlauf`);
  }
  const { konfig, fehler } = leseKonfiguration(parseKonfigText(readFileSync(args.konfigDatei, 'utf8')), { nurPortal: args.nurPortal });
  if (fehler.length) return abbruch(`Konfiguration unvollständig:\n  - ${fehler.join('\n  - ')}`);
  const liveFehler = pruefeNichtLive(konfig.zielUrl, process.env);
  if (liveFehler) return abbruch(liveFehler);
  const ordner = resolve(konfig.ordner);

  // Gespeicherte Sitzungen vorab (ohne Netz) prüfen.
  const sitzungen = {};
  for (const person of ['a', 'b']) {
    const { pfad, state } = ladeSitzung(ordner, person);
    const p = pruefeSitzungsDatei(state, konfig.zielUrl, Date.now(), person);
    if (!p.ok) return abbruch(p.grund);
    sitzungen[person] = { pfad, gueltigBis: p.gueltigBis };
  }

  const browser = await starteBrowser({ sichtbar: args.sichtbar });
  try {
    return await ablauf({ args, konfig, ordner, sitzungen, browser });
  } catch (err) {
    if (err instanceof SitzungAbgelaufen) return abbruch(err.message);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function ablauf({ args, konfig, ordner, sitzungen, browser }) {
  const ziel = konfig.zielUrl;
  const kA = await personKontext(browser, sitzungen.a.pfad);
  const kB = await personKontext(browser, sitzungen.b.pfad);
  const anA = await pruefeAnmeldung(kA, ziel, 'a');
  const anB = await pruefeAnmeldung(kB, ziel, 'b');
  const verschieden = pruefePersonenVerschieden(anA.name, anB.name);
  if (verschieden) return abbruch(verschieden);

  // Sicherheitsabfrage
  console.log('\nDurchlauf-Test Freigabeportal');
  console.log(`  Ziel:        ${ziel.origin}`);
  console.log(`  Status:      /healthz ${await healthz(ziel)}`);
  console.log(`  Version:     ${versionAusFusszeile(anA.html) ?? '(in der Fusszeile nicht angezeigt)'}`);
  console.log(`  Person A:    ${anA.name} (Kontierung, Sitzung bis ${sitzungen.a.gueltigBis ? zeit(sitzungen.a.gueltigBis) : '?'})`);
  console.log(`  Person B:    ${anB.name} (Freigabe 2, Sitzung bis ${sitzungen.b.gueltigBis ? zeit(sitzungen.b.gueltigBis) : '?'})`);
  console.log(`  Testkonto:   ${konfig.konto}`);
  console.log(`  Belege:      ${konfig.anzahl}`);
  console.log(`  Ende:        ${args.nurPortal ? 'nach Freigabe 2 (--nur-portal)' : ENDE_TEXT[konfig.ende]}`);
  console.log('  Achtung: Der Lauf kontiert und gibt echte Belege auf dieser Instanz frei. Nur gegen eine Testinstanz verwenden.');
  if (!args.ja) {
    const antwort = await frage('\nIst das die Testinstanz und soll der Durchlauf starten? Mit «ja» bestätigen: ');
    if (!istBestaetigt(antwort)) return abbruch(process.stdin.isTTY ? 'Nicht bestätigt.' : 'Keine Eingabe möglich: mit --ja bestätigen.');
  }

  // Stand vor dem Eingang
  const vorher = stand(belegeAufDashboard(anA.html));
  const start = Date.now();
  console.log(`\n[${zeit(new Date(start))}] Jetzt die Testmail(s) mit ${konfig.anzahl} Beleg(en) an das Eingangs-Postfach schicken.`);
  zeigeTestbelege();
  console.log(`  Warte höchstens ${formatDauer(konfig.zeitlimitEingangMs)} auf neue Belege bei ${anA.name} (Pool oder «Meine offenen Kontierungen») …`);

  const ergebnis = { belege: [], allgemein: [] };
  let gefunden = [];
  while (Date.now() - start < konfig.zeitlimitEingangMs) {
    const { html } = await holeHtml(kA, new URL('/pool', ziel).href, { person: 'a' });
    const neu = neueBelege(vorher, belegeAufDashboard(html));
    for (const b of neu) {
      if (!gefunden.some((g) => g.id === b.id)) {
        gefunden.push({ ...b, dauerMs: Date.now() - start });
        console.log(`  Neuer Beleg #${b.id} (${b.bereich === 'pool' ? 'Pool' : 'bei A zugewiesen'}) nach ${formatDauer(Date.now() - start)}`);
      }
    }
    if (gefunden.length >= konfig.anzahl) break;
    await warte(konfig.abfrageMs);
  }
  if (gefunden.length > konfig.anzahl) {
    ergebnis.allgemein.push({ schritt: 'Eingang', status: 'ok', ursache: `${gefunden.length} neue Belege, verarbeitet werden die ersten ${konfig.anzahl}` });
    gefunden = gefunden.slice(0, konfig.anzahl);
  }
  if (gefunden.length < konfig.anzahl) {
    ergebnis.allgemein.push({ schritt: 'Eingang', status: 'fehler', dauerMs: Date.now() - start, ursache: `nur ${gefunden.length} von ${konfig.anzahl} Belegen innert ${formatDauer(konfig.zeitlimitEingangMs)} eingegangen (Mail angekommen? n8n-Test-Workflow aktiv? A in der Buchhaltung oder Zuweisungsregel auf A?)` });
  }

  // Kontierung und Freigabe 2 je Beleg
  for (const b of gefunden) {
    const beleg = neuerBeleg(b.id);
    ergebnis.belege.push(beleg);
    setzeSchritt(beleg, 'eingang', 'ok', { dauerMs: b.dauerMs });

    let t = Date.now();
    try {
      const k = await kontiere(kA, ziel, b, konfig);
      Object.assign(beleg, { dateiname: k.dateiname, lieferant: k.lieferant, betrag: k.betrag, rechnungsnummer: k.rechnungsnummer });
      setzeSchritt(beleg, 'kontierung', 'ok', { dauerMs: Date.now() - t, ursache: k.hinweise.join(', ') || null });
    } catch (err) {
      setzeSchritt(beleg, 'kontierung', 'fehler', { dauerMs: Date.now() - t, ursache: ursacheMitDateien(err) });
      continue;
    }

    // Vier-Augen-Prinzip: der Beleg muss jetzt bei B unter «Meine Freigaben» stehen.
    t = Date.now();
    const beiB = belegeAufDashboard((await holeHtml(kB, new URL('/pool', ziel).href, { person: 'b' })).html)
      .some((e) => e.id === b.id && e.bereich === 'freigabe2');
    if (!beiB) {
      setzeSchritt(beleg, 'freigabe2', 'fehler', { ursache: `Beleg steht nicht bei ${anB.name} unter «Meine Freigaben». Ist B Freigeber 2 von Konto ${konfig.konto}? (strikte Freigeber-1-Prüfung/Befangenheit?)` });
      continue;
    }
    try {
      const f = await gibFrei(kB, ziel, b, konfig);
      setzeSchritt(beleg, 'freigabe2', 'ok', { dauerMs: Date.now() - t, ursache: f.hinweise.join(', ') || null });
    } catch (err) {
      setzeSchritt(beleg, 'freigabe2', 'fehler', { dauerMs: Date.now() - t, ursache: ursacheMitDateien(err) });
    }
  }

  const freigegeben = ergebnis.belege.filter((b) => b.schritte.freigabe2.status === 'ok');
  if (args.nurPortal) {
    for (const b of freigegeben) {
      setzeSchritt(b, 'abgeholt', 'uebersprungen');
      setzeSchritt(b, 'archiv', 'uebersprungen');
      setzeSchritt(b, 'bexio', 'uebersprungen');
    }
  } else if (freigegeben.length > 0) {
    await warteAufExport({ kA, kB, ziel, konfig, belege: freigegeben });
  }

  console.log(`\nErgebnis (${zeit(new Date())}):\n`);
  console.log(formatBericht(ergebnis));
  console.log('');
  console.log(formatHandpruefung(ergebnis.belege));
  const code = exitCode(ergebnis);
  console.log(code === 0 ? '\nDurchlauf erfolgreich.' : '\nDurchlauf mit Fehlern (Exit-Code 1). Fehlerbilder: ' + join(ordner, 'fehler'));
  process.exitCode = code;
  return code;
}

// Wartet als Person B, bis n8n die Belege abgeholt hat und, je nach DURCHLAUF_ENDE, zusätzlich die Archiv- oder die
// Bexio-Versandquittung vorliegt. Die jeweils nicht verlangte Quittung wird nur angezeigt (✓ oder «? nicht gemeldet»).
async function warteAufExport({ kA, kB, ziel, konfig, belege }) {
  const start = Date.now();
  const mitArchiv = Boolean(konfig.n8nApiKey);
  const ende = konfig.ende;
  console.log(`\nWarte höchstens ${formatDauer(konfig.zeitlimitExportMs)} auf n8n (${ENDE_TEXT[ende]}) …`);
  // Belegseite: zuerst als B (Freigeber 2), sonst als A (zugewiesene Person).
  const belegseite = [{ kontext: kB, person: 'b' }, { kontext: kA, person: 'a' }];
  const offen = new Set(belege.map((b) => b.id));
  let letzterStatus = new Map();
  let letzterFehler = null;
  const bexioSichtbar = new Map();
  for (;;) {
    try {
      letzterStatus = await abgeschlosseneStatus(kB, ziel, belege.map((b) => b.id), 'b');
      const ausstehend = mitArchiv ? await archivAusstehend(ziel, konfig.n8nApiKey) : null;
      letzterFehler = null;
      for (const b of belege) {
        if (!offen.has(b.id)) continue;
        const stufe = exportStufe(b.id, letzterStatus.get(b.id), ausstehend);
        if (stufe.abgeholt && b.schritte.abgeholt.status !== 'ok') {
          setzeSchritt(b, 'abgeholt', 'ok', { dauerMs: Date.now() - start });
          console.log(`  #${b.id} abgeholt nach ${formatDauer(Date.now() - start)}`);
        }
        if (stufe.archivBestaetigt && b.schritte.archiv.status !== 'ok') {
          setzeSchritt(b, 'archiv', 'ok', { dauerMs: Date.now() - start });
          console.log(`  #${b.id} Archiv bestätigt nach ${formatDauer(Date.now() - start)}`);
        }
        if (b.schritte.bexio.status !== 'ok') {
          const versand = await bexioVersand(belegseite, ziel, b.id);
          bexioSichtbar.set(b.id, versand !== null);
          if (versand && versand.length > 0) {
            b.bexioVersand = versand;
            const v = versand.at(-1);
            setzeSchritt(b, 'bexio', 'ok', { dauerMs: Date.now() - start, ursache: `${v.zeitpunkt}, an ${v.empfaenger}, Message-ID ${v.messageId}` });
            console.log(`  #${b.id} Versand an Bexio gemeldet nach ${formatDauer(Date.now() - start)}`);
          }
        }
        const fertig = ende === 'archiv_bestaetigt' ? stufe.archivBestaetigt === true
          : ende === 'bexio_gemeldet' ? stufe.abgeholt && b.schritte.bexio.status === 'ok'
            : stufe.abgeholt;
        if (fertig) offen.delete(b.id);
      }
    } catch (err) {
      if (err instanceof SitzungAbgelaufen) throw err;
      letzterFehler = kurz(err);
    }
    if (offen.size === 0 || Date.now() - start >= konfig.zeitlimitExportMs) break;
    await warte(konfig.abfrageMs);
  }

  for (const b of belege) {
    const status = letzterStatus.get(b.id) ?? 'unbekannt';
    if (b.schritte.abgeholt.status !== 'ok') {
      setzeSchritt(b, 'abgeholt', 'fehler', {
        dauerMs: Date.now() - start,
        ursache: letzterFehler ?? `Status blieb «${status}»: n8n hat weder abholung-bestaetigen noch archivierung-bestaetigen gemeldet (Workflow aktiv? Zeitstempel ausstehend?)`,
      });
    }
    if (b.schritte.archiv.status !== 'ok') {
      if (ende === 'archiv_bestaetigt') {
        setzeSchritt(b, 'archiv', 'fehler', { dauerMs: Date.now() - start, ursache: letzterFehler ?? 'keine Archivquittung (n8n ruft archivierung-bestaetigen nicht auf?)' });
      } else {
        setzeSchritt(b, 'archiv', 'nicht_gemeldet');
      }
    }
    if (b.schritte.bexio.status !== 'ok') {
      if (ende === 'bexio_gemeldet') {
        const ursache = letzterFehler
          ?? (bexioSichtbar.get(b.id) === false ? 'Belegseite für A und B nicht sichtbar oder ohne Bexio-Angabe' : 'keine Versandquittung (n8n ruft bexio-versand-bestaetigen nicht auf?)');
        setzeSchritt(b, 'bexio', 'fehler', { dauerMs: Date.now() - start, ursache });
      } else {
        setzeSchritt(b, 'bexio', 'nicht_gemeldet');
      }
    }
  }
}

function ursacheMitDateien(err) {
  const text = err instanceof SchrittFehler ? err.message : kurz(err);
  const dateien = err instanceof SchrittFehler && err.dateien.length ? ` [${err.dateien.map((d) => d.split('/').pop()).join(', ')}]` : '';
  return `${text}${dateien}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
