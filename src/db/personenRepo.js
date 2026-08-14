export function upsertPerson(db, person) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO personen (churchtools_person_id, vorname, nachname, email, aktiv, gruppen, last_synced_at, last_login_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(churchtools_person_id) DO UPDATE SET
       vorname = excluded.vorname,
       nachname = excluded.nachname,
       email = excluded.email,
       aktiv = 1,
       gruppen = excluded.gruppen,
       ct_person_unresolved = 0,
       last_synced_at = excluded.last_synced_at,
       last_login_at = COALESCE(excluded.last_login_at, personen.last_login_at)`
  ).run(
    person.id,
    person.vorname,
    person.nachname,
    person.email,
    JSON.stringify(person.gruppen),
    now,
    person.loggedInNow ? now : null
  );
}

export function getPersonById(db, id) {
  const row = db.prepare('SELECT * FROM personen WHERE churchtools_person_id = ?').get(id);
  if (!row) return null;
  return { ...row, gruppen: JSON.parse(row.gruppen), aktiv: Boolean(row.aktiv), ct_person_unresolved: Boolean(row.ct_person_unresolved) };
}

export function getAllActivePersonIds(db) {
  return db.prepare('SELECT churchtools_person_id FROM personen WHERE aktiv = 1').all().map((r) => r.churchtools_person_id);
}

export function deactivatePerson(db, id) {
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run(id);
}

export function markUnresolved(db, id) {
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run(id);
}

export function personExists(db, id) {
  return db.prepare('SELECT 1 FROM personen WHERE churchtools_person_id = ?').get(id) != null;
}

export function listActivePersons(db) {
  return db
    .prepare('SELECT churchtools_person_id, vorname, nachname, email FROM personen WHERE aktiv = 1 ORDER BY nachname, vorname')
    .all();
}

export function listAllPersons(db) {
  return db.prepare('SELECT * FROM personen ORDER BY aktiv DESC, nachname, vorname').all();
}
