import { randomBytes, randomUUID } from 'node:crypto';
import { currentAuditRequestId } from './auditContext.js';

// Nutzungsdaten und Fehler (Betrieb & Nutzung). Grundsätze:
// - Erfassen darf nie eine Anfrage scheitern lassen: Fehler werden gefangen und höchstens einmal
//   pro Stunde gemeldet.
// - Gespeichert werden nie Body, Query oder Header ausser dem User-Agent.

export const GERAET_COOKIE = 'fp_geraet';
const GERAET_COOKIE_MAX_AGE = 2 * 365 * 24 * 60 * 60 * 1000;
const GERAET_ID_MUSTER = /^[0-9a-f]{32}$/;
const UA_MAX = 500;
const MELDUNG_MAX = 1000;
const STACK_MAX = 8000;
const MELDE_ABSTAND_MS = 60 * 60 * 1000;

let letzteMeldungAm = 0;

// Höchstens eine Meldung pro Stunde, ohne Anfragedaten.
function meldeErfassungsfehler(err) {
  const jetzt = Date.now();
  if (jetzt - letzteMeldungAm < MELDE_ABSTAND_MS) return;
  letzteMeldungAm = jetzt;
  console.error(`Nutzungsdaten konnten nicht erfasst werden (${typeof err?.code === 'string' ? err.code : err?.message || 'FEHLER'}).`);
}

const BROWSER_REGELN = [
  ['Samsung Internet', /SamsungBrowser\/(\d+)/],
  ['Edge', /(?:Edg|EdgA|EdgiOS)\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
];

function erkenneBrowser(ua) {
  for (const [name, muster] of BROWSER_REGELN) {
    const treffer = ua.match(muster);
    if (treffer) return `${name} ${treffer[1]}`;
  }
  return 'Andere';
}

function erkenneBetriebssystem(ua) {
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return 'Andere';
}

export function geraetAusUserAgent(ua) {
  const text = typeof ua === 'string' ? ua : '';
  const betriebssystem = erkenneBetriebssystem(text);
  let geraetTyp = 'unbekannt';
  if (betriebssystem === 'iPadOS' || (betriebssystem === 'Android' && !/Mobile/.test(text))) geraetTyp = 'tablet';
  else if (betriebssystem === 'iOS' || betriebssystem === 'Android') geraetTyp = 'handy';
  else if (['Windows', 'macOS', 'Linux'].includes(betriebssystem)) geraetTyp = 'desktop';
  return { geraetTyp, browser: erkenneBrowser(text), betriebssystem };
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function normalisierePfad(pfad) {
  return String(pfad).split('/').map((teil) => (ID_SEGMENT.test(teil) ? ':id' : teil)).join('/');
}

// Liest die Geräte-ID aus dem Cookie; fehlt sie oder ist sie ungültig, wird eine neue gesetzt.
// Secure wie die Session-Cookies.
export function geraeteIdAusCookie(req, res) {
  const vorhanden = req.cookies?.[GERAET_COOKIE];
  if (typeof vorhanden === 'string' && GERAET_ID_MUSTER.test(vorhanden)) return vorhanden;
  const neu = randomBytes(16).toString('hex');
  res.cookie(GERAET_COOKIE, neu, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.session?.cookie?.secure === true,
    maxAge: GERAET_COOKIE_MAX_AGE,
  });
  return neu;
}

function gueltigeGeraeteId(req) {
  const wert = req.nutzung?.geraetId ?? req.cookies?.[GERAET_COOKIE];
  return typeof wert === 'string' && GERAET_ID_MUSTER.test(wert) ? wert : null;
}

function userAgent(req) {
  const ua = req.headers?.['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, UA_MAX) : '';
}

function pfadOhneQuery(req) {
  return String(req.originalUrl ?? req.url ?? '').split('?')[0];
}

// req.nutzung wird von der Middleware beim Eintritt gesetzt (Pfad, Person, Gerät, Request-ID),
// weil sich req.url in eingehängten Routern ändert und 'finish' ausserhalb des Kontexts läuft.
export function erfasseSeitenaufruf(db, { req, res, dauerMs }) {
  try {
    const kontext = req.nutzung || {};
    const personId = kontext.personId ?? req.currentPerson?.churchtools_person_id;
    if (!personId) return;
    const pfad = kontext.pfad ?? req.path;
    const ua = userAgent(req);
    const { geraetTyp, browser, betriebssystem } = geraetAusUserAgent(ua);
    const geraetId = gueltigeGeraeteId(req);
    const jetzt = new Date().toISOString();
    db.prepare(`INSERT INTO nutzung_seitenaufrufe
      (zeitpunkt, person_id, methode, pfad, pfad_muster, status, dauer_ms, geraet_id, geraet_typ, browser, betriebssystem, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jetzt, String(personId), String(req.method || '').slice(0, 10), pfad, normalisierePfad(pfad), res.statusCode,
      Math.max(0, Math.round(dauerMs)), geraetId, geraetTyp, browser, betriebssystem, kontext.requestId ?? currentAuditRequestId(),
    );
    if (geraetId) {
      db.prepare(`INSERT INTO nutzung_geraete
        (geraet_id, person_id, erstmals_am, zuletzt_am, user_agent, geraet_typ, browser, betriebssystem)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(geraet_id, person_id) DO UPDATE SET zuletzt_am = excluded.zuletzt_am,
          user_agent = excluded.user_agent, geraet_typ = excluded.geraet_typ,
          browser = excluded.browser, betriebssystem = excluded.betriebssystem`).run(
        geraetId, String(personId), jetzt, jetzt, ua, geraetTyp, browser, betriebssystem,
      );
    }
  } catch (err) {
    meldeErfassungsfehler(err);
  }
}

// Body-Parser-Fehler (err.type 'entity.*') enthalten in Meldung und erster Stack-Zeile Auszüge
// des Anfrage-Inhalts: dann nur eine allgemeine Meldung und der Stack ohne erste Zeile.
function meldungUndStack(err) {
  const stack = String(err?.stack ?? '');
  if (typeof err?.type === 'string' && err.type.startsWith('entity.')) {
    const ohneErsteZeile = stack.split('\n').slice(1).join('\n');
    return [`Ungültiger Anfrage-Inhalt (${err.type.slice(0, 50)})`, ohneErsteZeile.slice(0, STACK_MAX) || null];
  }
  return [String(err?.message ?? err ?? '').slice(0, MELDUNG_MAX), stack.slice(0, STACK_MAX) || null];
}

// Speichert einen Serverfehler und gibt die Request-ID (= Fehler-ID) zurück; wirft nie.
export function erfasseFehler(db, { req, err, status }) {
  let requestId = null;
  try {
    // Body-Parser-Fehler entstehen ausserhalb des Request-Kontexts: dann gilt der Header.
    requestId = currentAuditRequestId() || req?.res?.getHeader?.('X-Request-ID') || randomUUID();
    db.prepare(`INSERT OR IGNORE INTO betrieb_fehler
      (request_id, zeitpunkt, person_id, methode, pfad, status, meldung, stack, user_agent, geraet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(requestId), new Date().toISOString(), req.currentPerson?.churchtools_person_id ?? null,
      String(req.method || '').slice(0, 10), pfadOhneQuery(req), status,
      ...meldungUndStack(err),
      userAgent(req) || null, gueltigeGeraeteId(req),
    );
  } catch (fehler) {
    meldeErfassungsfehler(fehler);
  }
  return String(requestId || randomUUID());
}
