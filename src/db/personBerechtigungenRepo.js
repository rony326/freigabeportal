// Einzelrechte pro Person (Tabelle `person_berechtigungen`), additiv zu den Gruppenrechten. Verwaltung: Admin → Personen.
// Die Prüfung "hat die Person das Recht?" macht middleware/permissions.js, die diese Funktionen nutzt.

export function listBerechtigungenForPerson(db, personId) {
  return db
    .prepare('SELECT berechtigung FROM person_berechtigungen WHERE person_id = ?')
    .all(personId)
    .map((row) => row.berechtigung);
}

// Ersetzt alle Einzelrechte einer Person atomar. Der CHECK in der Tabelle lässt nur vergebbare Rechte zu.
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
