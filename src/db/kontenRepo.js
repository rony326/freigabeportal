// Konten (Tabelle `konten`): Kontonummer, Bezeichnung und die vier Freigabe-Rollen (Freigeber 1/2 samt
// Stellvertretern) sowie die Buchungsart. Verwaltung: Admin → Konten. Fachlich: docs/rechnungs-workflow.md.

import { getPersonById, listActivePersons } from './personenRepo.js';

// Erlaubte Buchungsarten eines Kontos: nur Rechnungen, nur Gutschriften oder beides.
export const BUCHUNGSARTEN = ['rechnung', 'gutschrift', 'beides'];
export const BUCHUNGSART_LABEL = { rechnung: 'Rechnung', gutschrift: 'Gutschrift', beides: 'Rechnung / Gutschrift' };

// Rechnung -> Konten 'rechnung' und 'beides'; Gutschrift -> 'gutschrift' und 'beides'. Andere Typen
// (z. B. Rapport) und Konten ohne Angabe schränken nicht ein.
// Darf der Vorgangstyp ('rechnung' | 'gutschrift' | andere) auf dieses Konto gebucht werden?
export function kontoErlaubtFuerTyp(konto, typ) {
  if (typ !== 'rechnung' && typ !== 'gutschrift') return true;
  const art = konto?.buchungsart;
  if (!art || art === 'beides') return true;
  return art === typ;
}

// Kontenliste auf die Konten einschränken, die für den Typ erlaubt sind.
export function filterKontenFuerTyp(konten, typ) {
  return konten.filter((konto) => kontoErlaubtFuerTyp(konto, typ));
}

// Die vier Rollen eines Kontos (Feldnamen im Formular) und ihre Anzeigenamen für Fehlermeldungen.
const ROLE_KEYS = ['freigeber1Id', 'stellvertreter1Id', 'freigeber2Id', 'stellvertreter2Id'];
const ROLE_LABELS = {
  freigeber1Id: 'Freigeber 1',
  stellvertreter1Id: 'Stellvertreter 1',
  freigeber2Id: 'Freigeber 2',
  stellvertreter2Id: 'Stellvertreter 2',
};

// `existingRoles` (optional) ist die Besetzung des Kontos vor diesem Speichern. Eine bereits zugewiesene, nicht mehr
// auflösbare Person (Opfer einer ChurchTools-Personenzusammenführung) bleibt erhalten statt abgelehnt zu werden —
// analog zur Behandlung im Sync ("warnen, nicht still Daten verlieren"). Blockiert wird nur eine *neu* zugewiesene,
// nicht auflösbare Person: einen neuen Freigeber zu wählen, dessen Identität sich nicht mehr auflösen lässt, wäre ein
// Eingabefehler der Admin-Person und kein Fall, den der Audit-Verlauf bewahren müsste.
/**
 * Prüft die Rollenbesetzung eines Kontos: alle vier Pflichtfelder, vier verschiedene Personen, alle aktiv.
 * @param {object} db Datenbank
 * @param {object} roles `{freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id}`
 * @param {object} [existingRoles] bisherige Besetzung (siehe Hinweis unten)
 * @returns {string[]} Fehlermeldungen; leer = gültig
 */
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

// @returns {number} id des neuen Kontos (aktiv)
export function createKonto(db, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id, buchungsart = 'beides' }) {
  const result = db
    .prepare(
      `INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv, buchungsart)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id, buchungsart);
  return Number(result.lastInsertRowid);
}

// buchungsart ist optional: fehlt sie, bleibt der gespeicherte Wert.
export function updateKonto(db, id, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id, buchungsart = null }) {
  db.prepare(
    `UPDATE konten SET kontonummer = ?, bezeichnung = ?, freigeber1_id = ?, stellvertreter1_id = ?, freigeber2_id = ?, stellvertreter2_id = ?,
       buchungsart = COALESCE(?, buchungsart)
     WHERE id = ?`
  ).run(kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id, buchungsart, id);
}

// Konten werden nie gelöscht, nur deaktiviert (bestehende Vorgänge verweisen darauf); Rückweg: activateKonto.
export function deactivateKonto(db, id) {
  db.prepare('UPDATE konten SET aktiv = 0 WHERE id = ?').run(id);
}

export function activateKonto(db, id) {
  db.prepare('UPDATE konten SET aktiv = 1 WHERE id = ?').run(id);
}

// @returns {object|null}
export function getKontoById(db, id) {
  return db.prepare('SELECT * FROM konten WHERE id = ?').get(id) ?? null;
}

// Standardmässig nur aktive Konten, nach Kontonummer.
export function listKonten(db, { includeInactive = false } = {}) {
  if (includeInactive) {
    return db.prepare('SELECT * FROM konten ORDER BY kontonummer').all();
  }
  return db.prepare('SELECT * FROM konten WHERE aktiv = 1 ORDER BY kontonummer').all();
}

// Aktive Konten, bei denen die Person Freigeber 1 oder dessen Stellvertreter ist (darf dort kontieren).
export function listKontenForPerson(db, personId) {
  return db
    .prepare('SELECT * FROM konten WHERE aktiv = 1 AND (freigeber1_id = ? OR stellvertreter1_id = ?) ORDER BY kontonummer')
    .all(personId, personId);
}

// Ids aller Personen, die auf einem aktiven Konto in irgendeiner Rolle stehen.
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

// Aktive Personen mit mindestens einer Konto-Rolle (z. B. für Auswahllisten bei der Weiterleitung).
export function listPersonenMitFreigeberRolle(db) {
  const ids = new Set(listKontoReferencedPersonIds(db));
  return listActivePersons(db).filter((person) => ids.has(person.churchtools_person_id));
}

// Aktive Konten, bei denen die Person in einer beliebigen der vier Rollen steht.
export function listKontenForPersonAnyRole(db, personId) {
  return db
    .prepare(
      `SELECT * FROM konten WHERE aktiv = 1
       AND (freigeber1_id = ? OR stellvertreter1_id = ? OR freigeber2_id = ? OR stellvertreter2_id = ?)
       ORDER BY kontonummer`
    )
    .all(personId, personId, personId, personId);
}

// Kandidaten für die selbst gewählte Ferienmodus-Stellvertretung einer Person: alle, die schon eine der vier
// Konto-Rollen auf mindestens einem Konto haben, auf dem auch diese Person eine Rolle hat — verhindert, dass eine
// Vertretung ohne fachlichen Bezug zu den vertretenen Konten gewählt wird.
export function listVertretungsKandidaten(db, personId) {
  const ids = new Set();
  for (const konto of listKontenForPersonAnyRole(db, personId)) {
    ids.add(konto.freigeber1_id);
    ids.add(konto.stellvertreter1_id);
    ids.add(konto.freigeber2_id);
    ids.add(konto.stellvertreter2_id);
  }
  ids.delete(personId);
  return listActivePersons(db).filter((person) => ids.has(person.churchtools_person_id));
}
