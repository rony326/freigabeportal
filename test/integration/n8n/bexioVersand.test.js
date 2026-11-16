import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { createJob } from '../../../src/db/jobsRepo.js';
import { seedDefaults } from '../../../src/db/adminConfigRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nJobsRouter } from '../../../src/routes/n8n/jobs.js';
import { setzeFreigabeSnapshot, freigabeSnapshotsFuerTest } from '../../helpers/freigabeSnapshot.js';

// Versandquittung für Bexio (docs/n8n-schnittstelle.md «Versand an Bexio bestätigen»): n8n meldet
// nach dem Mailversand an das Bexio-Eingangspostfach die Antwort des Mailservers.

const KEY = 'workflow-key';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bexio-versand-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { jobsDir: dir, n8nApiKey: KEY };
  const app = express();
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
  // Statt des Express-Standards (Stack im Testlog): nur der Status, z. B. 413 bei zu grossem Body.
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  function job(name = 'rechnung', groupParent = null) {
    const path = join(dir, `${name}.pdf`);
    const bytes = Buffer.from(`%PDF-1.4\n${name}\n`);
    writeFileSync(path, bytes);
    const id = createJob(db, { eingangAm: '2026-11-01T00:00:00Z', quelle: 'scanner', dateiname: `${name}.pdf`, pdfPfad: path });
    const hash = createHash('sha256').update(bytes).digest('hex');
    db.prepare("UPDATE jobs SET status = 'abgeschlossen', final_datei_hash = ?, aufgesplittet_von = ? WHERE id = ?").run(hash, groupParent, id);
    setzeFreigabeSnapshot(db, id);
    return { id, path };
  }
  const manifest = async (id) => {
    await freigabeSnapshotsFuerTest(db);
    const res = await request(app).get(`/api/n8n/jobs/${id}/exportnachweis`).set('X-API-Key', KEY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const post = (id, body, key = KEY) => {
    const req = request(app).post(`/api/n8n/jobs/${id}/bexio-versand-bestaetigen`);
    if (key) req.set('X-API-Key', key);
    return req.send(body);
  };
  const ausstehend = (nachId) => request(app).get(`/api/n8n/jobs/bexio-versand-ausstehend${nachId === undefined ? '' : `?nach_id=${nachId}`}`).set('X-API-Key', KEY);
  const quittung = (m, extra = {}) => ({
    export_id: m.export_id,
    empfaenger: 'eingang@bexio.example.org',
    message_id: '<abc123@mail.example.org>',
    smtp_antwort: '250 2.0.0 Ok: queued as 4ABC12',
    gesendet_am: '2026-11-16T10:15:00.000+01:00',
    ...extra,
  });
  const zeilen = () => db.prepare('SELECT * FROM bexio_versand ORDER BY id').all();
  return { db, dir, app, job, manifest, post, ausstehend, quittung, zeilen };
}

test('Versandquittung wird gespeichert und als Audit-Ereignis von n8n protokolliert', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  const res = await s.post(j.id, s.quittung(m));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.id, j.id);
  assert.equal(res.body.status, 'bexio_versand_bestaetigt');
  assert.equal(res.body.versand.export_id, m.export_id);
  assert.equal(res.body.versand.message_id, '<abc123@mail.example.org>');
  assert.equal(res.body.versand.gesendet_am, '2026-11-16T09:15:00.000Z', 'gesendet_am wird als UTC-ISO gespeichert');
  const [zeile] = s.zeilen();
  assert.equal(zeile.job_id, j.id);
  assert.equal(zeile.empfaenger, 'eingang@bexio.example.org');
  assert.equal(zeile.smtp_antwort, '250 2.0.0 Ok: queued as 4ABC12');
  assert.ok(Date.parse(zeile.gemeldet_am));
  const ereignis = s.db.prepare("SELECT * FROM audit_ereignisse WHERE objekt = 'bexio_versand'").get();
  assert.ok(ereignis, 'Audit-Ereignis erwartet');
  assert.equal(ereignis.aktion, 'INSERT');
  assert.equal(ereignis.person_id, 'service:n8n');
  assert.match(ereignis.nachher, /abc123@mail\.example\.org/);
});

test('gleiche message_id ist idempotent, ein zweiter Versand ergibt einen zweiten Eintrag', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  const erste = await s.post(j.id, s.quittung(m));
  assert.equal(erste.status, 201);
  const wiederholt = await s.post(j.id, s.quittung(m));
  assert.equal(wiederholt.status, 200);
  assert.equal(wiederholt.body.duplikat, true);
  assert.deepEqual(wiederholt.body.versand, erste.body.versand);
  assert.equal(s.zeilen().length, 1);
  const zweite = await s.post(j.id, s.quittung(m, { message_id: '<zweiter@mail.example.org>', gesendet_am: '2026-11-17T08:00:00Z' }));
  assert.equal(zweite.status, 201);
  assert.equal(s.zeilen().length, 2);
  // Dieselbe Message-ID kann nicht zu einem anderen Vorgang gehören.
  const anderer = s.job('anderer');
  const m2 = await s.manifest(anderer.id);
  assert.equal((await s.post(anderer.id, s.quittung(m2))).status, 409);
  assert.equal(s.zeilen().length, 2);
});

test('mehrere Empfänger als Liste sowie akzeptiert-Liste aus der Mail-Antwort', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  const res = await s.post(j.id, s.quittung(m, {
    empfaenger: ['eingang@bexio.example.org', 'kopie@example.org'],
    akzeptiert: ['eingang@bexio.example.org', 'KOPIE@example.org'],
    abgelehnt: [],
  }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(s.zeilen()[0].empfaenger, 'eingang@bexio.example.org, kopie@example.org');
});

test('ohne API-Key 401, unbekannter Vorgang 404, ungültige ID 400', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  assert.equal((await s.post(j.id, s.quittung(m), null)).status, 401);
  assert.equal((await s.post(j.id, s.quittung(m), 'falsch')).status, 401);
  assert.equal((await s.post(99999, s.quittung(m))).status, 404);
  assert.equal((await s.post('abc', s.quittung(m))).status, 400);
  assert.equal(s.zeilen().length, 0);
});

test('nicht exportierter Vorgang 409, Rapport 404 (Rechnungsweg kennt keine Rapporte)', async (t) => {
  const s = setup(t);
  const j = s.job();
  // Ohne Exportnachweis gilt der Vorgang als nicht exportiert.
  assert.equal((await s.post(j.id, s.quittung({ export_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334' }))).status, 409);
  const rapport = s.job('rapport');
  s.db.prepare("UPDATE jobs SET typ = 'rapport' WHERE id = ?").run(rapport.id);
  assert.equal((await s.post(rapport.id, s.quittung({ export_id: 'b2ba769c-455f-4d97-9fb6-986eac19a334' }))).status, 404);
  assert.equal(s.zeilen().length, 0);
});

test('export_id eines anderen Vorgangs wird abgelehnt', async (t) => {
  const s = setup(t);
  const a = s.job('a');
  const b = s.job('b');
  await s.manifest(a.id);
  const mb = await s.manifest(b.id);
  const res = await s.post(a.id, s.quittung(mb));
  assert.equal(res.status, 409);
  assert.equal(s.zeilen().length, 0);
});

test('422 bei SMTP-Fehlerantwort oder abgelehntem Bexio-Empfänger', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  for (const extra of [
    { smtp_antwort: '450 4.2.0 Mailbox busy' },
    { smtp_antwort: '550 5.1.1 User unknown' },
    { smtp_antwort: 'Ok queued' },
    { abgelehnt: ['eingang@bexio.example.org'] },
    { abgelehnt: ['EINGANG@bexio.example.org'] },
    { akzeptiert: [] },
    { empfaenger: ['eingang@bexio.example.org', 'zwei@example.org'], akzeptiert: ['eingang@bexio.example.org'] },
  ]) {
    const res = await s.post(j.id, s.quittung(m, extra));
    assert.equal(res.status, 422, JSON.stringify(extra));
  }
  // Ein abgelehnter Nicht-Bexio-Empfänger (z. B. eine Kopie) verhindert die Quittung nicht.
  assert.equal((await s.post(j.id, s.quittung(m, { abgelehnt: ['kopie@example.org'] }))).status, 201);
  assert.equal(s.zeilen().length, 1);
});

test('400 bei fehlenden Feldern, Array/Objekt statt Text, zu langen Werten und Zeilenumbrüchen', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  const lang = 'x'.repeat(300);
  for (const extra of [
    { export_id: undefined },
    { export_id: [m.export_id] },
    { empfaenger: undefined },
    { empfaenger: 'keine-adresse' },
    { empfaenger: { a: 1 } },
    { empfaenger: [] },
    { empfaenger: [['eingang@bexio.example.org']] },
    { empfaenger: `${lang}@example.org` },
    { message_id: undefined },
    { message_id: ['<a@b>'] },
    { message_id: { id: 'x' } },
    { message_id: `<${lang}@example.org>` },
    { message_id: '<a@b>\r\nX-Gefaelscht: 1' },
    { smtp_antwort: undefined },
    { smtp_antwort: ['250 ok'] },
    { smtp_antwort: `250 ${'y'.repeat(600)}` },
    { gesendet_am: undefined },
    { gesendet_am: 'gestern' },
    { gesendet_am: '2026-11-16' },
    { gesendet_am: 1763284500000 },
    { akzeptiert: 'eingang@bexio.example.org' },
    { abgelehnt: [{ address: 'x@example.org' }] },
  ]) {
    const res = await s.post(j.id, s.quittung(m, extra));
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.equal(s.zeilen().length, 0);
});

test('Zeilenumbrüche in der SMTP-Antwort werden zu Leerzeichen (keine Log-/Anzeige-Injektion)', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  const res = await s.post(j.id, s.quittung(m, { smtp_antwort: '250-mail.example.org\r\n250 2.0.0 Ok: queued as X1\u0000' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(s.zeilen()[0].smtp_antwort, '250-mail.example.org 250 2.0.0 Ok: queued as X1');
});

test('Body über 8 KB wird abgewiesen', async (t) => {
  const s = setup(t);
  const j = s.job();
  const m = await s.manifest(j.id);
  const res = await s.post(j.id, s.quittung(m, { fuellung: 'z'.repeat(9 * 1024) }));
  assert.equal(res.status, 413);
  assert.equal(s.zeilen().length, 0);
});

test('Splitgruppe: Quittung am Elternjob mit dem Gruppenexport, nicht am Teilbeleg', async (t) => {
  const s = setup(t);
  const parent = s.job('parent');
  const child = s.job('child', parent.id);
  const groupPath = join(s.dir, 'group.pdf');
  writeFileSync(groupPath, '%PDF group document');
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet', gruppe_pdf_pfad = ? WHERE id = ?").run(groupPath, parent.id);
  const m = await s.manifest(parent.id);
  assert.equal((await s.post(child.id, s.quittung(m))).status, 409, 'Teilbeleg hat keinen eigenen Export');
  const res = await s.post(parent.id, s.quittung(m));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(s.zeilen()[0].job_id, parent.id);
  assert.deepEqual((await s.ausstehend()).body, []);
});

test('bexio-versand-ausstehend listet exportierte Belege ohne Quittung, ohne Rapporte, mit Cursor', async (t) => {
  const s = setup(t);
  const a = s.job('a');
  const b = s.job('b');
  const ohneExport = s.job('c');
  const rapport = s.job('rapport');
  const ma = await s.manifest(a.id);
  const mb = await s.manifest(b.id);
  // Rapport mit Exportnachweis (wie über /api/n8n/rapporte erzeugt) darf nicht erscheinen.
  s.db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES ('r1', ?, 's', '{}', 't')").run(rapport.id);
  s.db.prepare("UPDATE jobs SET typ = 'rapport' WHERE id = ?").run(rapport.id);

  const alle = await s.ausstehend();
  assert.equal(alle.status, 200);
  assert.equal(alle.headers['cache-control'], 'no-store');
  assert.deepEqual(alle.body.map((e) => e.id), [a.id, b.id]);
  assert.equal(alle.body[0].export_id, ma.export_id);
  assert.equal(alle.body[0].export_nachweis_url, `/api/n8n/jobs/${a.id}/exportnachweis`);
  assert.ok(!alle.body.some((e) => e.id === ohneExport.id));

  assert.deepEqual((await s.ausstehend(a.id)).body.map((e) => e.id), [b.id]);
  assert.equal((await s.ausstehend('x')).status, 400);

  assert.equal((await s.post(b.id, s.quittung(mb))).status, 201);
  assert.deepEqual((await s.ausstehend()).body.map((e) => e.id), [a.id]);
  assert.equal((await request(s.app).get('/api/n8n/jobs/bexio-versand-ausstehend')).status, 401);
});

test('bexio-versand-ausstehend liefert höchstens 100 Einträge', async (t) => {
  const s = setup(t);
  const id = s.job('basis').id;
  const einfuegen = s.db.prepare("INSERT INTO export_nachweise (id, job_id, sha256, manifest, erstellt_am) VALUES (?, ?, 's', '{}', 't')");
  for (let i = 0; i < 105; i++) {
    const neu = createJob(s.db, { eingangAm: '2026-11-01T00:00:00Z', quelle: 'scanner', dateiname: `x${i}.pdf`, pdfPfad: join(s.dir, `x${i}.pdf`) });
    einfuegen.run(`e${i}`, neu);
  }
  const erste = (await s.ausstehend()).body;
  assert.equal(erste.length, 100);
  assert.ok(!erste.some((e) => e.id === id));
  const rest = (await s.ausstehend(erste.at(-1).id)).body;
  assert.equal(rest.length, 5);
});
