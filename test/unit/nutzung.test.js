import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { geraetAusUserAgent, normalisierePfad, geraeteIdAusCookie, erfasseFehler } from '../../src/services/nutzung.js';
import { withAuditRequest } from '../../src/services/auditContext.js';

const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  samsungHandy: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
};

test('geraetAusUserAgent erkennt gängige Browser, Systeme und Gerätetypen', () => {
  assert.deepEqual(geraetAusUserAgent(UA.chromeWindows), { geraetTyp: 'desktop', browser: 'Chrome 130', betriebssystem: 'Windows' });
  assert.deepEqual(geraetAusUserAgent(UA.safariIphone), { geraetTyp: 'handy', browser: 'Safari 18', betriebssystem: 'iOS' });
  assert.deepEqual(geraetAusUserAgent(UA.safariIpad), { geraetTyp: 'tablet', browser: 'Safari 18', betriebssystem: 'iPadOS' });
  assert.deepEqual(geraetAusUserAgent(UA.firefoxLinux), { geraetTyp: 'desktop', browser: 'Firefox 131', betriebssystem: 'Linux' });
  assert.deepEqual(geraetAusUserAgent(UA.samsungHandy), { geraetTyp: 'handy', browser: 'Samsung Internet 26', betriebssystem: 'Android' });
  assert.deepEqual(geraetAusUserAgent(UA.chromeAndroidTablet), { geraetTyp: 'tablet', browser: 'Chrome 130', betriebssystem: 'Android' });
  assert.deepEqual(geraetAusUserAgent(UA.edgeMac), { geraetTyp: 'desktop', browser: 'Edge 130', betriebssystem: 'macOS' });
});

test('geraetAusUserAgent: leerer oder unbekannter User-Agent', () => {
  assert.deepEqual(geraetAusUserAgent(''), { geraetTyp: 'unbekannt', browser: 'Andere', betriebssystem: 'Andere' });
  assert.deepEqual(geraetAusUserAgent(undefined), { geraetTyp: 'unbekannt', browser: 'Andere', betriebssystem: 'Andere' });
  assert.deepEqual(geraetAusUserAgent('curl/8.5.0'), { geraetTyp: 'unbekannt', browser: 'Andere', betriebssystem: 'Andere' });
});

test('normalisierePfad ersetzt Zahlen- und ID-Segmente durch :id', () => {
  assert.equal(normalisierePfad('/kontierung/123/aufsplitten'), '/kontierung/:id/aufsplitten');
  assert.equal(normalisierePfad('/pool'), '/pool');
  assert.equal(normalisierePfad('/'), '/');
  assert.equal(normalisierePfad('/downloads/0123456789abcdef0123456789ABCDEF'), '/downloads/:id');
  assert.equal(normalisierePfad('/x/3f2504e0-4f89-41d3-9a0c-0305e82c3301/y'), '/x/:id/y');
  assert.equal(normalisierePfad('/admin/v2/konten'), '/admin/v2/konten');
  assert.equal(normalisierePfad('/a/12/b/34/'), '/a/:id/b/:id/');
});

function fakeRes() {
  const cookies = [];
  return { cookies, cookie(name, value, options) { cookies.push({ name, value, options }); } };
}

test('geraeteIdAusCookie übernimmt gültige ID und ersetzt fehlende oder ungültige', () => {
  const gueltig = 'a'.repeat(32);
  const res1 = fakeRes();
  assert.equal(geraeteIdAusCookie({ cookies: { fp_geraet: gueltig }, session: { cookie: { secure: false } } }, res1), gueltig);
  assert.equal(res1.cookies.length, 0);

  for (const wert of [undefined, 'zu-kurz', 'G'.repeat(32), `${gueltig}0`]) {
    const res = fakeRes();
    const id = geraeteIdAusCookie({ cookies: wert === undefined ? {} : { fp_geraet: wert }, session: { cookie: { secure: true } } }, res);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(res.cookies.length, 1);
    const { name, value, options } = res.cookies[0];
    assert.equal(name, 'fp_geraet');
    assert.equal(value, id);
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, 'lax');
    assert.equal(options.secure, true);
    assert.equal(options.maxAge, 2 * 365 * 24 * 60 * 60 * 1000);
  }
  const res2 = fakeRes();
  geraeteIdAusCookie({ cookies: {}, session: { cookie: { secure: false } } }, res2);
  assert.equal(res2.cookies[0].options.secure, false);
});

test('erfasseFehler speichert Request-ID, kürzt den Stack und wirft nie', () => {
  const db = openDatabase(':memory:');
  const err = new Error('Kaputt');
  err.stack = `Error: Kaputt\n${'x'.repeat(20000)}`;
  const req = {
    method: 'POST', originalUrl: '/kontierung/5?geheim=1', path: '/5', headers: { 'user-agent': UA.firefoxLinux },
    currentPerson: { churchtools_person_id: '7' }, cookies: { fp_geraet: 'b'.repeat(32) }, res: { getHeader() { return null; } },
  };
  const id = withAuditRequest('11111111-2222-3333-4444-555555555555', () => erfasseFehler(db, { req, err, status: 500 }));
  assert.equal(id, '11111111-2222-3333-4444-555555555555');
  const row = db.prepare('SELECT * FROM betrieb_fehler').get();
  assert.equal(row.request_id, id);
  assert.equal(row.person_id, '7');
  assert.equal(row.methode, 'POST');
  assert.equal(row.pfad, '/kontierung/5');
  assert.equal(row.status, 500);
  assert.equal(row.meldung, 'Kaputt');
  assert.equal(row.stack.length, 8000);
  assert.equal(row.user_agent, UA.firefoxLinux);
  assert.equal(row.geraet_id, 'b'.repeat(32));

  db.exec('DROP TABLE betrieb_fehler');
  const id2 = withAuditRequest('99999999-2222-3333-4444-555555555555', () => erfasseFehler(db, { req, err, status: 500 }));
  assert.equal(id2, '99999999-2222-3333-4444-555555555555');
  db.close();
});
