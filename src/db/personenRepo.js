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

// Findet die aktive Person zu einer E-Mail-Adresse -- Basis für die Absender-Zuordnung eines per
// Mail eingegangenen Kreditkarten-Belegs (kkBelegEingang.js). Case-insensitiver Vergleich, da
// Mail-Header und die hier gespeicherte Adresse unterschiedlich geschrieben sein können. Teilen sich
// mehrere aktive Personen die Adresse (z.B. Familienadresse), ist die Zuordnung mehrdeutig: null.
export function findActivePersonByEmail(db, email) {
  if (!email) return null;
  const rows = db.prepare('SELECT churchtools_person_id FROM personen WHERE aktiv = 1 AND LOWER(email) = LOWER(?) LIMIT 2').all(email.trim());
  return rows.length === 1 ? getPersonById(db, rows[0].churchtools_person_id) : null;
}

export function countActivePersonsByEmail(db, email) {
  if (!email) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM personen WHERE aktiv = 1 AND LOWER(email) = LOWER(?)').get(email.trim()).n;
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

export function listActivePersonsInGroup(db, groupId) {
  return db
    .prepare('SELECT * FROM personen WHERE aktiv = 1')
    .all()
    .map((row) => ({ ...row, gruppen: JSON.parse(row.gruppen) }))
    .filter((person) => person.gruppen.includes(String(groupId)));
}

export function listAllPersons(db) {
  return db
    .prepare('SELECT * FROM personen ORDER BY aktiv DESC, nachname, vorname')
    .all()
    .map((row) => ({ ...row, gruppen: JSON.parse(row.gruppen) }));
}

export function setFerienmodus(db, personId, { von, bis, stellvertreterId }) {
  db.prepare(
    'UPDATE personen SET ferienmodus_von = ?, ferienmodus_bis = ?, ferienmodus_stellvertreter_id = ? WHERE churchtools_person_id = ?'
  ).run(von, bis, stellvertreterId, personId);
}

export function clearFerienmodus(db, personId) {
  db.prepare(
    'UPDATE personen SET ferienmodus_von = NULL, ferienmodus_bis = NULL, ferienmodus_stellvertreter_id = NULL WHERE churchtools_person_id = ?'
  ).run(personId);
}
