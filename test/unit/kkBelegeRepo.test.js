import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import {
  createKkBeleg, getKkBelegById, updateKkBelegDaten, verwerfeKkBeleg, ordneKkBelegZu,
  listOffeneKkBelegeFuerKarte, listKkBelegeFuerPerson, listOffeneKkBelegeFuerVerantwortlich,
  getKkBelegByJobId, logKkBelegEreignis, ersetzeKkBelegDatei,
} from '../../src/db/kkBelegeRepo.js';

function setup() {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  const karteId = createKreditkarte(db, { bezeichnung: 'Visa', verantwortlichId: '1', erfassungOffen: true });
  db.prepare("INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad) VALUES ('2026-09-27', 'scanner', 'a.pdf', '/tmp/a.pdf')").run();
  return { db, karteId };
}

function neuerBeleg(db, karteId, overrides = {}) {
  return createKkBeleg(db, {
    kreditkarteId: karteId, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: '/tmp/b.pdf', thumbnailPfad: null,
    betrag: '12.50', waehrung: 'CHF', kaufdatum: '2026-09-01', beschreibung: 'Zugticket', kontoId: null, status: 'offen', ...overrides,
  });
}

test('createKkBeleg + getKkBelegById roundtrip', () => {
  const { db, karteId } = setup();
  const id = neuerBeleg(db, karteId);
  const b = getKkBelegById(db, id);
  assert.equal(b.status, 'offen');
  assert.equal(b.betrag, '12.50');
  assert.equal(b.gekauft_von, '2');
  assert.ok(b.hochgeladen_am);
  db.close();
});

test('updateKkBelegDaten and ersetzeKkBelegDatei only work while offen or entwurf', () => {
  const { db, karteId } = setup();
  const id = neuerBeleg(db, karteId);
  assert.equal(updateKkBelegDaten(db, id, { kreditkarteId: karteId, betrag: '13.00', kaufdatum: '2026-09-02', beschreibung: 'X', kontoId: null, gekauftVon: '3' }), true);
  assert.equal(getKkBelegById(db, id).gekauft_von, '3');
  assert.equal(ersetzeKkBelegDatei(db, id, { pdfPfad: '/tmp/neu.pdf', thumbnailPfad: null }), true);
  verwerfeKkBeleg(db, id, { personId: '2', grund: 'doppelt' });
  assert.equal(updateKkBelegDaten(db, id, { kreditkarteId: karteId, betrag: '1.00', kaufdatum: '2026-09-02', beschreibung: 'Y', kontoId: null, gekauftVon: '2' }), false);
  assert.equal(ersetzeKkBelegDatei(db, id, { pdfPfad: '/tmp/x.pdf', thumbnailPfad: null }), false);
  db.close();
});

test('verwerfeKkBeleg sets grund/von/am and refuses a second time', () => {
  const { db, karteId } = setup();
  const id = neuerBeleg(db, karteId);
  assert.equal(verwerfeKkBeleg(db, id, { personId: '2', grund: 'privat' }), true);
  const b = getKkBelegById(db, id);
  assert.equal(b.status, 'verworfen');
  assert.equal(b.verworfen_grund, 'privat');
  assert.equal(b.verworfen_von, '2');
  assert.equal(verwerfeKkBeleg(db, id, { personId: '2', grund: 'nochmal' }), false);
  db.close();
});

test('ordneKkBelegZu only succeeds once, and only for an offen Beleg of that card', () => {
  const { db, karteId } = setup();
  const andereKarte = createKreditkarte(db, { bezeichnung: 'Master', verantwortlichId: '1', erfassungOffen: true });
  const id = neuerBeleg(db, karteId);
  assert.equal(ordneKkBelegZu(db, id, { kreditkarteId: andereKarte, jobId: 1 }), false);
  assert.equal(ordneKkBelegZu(db, id, { kreditkarteId: karteId, jobId: 1 }), true);
  assert.equal(ordneKkBelegZu(db, id, { kreditkarteId: karteId, jobId: 1 }), false);
  assert.equal(getKkBelegByJobId(db, 1).id, id);
  db.close();
});

test('list functions filter by status, person and responsible person', () => {
  const { db, karteId } = setup();
  const a = neuerBeleg(db, karteId, { kaufdatum: '2026-09-05' });
  const b = neuerBeleg(db, karteId, { kaufdatum: '2026-09-01', hochgeladenVon: '3', gekauftVon: '2' });
  const c = neuerBeleg(db, karteId);
  verwerfeKkBeleg(db, c, { personId: '2', grund: 'x' });
  assert.deepEqual(listOffeneKkBelegeFuerKarte(db, karteId).map((r) => r.id), [b, a]);
  assert.deepEqual(listKkBelegeFuerPerson(db, '3').map((r) => r.id), [b]);
  assert.equal(listKkBelegeFuerPerson(db, '2').length, 3);
  const fuerVerantwortlich = listOffeneKkBelegeFuerVerantwortlich(db, '1');
  assert.deepEqual(fuerVerantwortlich.map((r) => r.id).sort(), [a, b].sort());
  assert.equal(fuerVerantwortlich[0].karte_bezeichnung, 'Visa');
  db.close();
});

test('logKkBelegEreignis writes an event row, person_id may be NULL for the system', () => {
  const { db, karteId } = setup();
  const id = neuerBeleg(db, karteId);
  logKkBelegEreignis(db, { belegId: id, personId: '2', aktion: 'kk_beleg_erfasst', kommentar: null });
  logKkBelegEreignis(db, { belegId: id, personId: null, aktion: 'kk_beleg_datei_geloescht', kommentar: 'Frist' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kk_beleg_ereignisse WHERE beleg_id = ?').get(id).n, 2);
  db.close();
});
