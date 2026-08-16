import { getPersonById } from './personenRepo.js';

const ROLE_KEYS = ['freigeber1Id', 'stellvertreter1Id', 'freigeber2Id', 'stellvertreter2Id'];
const ROLE_LABELS = {
  freigeber1Id: 'Freigeber 1',
  stellvertreter1Id: 'Stellvertreter 1',
  freigeber2Id: 'Freigeber 2',
  stellvertreter2Id: 'Stellvertreter 2',
};

// `existingRoles` (optional) is the Konto's roles before this save, if any — an already-assigned
// unresolved person (a ChurchTools person-merge casualty) is preserved rather than rejected,
// matching the sync's own "warn, don't silently lose data" handling of the same situation.
// Only a *newly* assigned unresolved person is blocked, since assigning a fresh approver whose
// identity can no longer be resolved would be a Portal-Admin data-entry mistake, not a case
// the audit trail needs to preserve.
export function validateKontoRoles(db, roles, existingRoles = {}) {
  const errors = [];

  for (const key of ROLE_KEYS) {
    if (!roles[key]) {
      errors.push(`${ROLE_LABELS[key]} ist ein Pflichtfeld.`);
    }
  }
  if (errors.length > 0) return errors;

  const values = ROLE_KEYS.map((key) => roles[key]);
  if (new Set(values).size !== values.length) {
    errors.push('Freigeber 1, Stellvertreter 1, Freigeber 2 und Stellvertreter 2 müssen vier unterschiedliche Personen sein.');
  }

  for (const key of ROLE_KEYS) {
    const person = getPersonById(db, roles[key]);
    if (!person || !person.aktiv) {
      errors.push(`${ROLE_LABELS[key]}: gewählte Person ist nicht (mehr) aktiv.`);
    } else if (person.ct_person_unresolved && roles[key] !== existingRoles[key]) {
      errors.push(`${ROLE_LABELS[key]}: gewählte Person ist in ChurchTools nicht mehr auflösbar und kann nicht neu zugewiesen werden.`);
    }
  }

  return errors;
}

export function createKonto(db, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id }) {
  const result = db
    .prepare(
      `INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id);
  return Number(result.lastInsertRowid);
}

export function updateKonto(db, id, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id }) {
  db.prepare(
    `UPDATE konten SET kontonummer = ?, bezeichnung = ?, freigeber1_id = ?, stellvertreter1_id = ?, freigeber2_id = ?, stellvertreter2_id = ?
     WHERE id = ?`
  ).run(kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id, id);
}

export function deactivateKonto(db, id) {
  db.prepare('UPDATE konten SET aktiv = 0 WHERE id = ?').run(id);
}

export function getKontoById(db, id) {
  return db.prepare('SELECT * FROM konten WHERE id = ?').get(id) ?? null;
}

export function listKonten(db, { includeInactive = false } = {}) {
  if (includeInactive) {
    return db.prepare('SELECT * FROM konten ORDER BY kontonummer').all();
  }
  return db.prepare('SELECT * FROM konten WHERE aktiv = 1 ORDER BY kontonummer').all();
}

export function listKontenForPerson(db, personId) {
  return db
    .prepare('SELECT * FROM konten WHERE aktiv = 1 AND (freigeber1_id = ? OR stellvertreter1_id = ?) ORDER BY kontonummer')
    .all(personId, personId);
}

export function listKontoReferencedPersonIds(db) {
  const rows = db
    .prepare('SELECT freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id FROM konten WHERE aktiv = 1')
    .all();
  const ids = new Set();
  for (const row of rows) {
    ids.add(row.freigeber1_id);
    ids.add(row.stellvertreter1_id);
    ids.add(row.freigeber2_id);
    ids.add(row.stellvertreter2_id);
  }
  return [...ids];
}
