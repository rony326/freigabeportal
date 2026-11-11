// Zusatzempfänger von Benachrichtigungen (admin_config, eine Zeile pro Ziel): Prüfung beim
// Speichern und lesbare Anzeige. Aufgelöst werden die Zeilen beim Versand von
// resolveEmpfaenger (services/notify.js).
import { getPersonById, listActivePersonsInGroup } from '../db/personenRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Länge begrenzen, bevor das Muster läuft: so bleibt die Prüfung auch bei sehr langer Eingabe schnell.
const EMAIL_MAX_LAENGE = 320;
const PERSON_PREFIX = 'person:';
// Beide Gruppen-Tokens sind überall erlaubt; resolveEmpfaenger löst beide auf.
const GRUPPEN = { 'gruppe:buchhaltung': 'Gruppe Buchhaltung', 'gruppe:admin': 'Gruppe Admin' };
const GRUPPE_TOKENS = Object.keys(GRUPPEN);
export const EMPFAENGER_GRUPPEN = Object.freeze({ ...GRUPPEN });

const kuerze = (zeile) => (zeile.length > 80 ? `${zeile.slice(0, 80)}…` : zeile);

export function empfaengerZeilen(value) {
  return String(value ?? '')
    .split(/\r?\n|\r/)
    .map((zeile) => zeile.trim())
    .filter(Boolean);
}

// Zeilen: "gruppe:..."-Token, "person:<churchtools_person_id>" (nur mit db; die Person muss existieren,
// aktiv oder nicht) oder eine E-Mail-Adresse. leerErlaubt: leer = Default des Aufrufers.
export function validateEmpfaengerListe(value, label, errors, { db = null, leerErlaubt = false } = {}) {
  const zeilen = empfaengerZeilen(value);
  if (zeilen.length === 0) {
    if (leerErlaubt) return;
    errors.push(`${label} braucht mindestens ein Ziel.`);
    return;
  }
  for (const zeile of zeilen) {
    if (zeile.startsWith(PERSON_PREFIX)) {
      if (!db) {
        errors.push(`${label}: Personen-Einträge ("person:<id>") sind hier nicht möglich.`);
      } else if (!getPersonById(db, zeile.slice(PERSON_PREFIX.length).trim())) {
        errors.push(`${label}: unbekannte Person in "${kuerze(zeile)}".`);
      }
      continue;
    }
    if (!GRUPPE_TOKENS.includes(zeile) && !(zeile.length <= EMAIL_MAX_LAENGE && EMAIL_PATTERN.test(zeile))) {
      errors.push(`${label}: "${kuerze(zeile)}" ist weder eine gültige E-Mail-Adresse noch "${GRUPPE_TOKENS.join('"/"')}".`);
    }
  }
}

// Lesbare Liste für die Admin-Seite: Gruppe → "Gruppe Buchhaltung", Person → "Vorname Nachname"
// (inaktiv bzw. unbekannt markiert), sonst die Adresse.
export function empfaengerAnzeige(db, value) {
  return empfaengerZeilen(value).map((zeile) => {
    if (GRUPPEN[zeile]) return { art: 'gruppe', label: GRUPPEN[zeile], inaktiv: false, unbekannt: false };
    if (zeile.startsWith(PERSON_PREFIX)) {
      const id = zeile.slice(PERSON_PREFIX.length).trim();
      const person = getPersonById(db, id);
      if (!person) return { art: 'person', label: `Person ${id}`, inaktiv: false, unbekannt: true };
      return { art: 'person', label: `${person.vorname} ${person.nachname}`.trim(), inaktiv: !person.aktiv, unbekannt: false };
    }
    return { art: 'mail', label: zeile, inaktiv: false, unbekannt: false };
  });
}

// Adressen, die einer aktiven Person mit Admin-Rechten gehören (die Revision soll unabhängig sein).
export function adminAdressen(db, config, adressen) {
  const groupId = config?.churchtools?.groupIdAdmin;
  if (!groupId) return [];
  const adminMails = new Set(listActivePersonsInGroup(db, groupId).map((p) => (p.email ?? '').toLowerCase()).filter(Boolean));
  return adressen.filter((a) => adminMails.has(a.toLowerCase()));
}
