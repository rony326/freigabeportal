#!/usr/bin/env node
// Aussen-Pruefskript fuer das Live-Portal (autorisierte Sicherheitspruefung durch den Betreiber).
// Ziel ausschliesslich ueber die Umgebungsvariable PRUEF_ZIEL_URL; keine Adresse im Repo.
// Nur GET/HEAD plus einige absichtlich ungueltige POSTs, die abgelehnt werden MUESSEN.
// Harte Grenzen: im Mittel <= 2 Anfragen/s, Stoss <= 20 Anfragen, insgesamt <= 5000.
// Ausgabe: JSON-Zeilen ohne Geheimnisse (keine Cookie-Werte, keine Adresse).
import tls from 'node:tls';

const ZIEL = process.env.PRUEF_ZIEL_URL;
if (!ZIEL || !/^https:\/\//.test(ZIEL)) {
  console.error('PRUEF_ZIEL_URL (https://...) muss gesetzt sein.');
  process.exit(2);
}
const BASIS = new URL(ZIEL);
const HOST = BASIS.hostname;

const MAX_GESAMT = 5000;
const MAX_STOSS = 20;
const MIN_ABSTAND_MS = 550; // < 2 Anfragen/s im Mittel und im Stoss
let gesamt = 0;
let letzte = 0;
const stossFenster = []; // Zeitstempel der letzten Anfragen
const ergebnisse = [];
const unerwarteteSchreibzugriffe = [];

function abbruch(grund) {
  console.error(`ABBRUCH: ${grund}`);
  console.log(JSON.stringify({ zusammenfassung: { anfragen: gesamt, abgebrochen: grund } }));
  process.exit(3);
}
async function zaehle() {
  if (gesamt >= MAX_GESAMT) abbruch('Gesamtbudget erreicht');
  const warte = letzte + MIN_ABSTAND_MS - Date.now();
  if (warte > 0) await new Promise((r) => setTimeout(r, warte));
  const jetzt = Date.now();
  stossFenster.push(jetzt);
  while (stossFenster.length && jetzt - stossFenster[0] > 10_000) stossFenster.shift();
  if (stossFenster.length > MAX_STOSS) abbruch('Stossgrenze ueberschritten');
  if (stossFenster.length > 1 && (jetzt - stossFenster[0]) / (stossFenster.length - 1) < 450 && stossFenster.length > 5) {
    abbruch('Rate > 2/s');
  }
  letzte = jetzt;
  gesamt += 1;
}

async function anfrage(methode, pfad, { headers = {}, body, redirect = 'manual' } = {}) {
  await zaehle();
  const url = new URL(BASIS.origin + pfad); // Pfad immer relativ zum Ziel (auch bei '//...')
  if (url.hostname !== HOST) abbruch('Fremdes Ziel');
  if (body && Buffer.byteLength(body) > 1_000_000) abbruch('Body > 1 MB');
  try {
    const res = await fetch(url, { method: methode, headers: { 'user-agent': 'abschlusspruefung-aussen/1', ...headers }, body, redirect, signal: AbortSignal.timeout(15_000) });
    const text = methode === 'HEAD' ? '' : (await res.text()).slice(0, 200_000);
    return { status: res.status, headers: res.headers, text, setCookie: res.headers.getSetCookie?.() ?? [] };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: '', setCookie: [], fehler: String(err.cause?.code || err.code || err.name) };
  }
}

function befund(id, ok, detail, extra = {}) {
  const e = { id, ok, detail, ...extra };
  ergebnisse.push(e);
  console.log(JSON.stringify(e));
}
const ortOhneQuery = (loc) => {
  if (!loc) return null;
  try { const u = new URL(loc, BASIS); return `${u.hostname === HOST ? '' : '<fremd>'}${u.pathname}`; } catch { return '<unlesbar>'; }
};
const LECK = [/\bat\s+\S+\s+\(.*:\d+:\d+\)/, /node_modules/, /\/config\//, /\/home\//, /\/app\/src/, /SQLITE_/i, /Error:\s/, /\.js:\d+/];
const leckt = (text) => LECK.find((r) => r.test(text))?.toString() ?? null;

// ---- 1. TLS und Weiterleitung -------------------------------------------------------------
function tlsProbe(opts) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: HOST, port: 443, servername: HOST, rejectUnauthorized: false, timeout: 10_000, ...opts }, () => {
      const cert = s.getPeerCertificate();
      const r = {
        verbunden: true, protokoll: s.getProtocol(), autorisiert: s.authorized, fehlergrund: s.authorizationError || null,
        tageBisAblauf: cert?.valid_to ? Math.floor((new Date(cert.valid_to) - Date.now()) / 86_400_000) : null,
        schluessel: cert?.bits ?? null,
      };
      s.end(); resolve(r);
    });
    s.on('error', (e) => resolve({ verbunden: false, fehler: e.code || e.message }));
    s.on('timeout', () => { s.destroy(); resolve({ verbunden: false, fehler: 'timeout' }); });
  });
}
async function pruefeTls() {
  await zaehle();
  const t = await tlsProbe({});
  befund('tls-aktuell', t.verbunden && t.autorisiert && ['TLSv1.2', 'TLSv1.3'].includes(t.protokoll), 'Zertifikat vertrauenswuerdig, TLS>=1.2', t);
  befund('tls-ablauf', t.tageBisAblauf !== null && t.tageBisAblauf > 14, `Zertifikat laeuft in ${t.tageBisAblauf} Tagen ab`);
  await zaehle();
  const alt = await tlsProbe({ minVersion: 'TLSv1', maxVersion: 'TLSv1.1' });
  befund('tls-alt-abgelehnt', !alt.verbunden, 'TLS 1.0/1.1 abgelehnt (lokale Node-Version kann den Test unschluessig machen)', alt);
  await zaehle();
  try {
    const r = await fetch(`http://${HOST}/`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const loc = r.headers.get('location') || '';
    befund('http-weiterleitung', [301, 302, 307, 308].includes(r.status) && loc.startsWith('https://'), `http -> https (Status ${r.status})`, { status: r.status });
  } catch (e) {
    befund('http-weiterleitung', true, 'Port 80 nicht erreichbar (kein Klartext)', { fehler: String(e.cause?.code || e.name) });
  }
}

// ---- 2. Header, Cookies ---------------------------------------------------------------------
async function pruefeHeader() {
  const r = await anfrage('GET', '/auth/abgemeldet');
  const h = r.headers;
  const hsts = h.get('strict-transport-security');
  befund('hdr-hsts', !!hsts && /max-age=(\d+)/.test(hsts) && Number(hsts.match(/max-age=(\d+)/)[1]) >= 15_552_000, 'HSTS mit max-age >= 180 Tage', { wert: hsts });
  const csp = h.get('content-security-policy') || '';
  befund('hdr-csp', /default-src/.test(csp) && /object-src 'none'/.test(csp) && /frame-ancestors/.test(csp), 'CSP mit default-src/object-src/frame-ancestors', { unsafeInline: /unsafe-inline/.test(csp) });
  befund('hdr-referrer', /no-referrer|same-origin|strict-origin/.test(h.get('referrer-policy') || ''), 'Referrer-Policy', { wert: h.get('referrer-policy') });
  befund('hdr-nosniff', (h.get('x-content-type-options') || '').toLowerCase() === 'nosniff', 'X-Content-Type-Options: nosniff');
  befund('hdr-frame', /frame-ancestors/.test(csp) || !!h.get('x-frame-options'), 'Frame-Schutz', { xfo: h.get('x-frame-options') });
  befund('hdr-permissions', !!h.get('permissions-policy'), 'Permissions-Policy gesetzt', { wert: h.get('permissions-policy') });
  befund('hdr-x-powered-by', !h.get('x-powered-by'), 'Kein X-Powered-By', { wert: h.get('x-powered-by') });
  befund('hdr-server', !/\d+\.\d+/.test(h.get('server') || ''), 'Server-Header ohne Version', { wert: h.get('server') });
  befund('hdr-coop-corp', !!h.get('cross-origin-opener-policy') || !!h.get('cross-origin-resource-policy'), 'COOP/CORP (hinweis)', {});

  const c = await anfrage('GET', '/auth/login');
  befund('login-leitet-weiter', [302, 303].includes(c.status), 'GET /auth/login leitet zum Anmeldedienst', { status: c.status, ziel: ortOhneQuery(c.headers.get('location')) });
  if (!c.setCookie.length) befund('cookie-vorhanden', true, 'Kein Cookie bei /auth/login gesetzt (hinweis)', {});
  for (const sc of c.setCookie) {
    const name = sc.split('=')[0];
    befund(`cookie-${name}`, /;\s*secure/i.test(sc) && /;\s*httponly/i.test(sc) && /;\s*samesite=(lax|strict)/i.test(sc), 'Secure; HttpOnly; SameSite', {
      secure: /;\s*secure/i.test(sc), httpOnly: /;\s*httponly/i.test(sc), sameSite: (sc.match(/samesite=(\w+)/i) || [])[1] || null, maxAge: (sc.match(/max-age=(\d+)|expires=([^;]+)/i) || [])[0] || null,
    });
  }
  const hs = await anfrage('GET', '/', { headers: { origin: 'https://fremd.example' } });
  befund('cors-fremd', !hs.headers.get('access-control-allow-origin'), 'Kein CORS fuer fremden Origin', { acao: hs.headers.get('access-control-allow-origin') });
}

// ---- 3. Pfade ohne Anmeldung ----------------------------------------------------------------
async function pruefePfade() {
  const geschuetzt = ['/pool', '/meine-spesen', '/meine-abgeschlossenen', '/kontierung', '/spesen', '/freigabe2', '/abgelehnt', '/kreditkarte',
    '/zeitstempel-pruefen', '/kommentare', '/meine-benachrichtigungen', '/fehler-melden', '/datenschutz', '/banner', '/ferienmodus',
    '/admin', '/admin/personen', '/admin/audit-log', '/admin/backup', '/admin/mails', '/admin/vorgaenge', '/api/pool', '/downloads/1/oeffnen', '/downloads/1/refresh-url', '/downloads/1/thumbnail'];
  for (const p of geschuetzt) {
    const r = await anfrage('GET', p, { headers: { accept: 'text/html' } });
    const ziel = ortOhneQuery(r.headers.get('location'));
    const ok = [301, 302, 303, 307, 401, 403].includes(r.status) && (r.status >= 400 || /login|auth/.test(ziel || ''));
    befund(`pfad-geschuetzt:${p}`, ok, 'ohne Anmeldung nicht erreichbar', { status: r.status, ziel, bytes: r.text.length });
  }
  const oeffentlich = ['/healthz', '/auth/abgemeldet', '/audit-pruefen', '/branding/logo', '/robots.txt', '/favicon.ico'];
  for (const p of oeffentlich) {
    const r = await anfrage('GET', p);
    befund(`pfad-oeffentlich:${p}`, true, 'Erreichbarkeit ohne Anmeldung (Information)', { status: r.status, typ: r.headers.get('content-type') });
  }
  const sensibel = ['/.env', '/.git/config', '/.git/HEAD', '/package.json', '/package-lock.json', '/src/app.js', '/node_modules/express/package.json', '/data/', '/db.sqlite', '/uploads/', '/docs/', '/README.md', '/.DS_Store', '/css/', '/js/', '/vendor/', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/css/..%2f..%2fpackage.json'];
  for (const p of sensibel) {
    const r = await anfrage('GET', p);
    const gefaehrlich = r.status === 200 && (/root:|"dependencies"|DB_|SECRET|\[core\]|ref: refs/.test(r.text) || /<title>Index of/i.test(r.text));
    befund(`pfad-sensibel:${p}`, !gefaehrlich, 'keine Dateien/Verzeichnislisten', { status: r.status, typ: r.headers.get('content-type') });
  }
}

// ---- 4. Fehlerseiten ------------------------------------------------------------------------
async function pruefeFehler() {
  const faelle = [
    ['404', 'GET', '/gibt-es-nicht-pruefung'],
    ['url-kaputt', 'GET', '/%zz'],
    ['null-byte', 'GET', '/%00'],
    ['lang-url', 'GET', '/' + 'a'.repeat(9000)],
    ['audit-id-text', 'GET', '/audit-pruefen?paket=abc&pruefnummer=xyz'],
    ['audit-sql', 'GET', "/audit-pruefen?paket=1'%20OR%201=1--&pruefnummer=" + '0'.repeat(64)],
    ['audit-array', 'GET', '/audit-pruefen?paket[]=1&pruefnummer[a]=2'],
    ['download-id', 'GET', "/downloads/1'%20OR%20'1'='1"],
    ['download-id-neg', 'GET', '/downloads/-1?sig=x&exp=1'],
    ['download-traversal', 'GET', '/downloads/..%2f..%2fetc%2fpasswd'],
    ['query-proto', 'GET', '/audit-pruefen?__proto__[x]=1&constructor[prototype][y]=1'],
  ];
  for (const [name, m, p] of faelle) {
    const r = await anfrage(m, p);
    const l = leckt(r.text);
    befund(`fehler:${name}`, !l && r.status !== 500, 'keine internen Details, kein 500', { status: r.status, leck: l });
  }
  const r = await anfrage('POST', '/api/n8n/jobs', { headers: { 'content-type': 'application/json' }, body: '{kaputt' });
  befund('fehler:json-kaputt', !leckt(r.text) && r.status < 500, 'kaputtes JSON ohne Details', { status: r.status, leck: leckt(r.text) });
  const a1 = await anfrage('GET', '/audit-pruefen?paket=1&pruefnummer=' + '0'.repeat(64));
  const a2 = await anfrage('GET', '/audit-pruefen?paket=999999&pruefnummer=' + '0'.repeat(64));
  const norm = (t) => t.replace(/\d{2}\.\d{2}\.\d{4}[^<]*/g, '').replace(/\s+/g, ' ');
  befund('audit-kein-orakel', a1.status === a2.status && norm(a1.text) === norm(a2.text), 'Falsche Pruefnummer: bestehende/unbekannte Paketnummer nicht unterscheidbar', { status1: a1.status, status2: a2.status });
}

// ---- 5. Healthz, Maschinenschluessel ---------------------------------------------------------
async function pruefeMaschinen() {
  const hz = await anfrage('GET', '/healthz');
  let j = null; try { j = JSON.parse(hz.text); } catch { /* */ }
  befund('healthz-ohne-schluessel', !!j && Object.keys(j).every((k) => k === 'status'), 'nur {status}, keine Dienste/Version', { status: hz.status, schluessel: j ? Object.keys(j) : null });
  const hz2 = await anfrage('GET', '/healthz', { headers: { 'x-monitoring-key': 'falscher-schluessel-pruefung' } });
  let j2 = null; try { j2 = JSON.parse(hz2.text); } catch { /* */ }
  befund('healthz-falscher-schluessel', !!j2 && Object.keys(j2).every((k) => k === 'status'), 'falscher Schluessel liefert keine Details', { status: hz2.status });

  const n8n = [['GET', '/api/n8n/jobs'], ['POST', '/api/n8n/jobs'], ['GET', '/api/n8n/backup'], ['POST', '/api/n8n/backup'], ['POST', '/api/n8n/kk-belege'], ['GET', '/api/n8n/kk-belege']];
  for (const [m, p] of n8n) {
    for (const [variante, headers, pfad] of [['ohne', {}, p], ['falsch', { 'x-api-key': 'falscher-schluessel-pruefung' }, p], ['query', {}, p + '?api_key=falscher-schluessel-pruefung']]) {
      const r = await anfrage(m, pfad, { headers: { ...headers, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
      const ok = r.status === 401 || r.status === 403 || r.status === 404;
      if ([200, 201, 202].includes(r.status)) unerwarteteSchreibzugriffe.push(`${m} ${p} (${variante}) -> ${r.status}`);
      befund(`n8n:${m}:${p}:${variante}`, ok, 'Maschinenschluessel erforderlich', { status: r.status });
      if ([200, 201, 202].includes(r.status)) abbruch(`Maschinen-Endpunkt ${m} ${p} ohne gueltigen Schluessel erfolgreich`);
    }
  }
  const crons = ['sync-personen', 'pool-erinnerungen', 'freigabe2-erinnerungen', 'pdf-bereinigung', 'tsa-crl-aktualisierung', 'zeitstempel-nachholen', 'split-gruppen-nachholen', 'kk-beleg-erinnerungen', 'mail-zustellung'];
  for (const c of crons) {
    for (const [variante, headers] of [['ohne', {}], ['falsch', { 'x-cron-secret': 'falscher-schluessel-pruefung' }]]) {
      const r = await anfrage('POST', `/internal/cron/${c}`, { headers });
      if ([200, 201, 202, 204].includes(r.status)) { unerwarteteSchreibzugriffe.push(`POST /internal/cron/${c} (${variante}) -> ${r.status}`); befund(`cron:${c}:${variante}`, false, 'UNERWARTET ERFOLGREICH', { status: r.status }); abbruch('Cron-Endpunkt ohne Schluessel erfolgreich'); }
      befund(`cron:${c}:${variante}`, [401, 403, 404].includes(r.status), 'Cron-Schluessel erforderlich', { status: r.status });
    }
  }
  const g = await anfrage('GET', '/internal/cron/sync-personen');
  befund('cron:GET', [401, 403, 404].includes(g.status), 'GET auf Cron-Pfad nicht ausfuehrbar', { status: g.status });
}

// ---- 6. Offene Weiterleitung, Header-Manipulation, CSRF ---------------------------------------
async function pruefeManipulation() {
  const fremd = 'fremd.example';
  const pfade = ['/auth/login?returnTo=https://fremd.example/x', '/auth/login?next=//fremd.example', '/auth/login?redirect=https://fremd.example', '/auth/login?return=https://fremd.example',
    '/auth/callback?code=x&state=y&returnTo=https://fremd.example', '/auth/abgemeldet?next=https://fremd.example', '//fremd.example/%2e%2e', '/%2f%2ffremd.example', '/\\fremd.example'];
  for (const p of pfade) {
    const r = await anfrage('GET', p);
    const loc = r.headers.get('location') || '';
    befund(`offene-weiterleitung:${p.split('?')[0].slice(0, 30)}${p.includes('?') ? '?' + p.split('?')[1].split('=')[0] : ''}`, !loc.includes(fremd) && !r.text.includes(fremd), 'fremdes Ziel wird nicht uebernommen', { status: r.status, ziel: ortOhneQuery(loc) });
  }
  // Login-Weiterleitung nutzt den Rueckkehr-Pfad nur serverseitig; prueft zusaetzlich Host-Header-Manipulation.
  for (const [n, h] of [['x-forwarded-host', { 'x-forwarded-host': fremd }], ['x-forwarded-proto-http', { 'x-forwarded-proto': 'http' }], ['x-original-url', { 'x-original-url': '/admin' }], ['x-rewrite-url', { 'x-rewrite-url': '/admin' }], ['x-http-method-override', { 'x-http-method-override': 'DELETE' }], ['x-forwarded-for-intern', { 'x-forwarded-for': '127.0.0.1' }]]) {
    const r = await anfrage('GET', '/pool', { headers: h });
    const loc = r.headers.get('location') || '';
    const abgewiesen = [301, 302, 303, 307, 401, 403].includes(r.status) && !loc.includes(fremd) && !/^http:\/\//.test(loc);
    befund(`header:${n}`, abgewiesen && !/Neue Rechnung|Pool/.test(r.status === 200 ? r.text : ''), 'Manipulierter Header oeffnet nichts', { status: r.status, ziel: ortOhneQuery(loc) });
  }
  const hz = await anfrage('GET', '/healthz', { headers: { 'x-forwarded-for': '127.0.0.1, 10.0.0.1' } });
  befund('header:xff-spoof-healthz', hz.status === 200 || hz.status === 429, 'XFF-Spoofing ohne Wirkung (hinweis)', { status: hz.status });

  // CSRF: absichtlich ungueltige POSTs, MUESSEN abgelehnt werden.
  for (const [n, p, headers, body] of [
    ['ohne-token', '/auth/logout', { 'content-type': 'application/x-www-form-urlencoded' }, 'x=1'],
    ['falsches-token', '/auth/logout', { 'content-type': 'application/x-www-form-urlencoded', cookie: 'csrf-token=falsch' }, '_csrf=falsch'],
    ['header-falsch', '/kontierung/lieferanten', { 'content-type': 'application/json', 'x-csrf-token': 'falsch' }, '{}'],
    ['pool-ohne', '/api/pool/1/beanspruchen', { 'content-type': 'application/json' }, '{}'],
    ['zeitstempel-ohne', '/zeitstempel-pruefen', { 'content-type': 'application/x-www-form-urlencoded' }, 'x=1'],
  ]) {
    const r = await anfrage('POST', p, { headers, body });
    const loc = r.headers.get('location') || '';
    const abgelehnt = [400, 401, 403, 404].includes(r.status) || ([302, 303].includes(r.status) && /login|auth/.test(loc));
    if (!abgelehnt && r.status >= 200 && r.status < 400) { unerwarteteSchreibzugriffe.push(`POST ${p} (${n}) -> ${r.status}`); befund(`csrf:${n}`, false, 'UNERWARTET AKZEPTIERT', { status: r.status }); abbruch('CSRF-Probe unerwartet akzeptiert'); }
    befund(`csrf:${n}`, abgelehnt, 'POST ohne gueltiges Token wird abgelehnt', { status: r.status, ziel: ortOhneQuery(loc) });
  }
}

// ---- 7. Kurzer Ratenbegrenzungs-Test (innerhalb des Budgets, kein Ausloesen des Limits) ---------
async function pruefeRate() {
  let erste = null; let letzteRest = null; let n429 = 0; let hatHeader = false;
  for (let i = 0; i < 25; i += 1) {
    const r = await anfrage('GET', '/auth/abgemeldet'); // oeffentlicher Begrenzer (100/15 min), 25 Anfragen loesen ihn nicht aus
    if (r.status === 429) n429 += 1;
    const lim = r.headers.get('ratelimit-limit'); const rest = r.headers.get('ratelimit-remaining');
    if (lim) { hatHeader = true; if (erste === null) erste = Number(rest); letzteRest = Number(rest); }
    if (n429) break;
  }
  befund('ratenbegrenzung-aktiv', hatHeader, 'RateLimit-Header vorhanden (Begrenzer aktiv), Limit nicht ausgeloest', { erstesRest: erste, letztesRest: letzteRest, n429 });
  befund('ratenbegrenzung-zaehlt-ein-client', hatHeader && letzteRest !== null && erste !== null && erste - letzteRest >= 20, 'Zaehler sinkt pro Anfrage (Client-IP wird unterschieden)', { differenz: hatHeader ? erste - letzteRest : null });
}

const schritte = [pruefeTls, pruefeHeader, pruefePfade, pruefeFehler, pruefeMaschinen, pruefeManipulation, pruefeRate];
// Optional: PRUEF_SCHRITTE=Name1,Name2 beschraenkt auf einzelne Schritte (Wiederaufnahme).
const nur = (process.env.PRUEF_SCHRITTE || '').split(',').filter(Boolean);
for (const s of schritte) {
  if (nur.length && !nur.includes(s.name)) continue;
  try { await s(); } catch (e) { befund(`schritt-fehler:${s.name}`, false, 'Skriptfehler', { fehler: String(e.message).replaceAll(HOST, '<ziel>') }); }
}
console.log(JSON.stringify({ zusammenfassung: { anfragen: gesamt, fehlgeschlagen: ergebnisse.filter((e) => !e.ok).map((e) => e.id), unerwarteteSchreibzugriffe } }));
