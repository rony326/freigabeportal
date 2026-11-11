// Personen (Tabelle `personen`): lokale Kopie der ChurchTools-Personen, die Zugang zum Portal haben.
// Befüllt vom nächtlichen Sync (services/sync.js) und beim Login (routes/auth.js). `gruppen` ist ein JSON-Array
// der ChurchTools-Gruppen-IDs (daraus ergeben sich die Rollen, middleware/roles.js). `aktiv = 0` heisst: kein Zugang mehr.

/**
 * Legt eine Person an oder aktualisiert sie; reaktiviert sie und setzt "nicht auflösbar" zurück.
 * @param {object} person `{id, vorname, nachname, email, gruppen: string[], loggedInNow?: boolean}`
 */
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
       deaktiviert_am = NULL,
       deaktivierungsgrund = NULL,
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

/** @returns {object|null} Person mit geparstem `gruppen`-Array und Booleans für `aktiv`/`ct_person_unresolved` */
export function getPersonById(db, id) {
  const row = db.prepare('SELECT * FROM personen WHERE churchtools_person_id = ?').get(id);
  if (!row) return null;
  return { ...row, gruppen: JSON.parse(row.gruppen), aktiv: Boolean(row.aktiv), ct_person_unresolved: Boolean(row.ct_person_unresolved) };
}

// Ids aller aktiven Personen (für den Abgleich im Sync).
export function getAllActivePersonIds(db) {
  return db.prepare('SELECT churchtools_person_id FROM personen WHERE aktiv = 1').all().map((r) => r.churchtools_person_id);
}

// Aktive Personen mit Gruppen (schlank, ohne weitere Felder).
export function listActivePersonsMitGruppen(db) {
  return db
    .prepare('SELECT churchtools_person_id, gruppen FROM personen WHERE aktiv = 1')
    .all()
    .map((row) => ({ id: row.churchtools_person_id, gruppen: JSON.parse(row.gruppen) }));
}

// Nur die Gruppenzugehörigkeit nachführen, ohne Profil -- für Personen, deren ChurchTools-Profil
// vorübergehend nicht abrufbar war, deren fehlende Mitgliedschaft aber aus den erfolgreich
// geladenen Gruppenlisten feststeht (services/sync.js). Rollenrechte dürfen nicht an einem
// Profil-Abruffehler hängen bleiben.
export function setPersonGruppen(db, id, gruppen) {
  db.prepare('UPDATE personen SET gruppen = ? WHERE churchtools_person_id = ?').run(JSON.stringify(gruppen), id);
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

// Anzahl aktiver Personen mit dieser Adresse (Prüfung auf Mehrdeutigkeit).
export function countActivePersonsByEmail(db, email) {
  if (!email) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM personen WHERE aktiv = 1 AND LOWER(email) = LOWER(?)').get(email.trim()).n;
}

// grund: warum der Zugang entzogen wurde (z.B. 'churchtools_geloescht'), für die Personenliste.
export function deactivatePerson(db, id, grund = null) {
  db.prepare('UPDATE personen SET aktiv = 0, deaktiviert_am = ?, deaktivierungsgrund = ? WHERE churchtools_person_id = ?').run(new Date().toISOString(), grund, id);
}

// Markiert eine Person als in ChurchTools nicht mehr auflösbar (z. B. nach einer Personen-Zusammenführung).
export function markUnresolved(db, id) {
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run(id);
}

// true, wenn die Person lokal bekannt ist (aktiv oder nicht).
export function personExists(db, id) {
  return db.prepare('SELECT 1 FROM personen WHERE churchtools_person_id = ?').get(id) != null;
}

// Aktive Personen für Auswahllisten (nur Kernfelder), nach Name sortiert.
export function listActivePersons(db) {
  return db
    .prepare('SELECT churchtools_person_id, vorname, nachname, email FROM personen WHERE aktiv = 1 ORDER BY nachname, vorname')
    .all();
}

// Aktive Personen, die in der ChurchTools-Gruppe `groupId` sind.
export function listActivePersonsInGroup(db, groupId) {
  return db
    .prepare('SELECT * FROM personen WHERE aktiv = 1')
    .all()
    .map((row) => ({ ...row, gruppen: JSON.parse(row.gruppen) }))
    .filter((person) => person.gruppen.includes(String(groupId)));
}

// Alle Personen inkl. inaktiver (Admin → Personen), aktive zuerst.
export function listAllPersons(db) {
  return db
    .prepare('SELECT * FROM personen ORDER BY aktiv DESC, nachname, vorname')
    .all()
    .map((row) => ({ ...row, gruppen: JSON.parse(row.gruppen) }));
}

// Trägt Abwesenheit (von/bis, ISO-Datum) und Stellvertreter:in ein; siehe services/vertretung.js.
export function setFerienmodus(db, personId, { von, bis, stellvertreterId }) {
  db.prepare(
    'UPDATE personen SET ferienmodus_von = ?, ferienmodus_bis = ?, ferienmodus_stellvertreter_id = ? WHERE churchtools_person_id = ?'
  ).run(von, bis, stellvertreterId, personId);
}

// Beendet den Ferienmodus (alle drei Felder leeren).
export function clearFerienmodus(db, personId) {
  db.prepare(
    'UPDATE personen SET ferienmodus_von = NULL, ferienmodus_bis = NULL, ferienmodus_stellvertreter_id = NULL WHERE churchtools_person_id = ?'
  ).run(personId);
}
