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
  return { ...row, gruppen: JSON.parse(row.gruppen), aktiv: Boolean(row.aktiv) };
}
