import { GRUPPEN, GRANTABLE_BERECHTIGUNGEN, FESTE_RECHTE, startwerteFuerGruppe } from '../services/berechtigungKatalog.js';

function pruefeGruppe(gruppe) {
  if (!GRUPPEN.includes(gruppe)) throw new Error(`Unbekannte Gruppe: ${gruppe}`);
}

export function listGruppenBerechtigungen(db, gruppe) {
  return db.prepare('SELECT berechtigung FROM gruppen_berechtigungen WHERE gruppe = ? ORDER BY berechtigung').all(gruppe).map((r) => r.berechtigung);
}

export function listAlleGruppenBerechtigungen(db) {
  const alle = Object.fromEntries(GRUPPEN.map((g) => [g, []]));
  for (const row of db.prepare('SELECT gruppe, berechtigung FROM gruppen_berechtigungen ORDER BY berechtigung').all()) {
    if (alle[row.gruppe]) alle[row.gruppe].push(row.berechtigung);
  }
  return alle;
}

// Ersetzt die Rechte einer Gruppe. Gespeichert werden nur vergebbare Rechte; das feste Recht
// (gruppenrechte_verwalten) steht immer und ausschliesslich bei superadmin.
export function setGruppenBerechtigungen(db, gruppe, berechtigungen) {
  pruefeGruppe(gruppe);
  const gueltig = new Set(berechtigungen.filter((b) => GRANTABLE_BERECHTIGUNGEN.includes(b)));
  if (gruppe === 'superadmin') for (const recht of FESTE_RECHTE) gueltig.add(recht);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM gruppen_berechtigungen WHERE gruppe = ?').run(gruppe);
    const insert = db.prepare('INSERT INTO gruppen_berechtigungen (gruppe, berechtigung) VALUES (?, ?)');
    for (const recht of gueltig) insert.run(gruppe, recht);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Einmalig: Startwerte = Verhalten vor Einführung der Gruppenrechte. Ob schon initialisiert wurde,
// zeigt die Tabelle selbst: Superadmin behält das feste Recht immer, ein leerer Bestand heisst also
// «noch nie gesetzt». (Ein Kennzeichen in admin_config wäre per Trigger auditiert und würde bei
// jeder neuen Datenbank ein Audit-Ereignis erzeugen.)
export function seedGruppenBerechtigungen(db) {
  if (db.prepare('SELECT 1 FROM gruppen_berechtigungen LIMIT 1').get()) return;
  for (const gruppe of GRUPPEN) setGruppenBerechtigungen(db, gruppe, startwerteFuerGruppe(gruppe));
}
