import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createBetriebRouter } from '../../../src/routes/admin/betrieb.js';

// Echte Request-IDs sind UUIDs mit Bindestrichen.
const REQ_ID = randomUUID();
const REQ_ID_2 = randomUUID();

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/betrieb', requirePermission(db, config, 'betrieb_einsehen'), createBetriebRouter({ db }));
  return app;
}

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Eva', nachname: 'Muster', email: 'eva@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '7', vorname: 'Bea', nachname: 'Trieb', email: 'bea@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '8', vorname: 'Otto', nachname: 'Ohne', email: 'otto@example.org', gruppen: [], loggedInNow: true });
  upsertPerson(db, { id: '9', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  setBerechtigungenForPerson(db, '7', ['betrieb_einsehen']);
  setBerechtigungenForPerson(db, '8', ['mails_einsehen']);
  return { db, app: buildTestApp(db) };
}

const vorTagen = (tage) => new Date(Date.now() - tage * 24 * 3600 * 1000).toISOString();

function aufruf(db, { zeitpunkt = vorTagen(1), person = '1', pfad = '/pool', dauer = 100, browser = 'Firefox 130' } = {}) {
  db.prepare(`INSERT INTO nutzung_seitenaufrufe (zeitpunkt, person_id, methode, pfad, pfad_muster, status, dauer_ms, geraet_typ, browser, betriebssystem)
    VALUES (?, ?, 'GET', ?, ?, 200, ?, 'desktop', ?, 'Linux')`).run(zeitpunkt, person, pfad, pfad.replace(/\d+/g, ':id'), dauer, browser);
}

function fehlerAnlegen(db, requestId = REQ_ID, person = '1') {
  db.prepare(`INSERT INTO betrieb_fehler (request_id, zeitpunkt, person_id, methode, pfad, status, meldung, stack, user_agent)
    VALUES (?, ?, ?, 'GET', '/kontierung/5', 500, 'Kaputt', ?, 'TestAgent/1')`).run(requestId, vorTagen(1), person, 'Error: Kaputt\n    at <script>alert(1)</script> (/app/src/x.js:1:1)');
}

function meldungAnlegen(db, { person = '1', requestId = null, beschreibung = 'Es geht nicht' } = {}) {
  return Number(db.prepare("INSERT INTO betrieb_fehlermeldungen (zeitpunkt, person_id, request_id, beschreibung, seite) VALUES (?, ?, ?, ?, '/pool')")
    .run(vorTagen(1), person, requestId, beschreibung).lastInsertRowid);
}

test('Zugang: ohne Login 401, betrieb_einsehen 200, Superadmin 200, Manager ohne Einzelrecht 403, anderes Recht 403', async () => {
  const { db, app } = setup();
  const pfade = ['/admin/betrieb', '/admin/betrieb/fehler', '/admin/betrieb/meldungen', '/admin/betrieb/banner', '/admin/betrieb/datenschutz', '/admin/betrieb/personen/1'];
  for (const pfad of pfade) {
    assert.equal((await request(app).get(pfad)).status, 401, pfad);
    assert.equal((await request(app).get(pfad).set('x-test-person-id', '7')).status, 200, pfad);
    assert.equal((await request(app).get(pfad).set('x-test-person-id', '9')).status, 200, pfad);
    assert.equal((await request(app).get(pfad).set('x-test-person-id', '55')).status, 403, pfad);
    assert.equal((await request(app).get(pfad).set('x-test-person-id', '8')).status, 403, pfad);
  }
  const post = await request(app).post('/admin/betrieb/banner').set('x-test-person-id', '55').type('form')
    .send({ art: 'info', text: 'x', von: '2026-10-24T10:00', bis: '2026-10-25T10:00' });
  assert.equal(post.status, 403);
  db.close();
});

test('Navigation: Betrieb & Nutzung nur mit Recht', async () => {
  const { db, app } = setup();
  const res = await request(app).get('/admin/betrieb').set('x-test-person-id', '7');
  assert.match(res.text, /href="\/admin\/betrieb"[^>]*>[\s\S]*?Betrieb &amp; Nutzung/);
  db.close();
});

test('Übersicht aggregiert korrekt, mit Zeitraum und Personenfilter', async () => {
  const { db, app } = setup();
  aufruf(db, { person: '1', pfad: '/pool', dauer: 120 });
  aufruf(db, { person: '1', pfad: '/pool', dauer: 140 });
  aufruf(db, { person: '7', pfad: '/kontierung/12', dauer: 30, browser: 'Safari 18' });
  aufruf(db, { zeitpunkt: vorTagen(10), person: '9', pfad: '/meine-spesen', dauer: 10 });
  aufruf(db, { zeitpunkt: vorTagen(40), person: '9', pfad: '/alt', dauer: 10 });
  fehlerAnlegen(db);

  const res = await request(app).get('/admin/betrieb').set('x-test-person-id', '7');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-kennzahl="aktivePersonen">3</);
  assert.match(res.text, /data-kennzahl="seitenaufrufe">4</);
  assert.match(res.text, /\/kontierung\/:id/);
  assert.match(res.text, /Safari 18/);
  assert.doesNotMatch(res.text, /\/alt</);
  assert.match(res.text, /<option value="30" selected/);
  assert.doesNotMatch(res.text, /&lt;script&gt;|<script>alert/, 'kein Stack in der Übersicht');

  const sieben = await request(app).get('/admin/betrieb?tage=7').set('x-test-person-id', '7');
  assert.match(sieben.text, /data-kennzahl="seitenaufrufe">3</);
  assert.doesNotMatch(sieben.text, /\/meine-spesen/);

  const ungueltig = await request(app).get('/admin/betrieb?tage=999').set('x-test-person-id', '7');
  assert.match(ungueltig.text, /<option value="30" selected/);

  const person = await request(app).get('/admin/betrieb?person=1').set('x-test-person-id', '7');
  assert.match(person.text, /data-kennzahl="aktivePersonen">1</);
  assert.match(person.text, /data-kennzahl="seitenaufrufe">2</);
  assert.match(person.text, /<option value="1" selected/);
  db.close();
});

test('Personendetail', async () => {
  const { db, app } = setup();
  db.prepare("INSERT INTO nutzung_anmeldungen (zeitpunkt, person_id, erfolg, ip, neues_geraet) VALUES (?, '1', 1, '192.0.2.44', 1)").run(vorTagen(2));
  db.prepare("INSERT INTO nutzung_geraete (geraet_id, person_id, erstmals_am, zuletzt_am, geraet_typ, browser, betriebssystem) VALUES ('g1', '1', ?, ?, 'handy', 'Samsung Internet 25', 'Android')").run(vorTagen(5), vorTagen(1));
  aufruf(db, { person: '1', pfad: '/kontierung/4711' });
  aufruf(db, { person: '8', pfad: '/fremd-seite' });
  fehlerAnlegen(db);
  meldungAnlegen(db, { beschreibung: 'Meine Meldung' });

  const res = await request(app).get('/admin/betrieb/personen/1').set('x-test-person-id', '7');
  assert.equal(res.status, 200);
  assert.match(res.text, /Eva Muster/);
  assert.match(res.text, /192\.0\.2\.44/);
  assert.match(res.text, /Samsung Internet 25/);
  assert.match(res.text, /\/kontierung\/4711/);
  assert.doesNotMatch(res.text, /\/fremd-seite/);
  assert.match(res.text, new RegExp(`href="/admin/betrieb/fehler/${REQ_ID}"`));
  assert.match(res.text, /Meine Meldung/);
  assert.doesNotMatch(res.text, /at &lt;script/, 'kein Stack im Personendetail');

  assert.equal((await request(app).get('/admin/betrieb/personen/424242').set('x-test-person-id', '7')).status, 404);
  db.close();
});

test('Fehlerdetail zeigt Stack nur hier, escaped in <pre>; Liste mit Präfixsuche', async () => {
  const { db, app } = setup();
  fehlerAnlegen(db);
  fehlerAnlegen(db, REQ_ID_2, '8');

  const liste = await request(app).get('/admin/betrieb/fehler').set('x-test-person-id', '7');
  assert.equal(liste.status, 200);
  assert.match(liste.text, new RegExp(`>${REQ_ID.slice(0, 8)}<`));
  assert.match(liste.text, new RegExp(`>${REQ_ID_2.slice(0, 8)}<`));
  assert.doesNotMatch(liste.text, /alert\(1\)/, 'kein Stack in der Liste');

  // Liste verlinkt die volle UUID; der Link muss zur Detailseite führen.
  const link = liste.text.match(new RegExp(`href="(/admin/betrieb/fehler/${REQ_ID})"`))?.[1];
  assert.ok(link, 'Liste verlinkt die volle Request-ID');
  assert.equal((await request(app).get(link).set('x-test-person-id', '7')).status, 200);

  const gesucht = await request(app).get(`/admin/betrieb/fehler?suche=${REQ_ID.slice(0, 8).toUpperCase()}`).set('x-test-person-id', '7');
  assert.match(gesucht.text, new RegExp(`>${REQ_ID.slice(0, 8)}<`));
  assert.doesNotMatch(gesucht.text, new RegExp(`>${REQ_ID_2.slice(0, 8)}<`));
  const gesuchtVoll = await request(app).get(`/admin/betrieb/fehler?suche=${REQ_ID}`).set('x-test-person-id', '7');
  assert.match(gesuchtVoll.text, new RegExp(`>${REQ_ID.slice(0, 8)}<`));

  const detail = await request(app).get(`/admin/betrieb/fehler/${REQ_ID}`).set('x-test-person-id', '7');
  assert.equal(detail.status, 200);
  assert.match(detail.text, /<pre[^>]*>Error: Kaputt\n {4}at &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(detail.text, /<script>alert/);
  assert.match(detail.text, /Eva Muster/);

  const praefix = await request(app).get(`/admin/betrieb/fehler/${REQ_ID.slice(0, 8)}`).set('x-test-person-id', '7');
  assert.equal(praefix.status, 200);
  assert.match(praefix.text, /Kaputt/);

  assert.equal((await request(app).get('/admin/betrieb/fehler/ffffffff').set('x-test-person-id', '7')).status, 404);
  assert.equal((await request(app).get('/admin/betrieb/fehler/abc').set('x-test-person-id', '7')).status, 404);
  db.close();
});

test('Meldungsstatus ändern, Audit-Eintrag', async () => {
  const { db, app } = setup();
  fehlerAnlegen(db);
  const id = meldungAnlegen(db, { requestId: REQ_ID });

  const liste = await request(app).get('/admin/betrieb/meldungen').set('x-test-person-id', '7');
  assert.match(liste.text, new RegExp(`href="/admin/betrieb/meldungen/${id}"`));
  assert.match(liste.text, /Es geht nicht/);

  const detail = await request(app).get(`/admin/betrieb/meldungen/${id}`).set('x-test-person-id', '7');
  assert.equal(detail.status, 200);
  assert.match(detail.text, new RegExp(`href="/admin/betrieb/fehler/${REQ_ID}"`));
  assert.doesNotMatch(detail.text, /alert\(1\)/);

  const vorher = db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'betrieb_fehlermeldungen' AND aktion = 'UPDATE'").get().n;
  const res = await request(app).post(`/admin/betrieb/meldungen/${id}`).set('x-test-person-id', '7').type('form')
    .send({ status: 'in_arbeit', notiz: 'Schaue ich an' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/admin/betrieb/meldungen/${id}?gespeichert=1`);
  const m = db.prepare('SELECT * FROM betrieb_fehlermeldungen WHERE id = ?').get(id);
  assert.equal(m.status, 'in_arbeit');
  assert.equal(m.notiz, 'Schaue ich an');
  assert.equal(m.bearbeitet_von, '7');
  assert.ok(m.bearbeitet_am);
  const ereignis = db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'betrieb_fehlermeldungen' AND aktion = 'UPDATE' ORDER BY id DESC").get();
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'betrieb_fehlermeldungen' AND aktion = 'UPDATE'").get().n, vorher + 1);
  assert.equal(ereignis.objekt_id, String(id));
  assert.equal(JSON.parse(ereignis.nachher).status, 'in_arbeit');

  const offen = await request(app).get('/admin/betrieb/meldungen?status=offen').set('x-test-person-id', '7');
  assert.doesNotMatch(offen.text, new RegExp(`href="/admin/betrieb/meldungen/${id}"`));

  const falsch = await request(app).post(`/admin/betrieb/meldungen/${id}`).set('x-test-person-id', '7').type('form').send({ status: 'weg', notiz: '' });
  assert.equal(falsch.status, 400);
  const zuLang = await request(app).post(`/admin/betrieb/meldungen/${id}`).set('x-test-person-id', '7').type('form').send({ status: 'erledigt', notiz: 'x'.repeat(2001) });
  assert.equal(zuLang.status, 400);
  assert.equal(db.prepare('SELECT status FROM betrieb_fehlermeldungen WHERE id = ?').get(id).status, 'in_arbeit');
  assert.equal((await request(app).post('/admin/betrieb/meldungen/999').set('x-test-person-id', '7').type('form').send({ status: 'erledigt' })).status, 404);
  assert.equal((await request(app).get('/admin/betrieb/meldungen/999').set('x-test-person-id', '7')).status, 404);
  db.close();
});

test('Banner anlegen, validieren, bearbeiten, deaktivieren', async () => {
  const { db, app } = setup();
  db.exec('DELETE FROM banner');
  const anlegen = (felder) => request(app).post('/admin/betrieb/banner').set('x-test-person-id', '7').type('form').send(felder);

  const ok = await anlegen({ art: 'wartung', text: 'Wartung heute', link: '/datenschutz', von: '2026-10-24T10:00', bis: '2026-10-24T12:00' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/admin/betrieb/banner?gespeichert=1');
  const b = db.prepare('SELECT * FROM banner').get();
  assert.equal(b.art, 'wartung');
  assert.equal(b.text, 'Wartung heute');
  assert.equal(b.link, '/datenschutz');
  assert.equal(b.von, '2026-10-24T08:00:00.000Z');
  assert.equal(b.bis, '2026-10-24T10:00:00.000Z');
  assert.equal(b.erstellt_von, '7');
  assert.equal(b.aktiv, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_ereignisse WHERE objekt = 'banner' AND aktion = 'INSERT' AND objekt_id = ?").get(String(b.id)).n, 1);

  const boese = await anlegen({ art: 'info', text: 'Klick', link: 'javascript:alert(1)', von: '2026-10-24T10:00', bis: '2026-10-25T10:00' });
  assert.equal(boese.status, 400);
  assert.match(boese.text, /Der Link muss mit https:\/\/ oder \/ beginnen/);
  assert.match(boese.text, /value="javascript:alert\(1\)"/, 'Eingabe bleibt erhalten');
  const rueckwaerts = await anlegen({ art: 'info', text: 'x', von: '2026-10-25T10:00', bis: '2026-10-24T10:00' });
  assert.equal(rueckwaerts.status, 400);
  const leer = await anlegen({ art: 'info', text: 'x', von: '', bis: '2026-10-24T10:00' });
  assert.equal(leer.status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM banner').get().n, 1);

  const liste = await request(app).get('/admin/betrieb/banner').set('x-test-person-id', '7');
  assert.match(liste.text, /Wartung heute/);
  assert.match(liste.text, /24\.10\.2026 10:00/);

  const form = await request(app).get(`/admin/betrieb/banner/${b.id}`).set('x-test-person-id', '7');
  assert.equal(form.status, 200);
  assert.match(form.text, /name="von"[^>]*value="2026-10-24T10:00"/);
  assert.match(form.text, new RegExp(`action="/admin/betrieb/banner/${b.id}"`));

  const bearbeiten = await request(app).post(`/admin/betrieb/banner/${b.id}`).set('x-test-person-id', '7').type('form')
    .send({ art: 'warnung', text: 'Neu\nZeile 2', link: '', von: '2026-10-24T10:00', bis: '2026-10-24T14:00' });
  assert.equal(bearbeiten.status, 302);
  const neu = db.prepare('SELECT * FROM banner WHERE id = ?').get(b.id);
  assert.equal(neu.art, 'warnung');
  assert.equal(neu.text, 'Neu\nZeile 2');
  assert.equal(neu.link, null);
  assert.equal(neu.bis, '2026-10-24T12:00:00.000Z');
  const falschBearbeitet = await request(app).post(`/admin/betrieb/banner/${b.id}`).set('x-test-person-id', '7').type('form')
    .send({ art: 'info', text: 'x', link: '//evil.org', von: '2026-10-24T10:00', bis: '2026-10-24T14:00' });
  assert.equal(falschBearbeitet.status, 400);
  assert.equal(db.prepare('SELECT art FROM banner WHERE id = ?').get(b.id).art, 'warnung');

  const deaktivieren = await request(app).post(`/admin/betrieb/banner/${b.id}/deaktivieren`).set('x-test-person-id', '7');
  assert.equal(deaktivieren.status, 302);
  assert.equal(db.prepare('SELECT aktiv FROM banner WHERE id = ?').get(b.id).aktiv, 0);
  assert.equal((await request(app).post('/admin/betrieb/banner/999/deaktivieren').set('x-test-person-id', '7')).status, 404);
  assert.equal((await request(app).get('/admin/betrieb/banner/999').set('x-test-person-id', '7')).status, 404);
  db.close();
});

test('Datenschutztext und Kontaktadresse speichern, Adresse locker geprüft', async () => {
  const { db, app } = setup();
  const form = await request(app).get('/admin/betrieb/datenschutz').set('x-test-person-id', '7');
  assert.match(form.text, /name="datenschutzText"/);
  assert.match(form.text, /Das Portal speichert Nutzungsdaten/);

  const res = await request(app).post('/admin/betrieb/datenschutz').set('x-test-person-id', '7').type('form')
    .send({ datenschutzText: 'Neuer Text\nmit %kontakt%', kontaktEmail: ' it@example.org ' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/betrieb/datenschutz?gespeichert=1');
  assert.equal(getConfigValue(db, 'datenschutz_text'), 'Neuer Text\nmit %kontakt%');
  assert.equal(getConfigValue(db, 'betrieb_kontakt_email'), 'it@example.org');
  assert.ok(db.prepare("SELECT 1 FROM audit_ereignisse WHERE objekt = 'admin_config' AND objekt_id = 'datenschutz_text'").get());

  for (const kontaktEmail of ['keine-adresse', 'a b@example.org', 'a@b@c']) {
    const falsch = await request(app).post('/admin/betrieb/datenschutz').set('x-test-person-id', '7').type('form')
      .send({ datenschutzText: 'Anders', kontaktEmail });
    assert.equal(falsch.status, 400, kontaktEmail);
  }
  const leererText = await request(app).post('/admin/betrieb/datenschutz').set('x-test-person-id', '7').type('form')
    .send({ datenschutzText: '   ', kontaktEmail: '' });
  assert.equal(leererText.status, 400);
  assert.equal(getConfigValue(db, 'datenschutz_text'), 'Neuer Text\nmit %kontakt%');

  const leer = await request(app).post('/admin/betrieb/datenschutz').set('x-test-person-id', '7').type('form')
    .send({ datenschutzText: 'Text', kontaktEmail: '' });
  assert.equal(leer.status, 302);
  assert.equal(getConfigValue(db, 'betrieb_kontakt_email'), '');
  db.close();
});
