import { Store } from 'express-session';

export class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (new Date(row.expires).getTime() < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, session, callback) {
    try {
      const expires = session.cookie?.expires
        ? new Date(session.cookie.expires).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      this.db
        .prepare(
          'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ' +
            'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
        )
        .run(sid, JSON.stringify(session), expires);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
}
