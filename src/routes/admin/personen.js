// Admin → Personen (`/admin/personen`, Recht `personen_einsehen`, docs/auth-und-rechte.md): Liste der Personen mit Rolle (aus ChurchTools-Gruppen), Status, effektiven Rechten samt Herkunft; Einzelrechte vergibt nur, wer `gruppenrechte_verwalten` hat.

import { Router } from 'express';
import { listAllPersons, getPersonById } from '../../db/personenRepo.js';
import { personHasRole } from '../../middleware/roles.js';
import { listBerechtigungenForPerson, setBerechtigungenForPerson } from '../../db/personBerechtigungenRepo.js';
import { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS, personHasPermission, requirePermission, ermittleRechteMitHerkunft } from '../../middleware/permissions.js';
import { FESTE_RECHTE } from '../../services/berechtigungKatalog.js';
import { personName } from '../../services/auditLog.js';

const GRUPPEN_LABEL = { superadmin: 'Superadmin', manager: 'Manager', buchhaltung: 'Buchhaltung' };

// Effektive Rechte einer Person in Katalog-Reihenfolge, je mit den Quellen ("direkt", "über Gruppe X").
// (Siehe Kommentar oben.)
function rechteMitHerkunft(db, config, person) {
  const herkunft = ermittleRechteMitHerkunft(db, config, person);
  return [...GRANTABLE_BERECHTIGUNGEN, ...FESTE_RECHTE]
    .filter((recht) => herkunft.has(recht))
    .map((recht) => {
      const { gruppen, direkt } = herkunft.get(recht);
      return {
        recht,
        label: BERECHTIGUNG_LABELS[recht],
        gruppen: gruppen.map((g) => GRUPPEN_LABEL[g]),
        quellen: [...gruppen.map((g) => `über Gruppe ${GRUPPEN_LABEL[g]}`), ...(direkt ? ['direkt'] : [])],
      };
    });
}

// Höchste Rolle der Person für die Anzeige (Superadmin > Manager > Buchhaltung).
function rolleVon(person, config) {
  if (personHasRole(person, config, 'superadmin')) return 'Superadmin';
  if (personHasRole(person, config, 'manager')) return 'Manager';
  return 'Benutzer';
}

export function createPersonenRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // GET /admin/personen – Liste mit Warnhinweisen (z. B. nicht mehr auflösbar, Konto-Person nach Gruppenaustritt).
  router.get('/', (req, res) => {
    const bearbeitbar = personHasPermission(db, config, req.currentPerson, 'gruppenrechte_verwalten');
    const personen = listAllPersons(db).map((p) => ({
      ...p,
      rolle: rolleVon(p, config),
      berechtigungen: listBerechtigungenForPerson(db, p.churchtools_person_id),
      rechteHerkunft: rechteMitHerkunft(db, config, p),
      ferienmodusStellvertreterName: p.ferienmodus_stellvertreter_id ? personName(db, p.ferienmodus_stellvertreter_id) : null,
    }));
    res.render('admin/personen-liste', {
      personen,
      bearbeitbar,
      grantableBerechtigungen: GRANTABLE_BERECHTIGUNGEN,
      berechtigungLabels: BERECHTIGUNG_LABELS,
    });
  });

  // POST /admin/personen/:id/berechtigungen – ersetzt die Einzelrechte einer Person (Recht `gruppenrechte_verwalten`).
  router.post('/:id/berechtigungen', csrfProtection, requirePermission(db, config, 'gruppenrechte_verwalten'), (req, res) => {
    if (!getPersonById(db, req.params.id)) {
      return res.status(404).render('error', { message: 'Person nicht gefunden.' });
    }
    // Ein vor der Umbenennung geladenes Formular sendet noch 'debitoren_verwalten'; ohne Abbildung
    // wuerde das Recht beim Speichern still entzogen (docs/kreditoren-statt-debitoren.md).
    const angefordert = [].concat(req.body.berechtigungen || []).map((b) => (b === 'debitoren_verwalten' ? 'kreditoren_verwalten' : b));
    const gueltig = [...new Set(angefordert.filter((b) => GRANTABLE_BERECHTIGUNGEN.includes(b)))];
    // Die Tabelle person_berechtigungen wird bereits per Trigger auditiert (db/securitySchema.js).
    setBerechtigungenForPerson(db, req.params.id, gueltig);
    res.redirect('/admin/personen');
  });

  return router;
}
