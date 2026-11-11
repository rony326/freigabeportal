// Rollen und Zugriffssperren: lädt die angemeldete Person aus der Session und stellt die einfachen
// Guards (`requireLogin`, `requireRole`, `requireAnyRole`) bereit. Rolle = Mitgliedschaft in einer
// ChurchTools-Gruppe, deren ID in der Konfiguration steht (`CT_GROUP_ID_*`). Feinere Rechte:
// middleware/permissions.js. Alle Verweigerungen laufen über `verweigere*` ins Zugriffs-Audit.

import { GRUPPEN } from '../services/berechtigungKatalog.js';
import { getPersonById } from '../db/personenRepo.js';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';
import { BEISPIELPERSONEN } from '../services/testmodus/beispieldaten.js';

// Protokolliert (fail-safe) und verweigert. Die Entscheidung ist bereits gefallen, bevor hier
// irgendetwas protokolliert wird; ein Protokollfehler aendert weder Status noch Antwort.
// 401-Antwort (Fehlerseite) + Zugriffs-Audit `nicht_angemeldet`.
export function verweigereNichtAngemeldet(req, res) {
  meldeZugriffVerweigert(req, { grund: 'nicht_angemeldet', status: 401 });
  return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
}

// 403-Antwort + Zugriffs-Audit mit Grund (`fehlende_rolle`, `fehlendes_recht`, `kein_adminbereich`) und ggf. dem fehlenden Recht.
export function verweigereOhneBerechtigung(req, res, grund, recht = null) {
  meldeZugriffVerweigert(req, { grund, status: 403, recht });
  return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
}

// Setzt `req.currentPerson` (Zeile aus `personen`, inkl. Gruppen) aus `session.personId`; null ohne Anmeldung.
export function loadCurrentPerson(db) {
  return (req, res, next) => {
    if (!req.session.personId) {
      req.currentPerson = null;
      res.locals.currentPerson = null;
      return next();
    }
    req.currentPerson = getPersonById(db, req.session.personId);
    // Als Template-Variable bereitgestellt (analog zu res.locals.branding in middleware/branding.js), damit Views einen
    // Abmelde-Link rendern können, ohne dass jeder Route-Handler die Person einzeln durchreichen muss.
    res.locals.currentPerson = req.currentPerson;
    next();
  };
}

// Test-Instanz: Person = gewählte Beispielperson aus der Spiel-DB, nur bekannte Beispiel-IDs; sonst 403.
export function loadBeispielperson(db) {
  const beispielpersonen = BEISPIELPERSONEN.map((p) => ({ id: p.id, name: `${p.vorname} ${p.nachname}`, rolle: p.rolle }));
  const erlaubt = new Set(beispielpersonen.map((p) => p.id));
  return (req, res, next) => {
    const id = req.session?.testmodus?.personId;
    const person = erlaubt.has(id) ? getPersonById(db, id) : null;
    req.currentPerson = person;
    res.locals.currentPerson = person;
    res.locals.testmodus = { person, beispielpersonen };
    // Die Band-Formulare gehen an die echte App: Token von dort (setzt die Weiche), sonst leer.
    res.locals.testmodusEchterCsrfToken = req.testmodusEchterCsrfToken || '';
    if (!person) return res.status(403).render('error', { message: 'Im Testmodus kannst du nur als Beispielperson handeln.' });
    next();
  };
}

// Rolle → Feld in `config.churchtools`, das die ChurchTools-Gruppen-ID enthält.
const GROUP_ID_KEY_BY_ROLE = {
  buchhaltung: 'groupIdBuchhaltung',
  superadmin: 'groupIdAdmin',
  manager: 'groupIdManager',
};

// Gemeinsam genutzt von requireRole/requireAnyRole (den HTTP-Toren) und loadNavFlags in middleware/nav.js
// (Sichtbarkeit der Menüreiter) — beide brauchen exakt dieselbe Prüfung "ist diese Person in der
// ChurchTools-Gruppe X". Hier ausgelagert, statt sie ein drittes Mal zu duplizieren.
export function personHasRole(person, config, role) {
  if (!person) return false;
  const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
  // groupIdManager ist optional (CT_GROUP_ID_MANAGER ist in env.js nicht Pflicht) — ohne diese Absicherung würde eine
  // nicht konfigurierte Rolle gegen den Text "null"/"undefined" vergleichen, statt einfach niemanden zu enthalten.
  if (!groupId) return false;
  return person.gruppen.includes(String(groupId));
}

// Alle Gruppen (Rollen) einer Person, in der festen Reihenfolge des Katalogs.
export function gruppenVon(person, config) {
  return GRUPPEN.filter((gruppe) => personHasRole(person, config, gruppe));
}

// Guard: genau diese Rolle nötig (sonst 401/403).
export function requireRole(config, role) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    if (!personHasRole(person, config, role)) return verweigereOhneBerechtigung(req, res, 'fehlende_rolle');
    next();
  };
}

// Guard: mindestens eine der Rollen nötig.
export function requireAnyRole(config, roles) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    if (!roles.some((role) => personHasRole(person, config, role))) return verweigereOhneBerechtigung(req, res, 'fehlende_rolle');
    next();
  };
}

// Guard: nur angemeldet und aktiv, keine bestimmte Rolle.
export function requireLogin() {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    next();
  };
}
