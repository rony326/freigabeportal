import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg, ordneKkBelegZu } from '../../src/db/kkBelegeRepo.js';
import { kkHinweisFuerJob } from '../../src/services/kkStempel.js';

test('kkHinweisFuerJob covers Eigenbeleg, fee, linked receipt and plain jobs', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Anna', nachname: 'Kauf', email: 'a@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Ben', nachname: 'Erfass', email: 'b@example.org', gruppen: [] });
  const karte = createKreditkarte(db, { bezeichnung: 'Visa', verantwortlichId: '1', erfassungOffen: true });
  db.prepare("INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad) VALUES ('x', 'scanner', 'a.pdf', '/tmp/a.pdf')").run();
  const beleg = createKkBeleg(db, { kreditkarteId: karte, hochgeladenVon: '2', gekauftVon: '1', quelle: 'web', pdfPfad: '/tmp/b.pdf', betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x', status: 'offen' });
  ordneKkBelegZu(db, beleg, { kreditkarteId: karte, jobId: 1 });
  assert.equal(kkHinweisFuerJob(db, { id: 1, kk_eigenbeleg_grund: null }), 'Kreditkartenbeleg: gekauft von Anna Kauf, erfasst von Ben Erfass');
  assert.equal(kkHinweisFuerJob(db, { id: 99, kk_eigenbeleg_grund: 'Beleg verloren' }), 'Ohne Beleg: Beleg verloren');
  assert.equal(kkHinweisFuerJob(db, { id: 99, kk_eigenbeleg_grund: 'Gebühr/Zins' }), 'Gebühr/Zins (ohne Beleg)');
  assert.equal(kkHinweisFuerJob(db, { id: 99, kk_eigenbeleg_grund: null }), null);
  db.close();
});
