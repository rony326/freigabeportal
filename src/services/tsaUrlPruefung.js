// Prüfung der Adresse des Zeitstempeldienstes (TSA): nur https, keine privaten, Loopback- oder Link-Local-Ziele.
// Schutz davor, dass das Portal auf Antrag eines Admin-Formulars interne Dienste anspricht (SSRF, z. B. Cloud-Metadaten
// unter 169.254.169.254). Geprüft wird beim Speichern (Admin → Zeitstempel) und für die schon gespeicherte Adresse beim Start
// und beim Öffnen der Seite (nur Warnung, siehe docs/zeitstempel-und-pruefbescheinigung.md).
//
// Die Prüfung greift bewusst NICHT bei jedem Zeitstempel: Sie wäre durch DNS-Rebinding ohnehin umgehbar (die Antwort kann
// zwischen Prüfung und Verbindung wechseln), und ein Ausfall der Zeitstempel ist für die Revisionssicherheit schlimmer
// als das Restrisiko, weil nur Superadmins die Adresse ändern dürfen.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { getConfigValue } from '../db/adminConfigRepo.js';

const AUFLOESEN_TIMEOUT_MS = 5000;

// Wandelt eine IPv4-Adresse (Punktschreibweise) in vier Zahlen um.
function v4Teile(ip) {
  return ip.split('.').map(Number);
}

// @returns {boolean} true, wenn die IPv4-Adresse öffentlich erreichbar sein kann (nicht privat/reserviert)
function v4Oeffentlich([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false; // "dieses Netz", privat, Loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // Carrier-Grade-NAT
  if (a === 169 && b === 254) return false; // Link-Local (Cloud-Metadaten)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false; // IETF-Protokollzuweisungen
  if (a === 198 && (b === 18 || b === 19)) return false; // Benchmark-Netz
  if (a >= 224) return false; // Multicast, reserviert, Broadcast
  return true;
}

// Wandelt eine IPv6-Adresse in 16 Bytes um (unterstützt "::", eingebettete IPv4 am Ende und Zonenkennung).
function v6Bytes(text) {
  let s = text.split('%')[0].toLowerCase();
  const punkt = s.lastIndexOf('.');
  if (punkt === -1) return gruppenZuBytes(expandiere(s));
  const doppelpunkt = s.lastIndexOf(':');
  const v4 = v4Teile(s.slice(doppelpunkt + 1));
  s = `${s.slice(0, doppelpunkt + 1)}0:0`;
  const gruppen = expandiere(s);
  gruppen[6] = (v4[0] << 8) | v4[1];
  gruppen[7] = (v4[2] << 8) | v4[3];
  return gruppenZuBytes(gruppen);
}

// Teilt "a:b::c" in genau acht 16-Bit-Gruppen.
function expandiere(s) {
  const [kopf, schwanz, zuviel] = s.split('::');
  if (zuviel !== undefined) throw new Error('ungültige IPv6-Adresse');
  const k = kopf ? kopf.split(':') : [];
  const t = schwanz !== undefined && schwanz ? schwanz.split(':') : [];
  const fehlend = 8 - k.length - t.length;
  if (schwanz === undefined ? k.length !== 8 : fehlend < 0) throw new Error('ungültige IPv6-Adresse');
  return [...k, ...Array(schwanz === undefined ? 0 : fehlend).fill('0'), ...t].map((g) => parseInt(g, 16));
}

function gruppenZuBytes(gruppen) {
  return gruppen.flatMap((g) => [g >> 8, g & 255]);
}

// @returns {boolean} true, wenn die IPv6-Adresse öffentlich erreichbar sein kann
function v6Oeffentlich(b) {
  const nullen = (von, bis) => b.slice(von, bis).every((x) => x === 0);
  if (nullen(0, 10) && b[10] === 255 && b[11] === 255) return v4Oeffentlich(b.slice(12)); // ::ffff:a.b.c.d (gemappte IPv4)
  if (nullen(0, 12)) return false; // ::, ::1 und die veraltete IPv4-kompatible Form ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && nullen(4, 12)) return v4Oeffentlich(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4Oeffentlich(b.slice(2, 6)); // 6to4: eingebettete IPv4
  if ((b[0] & 0xfe) === 0xfc) return false; // fc00::/7 (unique local)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // fe80::/10 (link-local)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return false; // fec0::/10 (veraltet, site-local)
  if (b[0] === 0xff) return false; // ff00::/8 (multicast)
  return true;
}

/**
 * @param {string} ip IPv4- oder IPv6-Adresse in Textform
 * @returns {boolean} true, wenn die Adresse im öffentlichen Internet liegen kann; ungültige Adressen gelten als nicht öffentlich
 */
export function istOeffentlicheIp(ip) {
  const art = isIP(ip.split('%')[0]);
  try {
    if (art === 4) return v4Oeffentlich(v4Teile(ip));
    if (art === 6) return v6Oeffentlich(v6Bytes(ip));
  } catch {
    return false;
  }
  return false;
}

// Standard-Auflösung über das Betriebssystem: alle Adressen (IPv4 und IPv6), mit Zeitlimit.
async function aufloesenStandard(hostname) {
  const antwort = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Zeitüberschreitung')), AUFLOESEN_TIMEOUT_MS).unref()),
  ]);
  return antwort.map((eintrag) => eintrag.address);
}

/**
 * Prüft eine TSA-Adresse: https, kein privates/Loopback-/Link-Local-Ziel. Hostnamen werden aufgelöst, jede Adresse zählt.
 * @param {string} url
 * @param {{aufloesen?: (hostname: string) => Promise<string[]>}} [opt] `aufloesen` ersetzt die DNS-Auflösung (Tests)
 * @returns {Promise<{ok: true}|{ok: false, grund: string}>}
 */
export async function pruefeTsaUrl(url, { aufloesen = aufloesenStandard } = {}) {
  let ziel;
  try {
    ziel = new URL(url);
  } catch {
    return { ok: false, grund: 'Die Adresse ist keine gültige Internetadresse.' };
  }
  if (ziel.protocol !== 'https:') return { ok: false, grund: 'Die Adresse muss mit https:// beginnen.' };
  // Die URL-Normalisierung wandelt dezimale/hexadezimale/oktale IPv4-Schreibweisen in Punktschreibweise um; IPv6 steht in eckigen Klammern.
  const host = ziel.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, grund: 'Die Adresse enthält keinen Servernamen.' };
  if (isIP(host)) {
    return istOeffentlicheIp(host) ? { ok: true } : { ok: false, grund: 'Die Adresse zeigt auf ein privates, internes oder lokales Ziel.' };
  }
  let adressen;
  try {
    adressen = await aufloesen(host);
  } catch {
    return { ok: false, grund: 'Der Servername konnte nicht aufgelöst werden.' };
  }
  if (!adressen || adressen.length === 0) return { ok: false, grund: 'Der Servername konnte nicht aufgelöst werden.' };
  if (!adressen.every(istOeffentlicheIp)) return { ok: false, grund: 'Der Servername zeigt auf ein privates, internes oder lokales Ziel.' };
  return { ok: true };
}

/**
 * Prüft die gespeicherte TSA-Adresse (nur zur Warnung, sie wird weiter benutzt).
 * @returns {Promise<null|{url: string, ok: boolean, grund?: string}>} null, wenn keine Adresse gespeichert ist
 */
export async function pruefeGespeicherteTsaUrl(db, opt = {}) {
  const url = String(getConfigValue(db, 'zeitstempel_tsa_url') ?? '').trim();
  if (!url) return null;
  return { url, ...(await pruefeTsaUrl(url, opt)) };
}
