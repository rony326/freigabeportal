import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { logJobLoeschung, listJobLoeschungen } from '../../src/db/jobLoeschungenRepo.js';

test('logJobLoeschung records a deletion, listJobLoeschungen returns newest first', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });

  logJobLoeschung(db, { jobId: 1, dateiname: 'a.pdf', geloeschtVon: '99', begruendung: 'Duplikat' });
  logJobLoeschung(db, { jobId: 2, dateiname: 'b.pdf', geloeschtVon: '99', begruendung: 'Fehlerhaft' });

  const rows = listJobLoeschungen(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].job_id, 2, 'newest entry should come first');
  assert.equal(rows[0].dateiname, 'b.pdf');
  assert.equal(rows[0].begruendung, 'Fehlerhaft');
  assert.equal(rows[1].job_id, 1);
  assert.ok(rows[0].zeitpunkt);
  db.close();
});
