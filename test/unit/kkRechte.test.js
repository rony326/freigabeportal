import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKreditkarte, getKreditkarteById, setErfasser, setKreditkarteAktiv } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg, getKkBelegById, verwerfeKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { createJob, markiereJobAlsKkAbrechnung } from '../../src/db/jobsRepo.js';
import { darfAufKarteErfassen, listErfassbareKarten, darfBelegBearbeiten, darfBelegSehen, zeigeKreditkartenBereich } from '../../src/services/kkRechte.js';

const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: id === '4' ? ['20'] : [] });
  const offen = createKreditkarte(db, { bezeichnung: 'Offen', verantwortlichId: '1', erfassungOffen: true });
  const zu = createKreditkarte(db, { bezeichnung: 'Zu', verantwortlichId: '1', erfassungOffen: false });
  setErfasser(db, zu, ['2']);
  return { db, offen, zu };
}

test('Modus A: everyone may upload; Modus B: only the list and the responsible person; inactive cards: nobody', () => {
  const { db, offen, zu } = setup();
  assert.equal(darfAufKarteErfassen(db, getKreditkarteById(db, offen), '3'), true);
  assert.equal(darfAufKarteErfassen(db, getKreditkarteById(db, zu), '2'), true);
  assert.equal(darfAufKarteErfassen(db, getKreditkarteById(db, zu), '1'), true);
  assert.equal(darfAufKarteErfassen(db, getKreditkarteById(db, zu), '3'), false);
  setKreditkarteAktiv(db, offen, false);
  assert.equal(darfAufKarteErfassen(db, getKreditkarteById(db, offen), '3'), false);
  assert.deepEqual(listErfassbareKarten(db, '3').map((k) => k.bezeichnung), []);
  assert.deepEqual(listErfassbareKarten(db, '2').map((k) => k.bezeichnung), ['Zu']);
  db.close();
});

test('darfBelegBearbeiten: uploader, buyer and responsible person, only while offen/entwurf', () => {
  const { db, offen } = setup();
  const id = createKkBeleg(db, { kreditkarteId: offen, hochgeladenVon: '2', gekauftVon: '3', quelle: 'web', pdfPfad: '/tmp/x.pdf', betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x', status: 'offen' });
  for (const [personId, erwartet] of [['1', true], ['2', true], ['3', true], ['4', false]]) {
    assert.equal(darfBelegBearbeiten(db, getKkBelegById(db, id), personId), erwartet, `Person ${personId}`);
  }
  verwerfeKkBeleg(db, id, { personId: '2', grund: 'x' });
  assert.equal(darfBelegBearbeiten(db, getKkBelegById(db, id), '2'), false);
  db.close();
});

test('darfBelegSehen: editors, superadmin, and whoever currently holds a marked statement of that card', () => {
  const { db, offen } = setup();
  upsertPerson(db, { id: '5', vorname: 'Buch', nachname: 'Halter', email: 'p5@example.org', gruppen: [] });
  const id = createKkBeleg(db, { kreditkarteId: offen, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: '/tmp/x.pdf', betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x', status: 'offen' });
  const beleg = getKkBelegById(db, id);
  assert.equal(darfBelegSehen(db, config, beleg, getPersonById(db, '2')), true);
  assert.equal(darfBelegSehen(db, config, beleg, getPersonById(db, '4')), true); // superadmin
  assert.equal(darfBelegSehen(db, config, beleg, getPersonById(db, '5')), false);
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  markiereJobAlsKkAbrechnung(db, jobId, { kreditkarteId: offen, verantwortlichId: '5', ausStatus: 'unzugewiesen' });
  assert.equal(darfBelegSehen(db, config, beleg, getPersonById(db, '5')), true);
  db.close();
});

test('zeigeKreditkartenBereich is true for uploaders, responsible persons and owners of receipts', () => {
  const { db, zu } = setup();
  setKreditkarteAktiv(db, 1, false); // the open card
  assert.equal(zeigeKreditkartenBereich(db, '1'), true); // responsible for "Zu"
  assert.equal(zeigeKreditkartenBereich(db, '2'), true); // on the list of "Zu"
  assert.equal(zeigeKreditkartenBereich(db, '3'), false);
  createKkBeleg(db, { kreditkarteId: zu, hochgeladenVon: '2', gekauftVon: '3', quelle: 'web', pdfPfad: '/tmp/x.pdf', betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x', status: 'offen' });
  assert.equal(zeigeKreditkartenBereich(db, '3'), true);
  db.close();
});
