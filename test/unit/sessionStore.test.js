import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { SqliteSessionStore } from '../../src/db/sessionStore.js';

test('set/get round-trips a session', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteSessionStore(db);
  const session = { personId: '42', cookie: { expires: new Date(Date.now() + 60000) } };

  store.set('sid-1', session, (err) => {
    assert.equal(err, null);
    store.get('sid-1', (err2, loaded) => {
      assert.equal(err2, null);
      assert.equal(loaded.personId, '42');
      db.close();
    });
  });
});

test('get returns null for an expired session and deletes it', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteSessionStore(db);
  const expired = { personId: '1', cookie: { expires: new Date(Date.now() - 1000) } };

  store.set('sid-2', expired, () => {
    store.get('sid-2', (err, loaded) => {
      assert.equal(err, null);
      assert.equal(loaded, null);
      const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get('sid-2');
      assert.equal(row, undefined);
      db.close();
    });
  });
});

test('destroy removes the session', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteSessionStore(db);
  const session = { personId: '1', cookie: { expires: new Date(Date.now() + 60000) } };

  store.set('sid-3', session, () => {
    store.destroy('sid-3', (err) => {
      assert.equal(err, null);
      const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get('sid-3');
      assert.equal(row, undefined);
      db.close();
    });
  });
});
