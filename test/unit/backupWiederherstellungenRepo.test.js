import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { logBackupWiederherstellung, listBackupWiederherstellungen } from '../../src/db/backupWiederherstellungenRepo.js';

test('logBackupWiederherstellung inserts a row and listBackupWiederherstellungen returns it newest first', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: [], loggedInNow: false });

  const id1 = logBackupWiederherstellung(db, { dateiname: 'erstes-backup.zip', wiederhergestelltVon: '1' });
  const id2 = logBackupWiederherstellung(db, { dateiname: 'zweites-backup.zip', wiederhergestelltVon: '1' });

  assert.ok(id2 > id1);
  const eintraege = listBackupWiederherstellungen(db);
  assert.equal(eintraege.length, 2);
  assert.equal(eintraege[0].dateiname, 'zweites-backup.zip', 'newest first');
  assert.equal(eintraege[0].wiederhergestellt_von, '1');
  assert.ok(eintraege[0].zeitpunkt);
  db.close();
});
