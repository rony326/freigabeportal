import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung } from '../../src/db/jobsRepo.js';
import { zaehleOffeneAufgaben } from '../../src/services/aufgabenZaehler.js';
import { loadNavFlags } from '../../src/middleware/nav.js';

function setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['50', '1', '2', '3']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'Muster', email: `${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return db;
}

const neuerJob = (db, name) =>
  createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: name, pdfPfad: '/tmp/a.pdf' });

test('zaehleOffeneAufgaben liefert 0 ohne Jobs', () => {
  const db = setup();
  assert.equal(zaehleOffeneAufgaben(db, '50'), 0);
  db.close();
});

test('zaehleOffeneAufgaben zählt Kontierung und Freigabe 2, nicht den Pool', () => {
  const db = setup();
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const a = neuerJob(db, 'a.pdf');
  claimJob(db, a, '50');
  const b = neuerJob(db, 'b.pdf');
  setKontierung(db, b, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(b);
  neuerJob(db, 'pool.pdf');
  assert.equal(zaehleOffeneAufgaben(db, '50'), 2);
  db.close();
});

test('loadNavFlags setzt res.locals.navigation nur mit Person', () => {
  const db = setup();
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  const mw = loadNavFlags(db, config);

  const anon = { path: '/pool', currentPerson: null };
  const resAnon = { locals: {} };
  mw(anon, resAnon, () => {});
  assert.equal(resAnon.locals.navigation, null);

  const person = { churchtools_person_id: '50', gruppen: ['10'] };
  const res = { locals: {} };
  mw({ path: '/pool', currentPerson: person }, res, () => {});
  assert.equal(res.locals.navigation.bereich, 'portal');
  assert.equal(typeof res.locals.navigation.zeigeAdminReiter, 'boolean');
  assert.ok(Array.isArray(res.locals.navigation.gruppen));

  const resAdmin = { locals: {} };
  mw({ path: '/admin/konten', currentPerson: person }, resAdmin, () => {});
  assert.equal(resAdmin.locals.navigation.bereich, 'admin');
  db.close();
});

test('zaehleOffeneAufgaben zählt eine Spesen-Freigabe 1', () => {
  const db = setup();
  const s = neuerJob(db, 'spesen.pdf');
  db.prepare("UPDATE jobs SET status = 'zugewiesen', quelle = 'spesen', zugewiesen_an = '50', eingereicht_von = '1' WHERE id = ?").run(s);
  assert.equal(zaehleOffeneAufgaben(db, '50'), 1);
  db.close();
});

test('zaehleOffeneAufgaben zählt eskalierte Abschnitte nur für Superadmins', () => {
  const db = setup();
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const k = neuerJob(db, 'esk-k.pdf');
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', freigabe1_eskaliert_an_admin = 1 WHERE id = ?").run(k);
  const f = neuerJob(db, 'esk-f.pdf');
  setKontierung(db, f, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', freigabe2_eskaliert_an_admin = 1 WHERE id = ?").run(f);
  const s = neuerJob(db, 'esk-s.pdf');
  db.prepare("UPDATE jobs SET status = 'zugewiesen', quelle = 'spesen', zugewiesen_an = '1', eingereicht_von = '2', freigabe1_eskaliert_an_admin = 1 WHERE id = ?").run(s);
  assert.equal(zaehleOffeneAufgaben(db, '50'), 0);
  assert.equal(zaehleOffeneAufgaben(db, '50', { istSuperadmin: false }), 0);
  assert.equal(zaehleOffeneAufgaben(db, '50', { istSuperadmin: true }), 3);
  db.close();
});

test('zaehleOffeneAufgaben zählt Vertretungsfälle (Ferienmodus) wie /pool', () => {
  const db = setup();
  const a = neuerJob(db, 'vertretung.pdf');
  claimJob(db, a, '1');
  db.prepare(
    "UPDATE personen SET ferienmodus_stellvertreter_id = '50', ferienmodus_von = date('now', '-1 day'), ferienmodus_bis = date('now', '+1 day') WHERE churchtools_person_id = '1'"
  ).run();
  assert.equal(zaehleOffeneAufgaben(db, '50'), 1);
  assert.equal(zaehleOffeneAufgaben(db, '1'), 1);
  db.close();
});

test('loadNavFlags zählt für Superadmins eskalierte Aufgaben im Badge', () => {
  const db = setup();
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  const k = neuerJob(db, 'esk.pdf');
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', freigabe1_eskaliert_an_admin = 1 WHERE id = ?").run(k);
  const mw = loadNavFlags(db, config);
  const badge = (gruppen) => JSON.stringify(gruppen);
  const resAdmin = { locals: {} };
  mw({ path: '/pool', currentPerson: { churchtools_person_id: '50', gruppen: ['20'] } }, resAdmin, () => {});
  const resNormal = { locals: {} };
  mw({ path: '/pool', currentPerson: { churchtools_person_id: '50', gruppen: ['10'] } }, resNormal, () => {});
  const aufgaben = (res) => res.locals.navigation.gruppen.flatMap((g) => g.punkte ?? g.eintraege ?? g.items ?? []).find((p) => /Aufgaben/.test(p.label ?? p.titel ?? ''));
  assert.ok(aufgaben(resAdmin), badge(resAdmin.locals.navigation.gruppen));
  assert.equal(aufgaben(resAdmin).zaehler ?? aufgaben(resAdmin).badge, 1, badge(resAdmin.locals.navigation.gruppen));
  assert.ok(!(aufgaben(resNormal).zaehler ?? aufgaben(resNormal).badge));
  db.close();
});
