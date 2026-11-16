// Durchlauf-Test (docs/durchlauf-test.md): Konfiguration aus `.env.durchlauf` lesen und prüfen.
// Reine Logik ohne Datei- und Netzzugriff, damit sie unter test/unit/ ohne Browser prüfbar ist.
// Die Zieladresse hat bewusst keinen Standardwert: ohne DURCHLAUF_ZIEL_URL läuft nichts.

import { parseEnv } from 'node:util';

export const ENDE_WERTE = ['abgeholt', 'archiv_bestaetigt'];
export const AUFFAELLIGKEITEN_WERTE = ['bestaetigen', 'abbrechen'];
export const STANDARD_KONFIGDATEI = '.env.durchlauf';
export const STANDARD_ORDNER = '.durchlauf';

// Hosts, für die auch http:// erlaubt ist (lokales Portal zum Ausprobieren). Alles andere nur https://.
const LOKALE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Zerlegt den Inhalt einer .env-Datei (gleiche Syntax wie `node --env-file`).
// @returns {Record<string,string>}
export function parseKonfigText(text) {
  return parseEnv(String(text ?? ''));
}

// Prüft die Zieladresse. @returns {{ url: URL|null, fehler: string|null }}
export function pruefeZielUrl(roh) {
  const wert = String(roh ?? '').trim();
  if (!wert) return { url: null, fehler: 'DURCHLAUF_ZIEL_URL fehlt. Trage die Adresse der Testinstanz ein (z. B. https://test-portal.example.org).' };
  let url;
  try {
    url = new URL(wert);
  } catch {
    return { url: null, fehler: `DURCHLAUF_ZIEL_URL ist keine gültige Adresse: ${wert}` };
  }
  if (url.username || url.password) return { url: null, fehler: 'DURCHLAUF_ZIEL_URL darf keine Zugangsdaten enthalten.' };
  if (url.protocol === 'http:' && !LOKALE_HOSTS.has(url.hostname)) {
    return { url: null, fehler: 'DURCHLAUF_ZIEL_URL muss mit https:// beginnen (http:// nur für localhost).' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { url: null, fehler: 'DURCHLAUF_ZIEL_URL muss mit https:// beginnen.' };
  }
  return { url: new URL(url.origin), fehler: null };
}

// Ganze Zahl aus der Konfiguration mit Standardwert und Grenzen; Fehlertext oder Zahl.
function ganzzahl(werte, name, standard, min, max, fehler) {
  const roh = werte[name];
  if (roh === undefined || String(roh).trim() === '') return standard;
  const s = String(roh).trim();
  const zahl = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(zahl) || zahl < min || zahl > max) {
    fehler.push(`${name} muss eine ganze Zahl von ${min} bis ${max} sein (ist: ${s}).`);
    return standard;
  }
  return zahl;
}

function text(werte, name) {
  const roh = werte[name];
  if (roh === undefined) return null;
  const s = String(roh).trim();
  return s === '' ? null : s;
}

// Liest und prüft alle Einstellungen. `werte` ist das Ergebnis von parseKonfigText.
// `optionen.nurPortal`: ohne Warten auf n8n (dann ist kein API-Schlüssel nötig).
// @returns {{ konfig: object, fehler: string[] }}
export function leseKonfiguration(werte = {}, { nurPortal = false } = {}) {
  const fehler = [];
  const ziel = pruefeZielUrl(werte.DURCHLAUF_ZIEL_URL);
  if (ziel.fehler) fehler.push(ziel.fehler);

  const konto = text(werte, 'DURCHLAUF_KONTO');
  if (!konto) fehler.push('DURCHLAUF_KONTO fehlt (Kontonummer des Testkontos, z. B. 9999).');

  const ende = text(werte, 'DURCHLAUF_ENDE') ?? 'abgeholt';
  if (!ENDE_WERTE.includes(ende)) fehler.push(`DURCHLAUF_ENDE muss «abgeholt» oder «archiv_bestaetigt» sein (ist: ${ende}).`);

  const apiKey = text(werte, 'DURCHLAUF_N8N_API_KEY');
  if (ende === 'archiv_bestaetigt' && !apiKey && !nurPortal) {
    fehler.push('DURCHLAUF_ENDE=archiv_bestaetigt braucht DURCHLAUF_N8N_API_KEY (Archivquittungen sind in der Oberfläche nicht sichtbar).');
  }

  const auffaelligkeiten = text(werte, 'DURCHLAUF_AUFFAELLIGKEITEN') ?? 'bestaetigen';
  if (!AUFFAELLIGKEITEN_WERTE.includes(auffaelligkeiten)) {
    fehler.push(`DURCHLAUF_AUFFAELLIGKEITEN muss «bestaetigen» oder «abbrechen» sein (ist: ${auffaelligkeiten}).`);
  }

  const betrag = text(werte, 'DURCHLAUF_BETRAG');
  if (betrag && !/^\d+([.,]\d{1,2})?$/.test(betrag)) fehler.push(`DURCHLAUF_BETRAG muss ein Betrag wie 123.45 sein (ist: ${betrag}).`);

  const ibanEndung = text(werte, 'DURCHLAUF_IBAN_ENDUNG');
  if (ibanEndung && !/^[0-9A-Za-z]{4}$/.test(ibanEndung)) fehler.push('DURCHLAUF_IBAN_ENDUNG muss genau 4 Zeichen lang sein (letzte 4 Zeichen der IBAN).');

  const praefix = text(werte, 'DURCHLAUF_RECHNUNGSNUMMER_PRAEFIX') ?? 'DT';
  if (!/^[0-9A-Za-z_-]{1,20}$/.test(praefix)) fehler.push('DURCHLAUF_RECHNUNGSNUMMER_PRAEFIX: nur Buchstaben, Ziffern, - und _ (höchstens 20 Zeichen).');

  const konfig = {
    zielUrl: ziel.url,
    konto,
    anzahl: ganzzahl(werte, 'DURCHLAUF_ANZAHL', 1, 1, 20, fehler),
    ende,
    n8nApiKey: apiKey,
    zeitlimitEingangMs: ganzzahl(werte, 'DURCHLAUF_ZEITLIMIT_EINGANG_MIN', 15, 1, 240, fehler) * 60_000,
    zeitlimitSchrittMs: ganzzahl(werte, 'DURCHLAUF_ZEITLIMIT_SCHRITT_S', 120, 10, 1800, fehler) * 1000,
    zeitlimitExportMs: ganzzahl(werte, 'DURCHLAUF_ZEITLIMIT_EXPORT_MIN', 30, 1, 1440, fehler) * 60_000,
    abfrageMs: ganzzahl(werte, 'DURCHLAUF_ABFRAGE_S', 20, 5, 600, fehler) * 1000,
    lieferant: text(werte, 'DURCHLAUF_LIEFERANT'),
    betrag: betrag ? betrag.replace(',', '.') : null,
    ibanEndung: ibanEndung ? ibanEndung.toUpperCase() : null,
    zahlungszielTage: ganzzahl(werte, 'DURCHLAUF_ZAHLUNGSZIEL_TAGE', 30, 0, 365, fehler),
    absender: text(werte, 'DURCHLAUF_ABSENDER') ?? 'durchlauf-test@example.invalid',
    rechnungsnummerPraefix: praefix,
    auffaelligkeiten,
    ordner: text(werte, 'DURCHLAUF_ORDNER') ?? STANDARD_ORDNER,
  };
  return { konfig, fehler };
}

// Liest die Befehlszeile. @returns {{ ja, nurPortal, sichtbar, konfigDatei, person, fehler }}
export function leseArgumente(argv = []) {
  const ergebnis = { ja: false, nurPortal: false, sichtbar: false, konfigDatei: STANDARD_KONFIGDATEI, person: null, fehler: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--ja') ergebnis.ja = true;
    else if (a === '--nur-portal') ergebnis.nurPortal = true;
    else if (a === '--sichtbar') ergebnis.sichtbar = true;
    else if (a === '--konfig') {
      const datei = argv[i + 1];
      if (!datei || datei.startsWith('--')) ergebnis.fehler.push('--konfig braucht einen Dateinamen.');
      else { ergebnis.konfigDatei = datei; i += 1; }
    } else if (/^[ab]$/i.test(a) && !ergebnis.person) ergebnis.person = a.toLowerCase();
    else ergebnis.fehler.push(`Unbekannte Angabe: ${a}`);
  }
  return ergebnis;
}

// Zahlungsziel als JJJJ-MM-TT, `tage` nach `jetzt` (Zürcher Kalendertag ist hier unerheblich: es ist ein Testwert).
export function zahlungszielAb(jetzt, tage) {
  const d = new Date(jetzt.getTime() + tage * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// Eindeutige Rechnungsnummer je Lauf und Beleg, damit wiederholte Läufe keine Dubletten-Auffälligkeit auslösen.
export function testRechnungsnummer(praefix, jetzt, jobId) {
  const stempel = jetzt.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `${praefix}-${stempel}-${jobId}`;
}
