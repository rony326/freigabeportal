import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById, listKontenForPerson } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById, markJobAufgesplittet } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { erzeugeTeilJobs, bereiteTeilDateienVor, verteileVersandkosten, positionMitVersand, benachrichtigeNachAufsplitten } from '../../src/services/aufsplitten.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4', '5', '6']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  const eigen = createKonto(db, { kontonummer: '1000', bezeichnung: 'Eigen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const fremd = createKonto(db, { kontonummer: '2000', bezeichnung: 'Fremd', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '6', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'kk.pdf', pdfPfad: '/tmp/kk.pdf' });
  claimJob(db, jobId, '1');
  return { db, eigen, fremd, jobId };
}

test("erzeugeTeilJobs 'freigeber1' mode assigns foreign-Konto lines to that Konto's Freigeber1 instead of the pool", () => {
  const { db, eigen, fremd, jobId } = setup();
  const job = getJobById(db, jobId);
  db.exec('BEGIN');
  markJobAufgesplittet(db, jobId);
  const ergebnis = erzeugeTeilJobs(db, {
    job,
    teile: [
      { konto: getKontoById(db, eigen), betrag: '10.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, belegSeitenzahl: 1, beschreibung: 'Papier' },
      { konto: getKontoById(db, fremd), betrag: '-5.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, belegSeitenzahl: null, typ: 'gutschrift', beschreibung: 'Rückerstattung', kkEigenbelegGrund: 'Beleg verloren' },
    ],
    konten: listKontenForPerson(db, '1'),
    person: getPersonById(db, '1'),
    ip: '::1',
    begruendung: '',
    fremdKontoModus: 'freigeber1',
    istVertretung: false,
  });
  db.exec('COMMIT');
  assert.equal(ergebnis.selbstFreigegeben.length, 1);
  assert.equal(ergebnis.anFreigeber1.length, 1);
  assert.equal(ergebnis.fremdeKonten.length, 0);
  const eigenKind = getJobById(db, ergebnis.selbstFreigegeben[0].id);
  assert.equal(eigenKind.status, 'freigabe2');
  assert.equal(eigenKind.beschreibung, 'Papier');
  const fremdKind = getJobById(db, ergebnis.anFreigeber1[0].id);
  assert.equal(fremdKind.status, 'zugewiesen');
  assert.equal(fremdKind.zugewiesen_an, '5');
  assert.equal(fremdKind.konto_id, fremd);
  assert.equal(fremdKind.typ, 'gutschrift');
  assert.equal(fremdKind.kk_eigenbeleg_grund, 'Beleg verloren');
  assert.equal(fremdKind.aufgesplittet_von, jobId);
  assert.equal(listFreigabenByJob(db, fremdKind.id).length, 0);
  db.close();
});

test("erzeugeTeilJobs 'pool' mode keeps today's behavior: foreign-Konto lines go unzugewiesen with a Hinweis-Konto", () => {
  const { db, fremd, jobId } = setup();
  const job = getJobById(db, jobId);
  db.exec('BEGIN');
  markJobAufgesplittet(db, jobId);
  const ergebnis = erzeugeTeilJobs(db, {
    job,
    teile: [{ konto: getKontoById(db, fremd), betrag: '10.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, belegSeitenzahl: null }],
    konten: listKontenForPerson(db, '1'),
    person: getPersonById(db, '1'),
    ip: '::1',
    begruendung: '',
    fremdKontoModus: 'pool',
    istVertretung: false,
  });
  db.exec('COMMIT');
  const kind = getJobById(db, ergebnis.fremdeKonten[0].id);
  assert.equal(kind.status, 'unzugewiesen');
  assert.equal(kind.hinweis_konto_id, fremd);
  db.close();
});

test('bereiteTeilDateienVor removes the files it already created when a later Teil fails, then rethrows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aufsplitten-'));
  const pdfPfad = join(dir, 'rechnung.pdf');
  const thumbnailPfad = join(dir, 'rechnung.png');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung']));
  writeFileSync(thumbnailPfad, 'png');
  const job = { pdf_pfad: pdfPfad, thumbnail_pfad: thumbnailPfad };
  const gut = { buffer: await buildPdfFixture(['Beleg']), mimetype: 'application/pdf' };
  const kaputt = { buffer: Buffer.from('%PDF-1.4 kaputt'), mimetype: 'application/pdf' };
  await assert.rejects(bereiteTeilDateienVor({ jobsDir: dir }, job, [{ beleg: gut }, { beleg: null }, { beleg: kaputt }]));
  assert.deepEqual(readdirSync(dir).sort(), ['rechnung.pdf', 'rechnung.png']);
  rmSync(dir, { recursive: true, force: true });
});

test('verteileVersandkosten teilt gleichmässig in Rappen, der Rest geht an den letzten Teil', () => {
  assert.deepEqual(verteileVersandkosten(1000, 3), [333, 333, 334]);
  assert.deepEqual(verteileVersandkosten(2, 3), [0, 0, 2]);
  assert.deepEqual(verteileVersandkosten(0, 2), [0, 0]);
});

test('positionMitVersand ergänzt die Position nur bei einem Versandanteil grösser 0', () => {
  assert.equal(positionMitVersand('Pos. 2', 335), 'Pos. 2 (inkl. Versand 3.35)');
  assert.equal(positionMitVersand(null, 335), 'inkl. Versand 3.35');
  assert.equal(positionMitVersand('Pos. 2', 0), 'Pos. 2');
  assert.equal(positionMitVersand(null, 0), null);
});

// Beide Gründe für die Admin-Gruppe: Vier-Augen-Umleitung (neutraler Text) und erklärter Interessenskonflikt.
for (const [name, grund, muster, nichtMuster] of [
  ['Vier-Augen-Umleitung', null, /Vier-Augen-Prinzip/, /Interessenskonflikt/],
  ['Interessenskonflikt', 'Befangen', /Interessenskonflikt erklärt/, /Vier-Augen/],
]) {
  test(`benachrichtigeNachAufsplitten: Admin-Mail passt zum Grund (${name})`, async () => {
    const { db, eigen, jobId } = setup();
    seedDefaults(db);
    upsertPerson(db, { id: '9', vorname: 'Super', nachname: 'Admin', email: 'sa@example.org', gruppen: ['20'] });
    db.prepare("UPDATE konten SET freigeber2_id = '1', stellvertreter2_id = '1' WHERE id = ?").run(eigen);
    const job = getJobById(db, jobId);
    db.exec('BEGIN');
    markJobAufgesplittet(db, jobId);
    const ergebnis = erzeugeTeilJobs(db, {
      job,
      teile: [{ konto: getKontoById(db, eigen), betrag: '10.00', interessenskonflikt: false, position: null, pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, belegSeitenzahl: null }],
      konten: listKontenForPerson(db, '1'),
      person: getPersonById(db, '1'),
      ip: '::1',
      begruendung: '',
      fremdKontoModus: 'pool',
      istVertretung: false,
    });
    db.exec('COMMIT');
    const kindId = ergebnis.selbstFreigegeben[0].id;
    if (grund) db.prepare('UPDATE jobs SET freigabe2_eskalationsgrund = ? WHERE id = ?').run(grund, kindId);
    const sent = [];
    const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, publicBaseUrl: 'https://portal.example.org' };
    await benachrichtigeNachAufsplitten(db, { async sendMail(mail) { sent.push(mail); } }, config, { job, ergebnis, person: getPersonById(db, '1') });
    const mail = sent.find((m) => m.to === 'sa@example.org');
    assert.ok(mail);
    assert.match(mail.text, muster);
    assert.doesNotMatch(mail.text, nichtMuster);
    db.close();
  });
}
