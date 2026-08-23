export function listBerechtigungenForPerson(db, personId) {
  return db
    .prepare('SELECT berechtigung FROM person_berechtigungen WHERE person_id = ?')
    .all(personId)
    .map((row) => row.berechtigung);
}

export function setBerechtigungenForPerson(db, personId, berechtigungen) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM person_berechtigungen WHERE person_id = ?').run(personId);
    const insert = db.prepare('INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES (?, ?)');
    for (const berechtigung of berechtigungen) {
      insert.run(personId, berechtigung);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function personHasBerechtigung(db, personId, berechtigung) {
  return db.prepare('SELECT 1 FROM person_berechtigungen WHERE person_id = ? AND berechtigung = ?').get(personId, berechtigung) != null;
}
