import { gruppenVon, verweigereNichtAngemeldet, verweigereOhneBerechtigung } from './roles.js';
import { FESTE_RECHTE } from '../services/berechtigungKatalog.js';
import { listGruppenBerechtigungen } from '../db/gruppenBerechtigungenRepo.js';
import { listBerechtigungenForPerson, personHasBerechtigung } from '../db/personBerechtigungenRepo.js';

export { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS } from '../services/berechtigungKatalog.js';

// Effektives Recht = Rechte aller Gruppen der Person (gruppen_berechtigungen) plus ihre Einzelrechte
// (person_berechtigungen). Rein additiv. Das feste Recht (gruppenrechte_verwalten) hängt allein an
// der Superadmin-Gruppe, auch wenn die Tabelle es (z. B. nach einem alten Backup) nicht enthält.
function gruppenRechteVon(db, gruppen) {
  return gruppen.flatMap((gruppe) => listGruppenBerechtigungen(db, gruppe).map((recht) => ({ gruppe, recht })));
}

export function personHasPermission(db, config, person, permission) {
  if (!person) return false;
  const gruppen = gruppenVon(person, config);
  if (FESTE_RECHTE.includes(permission)) return gruppen.includes('superadmin');
  if (gruppen.some((gruppe) => db.prepare('SELECT 1 FROM gruppen_berechtigungen WHERE gruppe = ? AND berechtigung = ?').get(gruppe, permission))) return true;
  return personHasBerechtigung(db, person.churchtools_person_id, permission);
}

// Gleiche Regeln wie personHasPermission, aber Gruppen- und Einzelrechte werden nur einmal (und
// erst bei Bedarf) geladen -- für Stellen, die viele Rechte nacheinander prüfen (Navigation).
export function erstellePermissionPruefer(db, config, person) {
  if (!person) return () => false;
  const gruppen = gruppenVon(person, config);
  let rechte = null;
  return (permission) => {
    if (FESTE_RECHTE.includes(permission)) return gruppen.includes('superadmin');
    rechte ??= new Set([
      ...gruppenRechteVon(db, gruppen).map((r) => r.recht),
      ...listBerechtigungenForPerson(db, person.churchtools_person_id),
    ]);
    return rechte.has(permission);
  };
}

// Nur die Rechte, die die Person effektiv hat, mit ihrer Herkunft: über welche Gruppen und/oder direkt.
export function ermittleRechteMitHerkunft(db, config, person) {
  const ergebnis = new Map();
  if (!person) return ergebnis;
  const gruppen = gruppenVon(person, config);
  const eintrag = (recht) => {
    if (!ergebnis.has(recht)) ergebnis.set(recht, { gruppen: [], direkt: false });
    return ergebnis.get(recht);
  };
  for (const { gruppe, recht } of gruppenRechteVon(db, gruppen)) {
    const e = eintrag(recht);
    if (!e.gruppen.includes(gruppe)) e.gruppen.push(gruppe);
  }
  for (const recht of listBerechtigungenForPerson(db, person.churchtools_person_id)) eintrag(recht).direkt = true;
  if (gruppen.includes('superadmin')) {
    for (const recht of FESTE_RECHTE) {
      const e = eintrag(recht);
      if (!e.gruppen.includes('superadmin')) e.gruppen.push('superadmin');
    }
  }
  return ergebnis;
}

export function hatIrgendeinAdminRecht(db, config, person) {
  return ermittleRechteMitHerkunft(db, config, person).size > 0;
}

export function requirePermission(db, config, permission) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    if (!personHasPermission(db, config, person, permission)) return verweigereOhneBerechtigung(req, res, 'fehlendes_recht', permission);
    next();
  };
}

export function requireAdminAreaAccess(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) return verweigereNichtAngemeldet(req, res);
    if (!hatIrgendeinAdminRecht(db, config, person)) return verweigereOhneBerechtigung(req, res, 'kein_adminbereich');
    next();
  };
}
