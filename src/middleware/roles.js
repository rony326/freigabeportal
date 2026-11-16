// Rollen und Zugriffssperren: lädt die angemeldete Person aus der Session und stellt die einfachen
// Guards (`requireLogin`, `requireRole`, `requireAnyRole`) bereit. Rolle = Mitgliedschaft in einer
// ChurchTools-Gruppe, deren ID in der Konfiguration steht (`CT_GROUP_ID_*`). Feinere Rechte:
// middleware/permissions.js. Alle Verweigerungen laufen über `verweigere*` ins Zugriffs-Audit.

import { GRUPPEN } from '../services/berechtigungKatalog.js';
import { getPersonById } from '../db/personenRepo.js';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';
import { BEISPIELPERSONEN } from '../services/testmodus/beispieldaten.js';
import { sichereRueckkehr, erwartetHtml, erwartetJson } from '../utils/rueckkehrZiel.js';

// Text der 401-Seite und der JSON-Antwort. Eine abgelaufene Sitzung (8 Stunden ab Login, app.js) ist von aussen nicht
// von "nie angemeldet" zu unterscheiden; die Meldung sagt deshalb beides und was mit Eingaben geschieht.
export const NICHT_ANGEMELDET_TITEL = 'Bitte melde dich an';
export const NICHT_ANGEMELDET_MELDUNG = 'Du bist nicht angemeldet, oder deine Anmeldung ist abgelaufen (sie gilt aus Sicherheitsgründen 8 Stunden). Eingaben in einem Formular, das du gerade abgeschickt hast, wurden nicht gespeichert: Nach dem Anmelden musst du sie noch einmal erfassen.';
// Wie oben, für die CSRF-Fehlerseite (app.js), wenn dabei keine Anmeldung mehr besteht.
export const ANMELDUNG_ABGELAUFEN_MELDUNG = 'Deine Anmeldung ist abgelaufen. Deshalb ist die Sicherheitsprüfung fehlgeschlagen und deine Eingaben wurden nicht gespeichert. Bitte melde dich neu an und gib sie noch einmal ein.';

// Protokolliert (fail-safe) und verweigert. Die Entscheidung ist bereits gefallen, bevor hier
// irgendetwas protokolliert wird; ein Protokollfehler aendert weder Status noch Antwort.
// 401-Antwort + Zugriffs-Audit `nicht_angemeldet`. Drei Fälle:
// - fetch-/Maschinenaufruf (erwartetJson): 401 mit JSON, wie bisher ohne Umleitung.
// - Browser-Seitenaufruf (GET mit Accept text/html) ohne jede Sitzung: das Ziel wird in der Sitzung gemerkt und zur Anmeldung
//   umgeleitet; /auth/callback führt nach dem Login dorthin zurück. Nur sichere eigene Seitenpfade (utils/rueckkehrZiel.js).
//   Eine Sitzung MIT Person (z. B. deaktiviert) wird nie umgeleitet, sonst entstünde eine Schleife Login -> Seite -> Login.
// - alles andere (POST, Datei-/Download-Ziele): 401-Seite mit Knopf «Anmelden», ohne Umleitung und ohne Merken.
export function verweigereNichtAngemeldet(req, res) {
  meldeZugriffVerweigert(req, { grund: 'nicht_angemeldet', status: 401 });
  if (erwartetJson(req)) return res.status(401).json({ error: 'Bitte melde dich an, um fortzufahren.' });
  if (req.method === 'GET' && erwartetHtml(req) && req.session && !req.session.personId) {
    const ziel = sichereRueckkehr(req.originalUrl);
    if (ziel) {
      req.session.rueckkehr = ziel;
      return res.redirect(302, '/auth/login');
    }
  }
  return res.status(401).render('error', { titel: NICHT_ANGEMELDET_TITEL, message: NICHT_ANGEMELDET_MELDUNG, anmelden: true, hinweisArt: 'warning' });
}

// Ablaufzeitpunkt der Sitzung für die Views (Hinweis kurz vor Ablauf, public/js/sitzungHinweis.js). Das Cookie läuft
// absolut 8 Stunden nach der Anmeldung ab und wird durch Aktivität nicht verlängert (app.js: kein `rolling`).
function setzeSitzungAblauf(req, res) {
  const ablauf = req.session?.cookie?.expires;
  res.locals.sitzungAblauf = ablauf ? new Date(ablauf).toISOString() : null;
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
    setzeSitzungAblauf(req, res);
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
    setzeSitzungAblauf(req, res);
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
