import { Router } from 'express';
import { BEISPIELPERSONEN } from '../../services/testmodus/beispieldaten.js';

const STANDARD_PERSON = 'test-4'; // Dora Beispiel (Admin)
const PERSONEN = BEISPIELPERSONEN.map((p) => ({ id: p.id, name: `${p.vorname} ${p.nachname}`, rolle: p.rolle }));
const ERLAUBT = new Set(PERSONEN.map((p) => p.id));
const FEHLER_SPIELWIESE = 'Die Spielwiese konnte nicht erstellt werden. Der Testmodus bleibt ausgeschaltet; der echte Betrieb ist nicht betroffen.';

// Ein-/Ausschalten, Personenwechsel und Zurücksetzen landen im echten Audit-Log.
export function schreibeTestmodusAudit(db, person, aktion, nachher = null) {
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, ?, ?, 'testmodus', 'testmodus', ?, ?)`).run(
    new Date().toISOString(), String(person.churchtools_person_id), `${person.vorname} ${person.nachname}`,
    aktion, nachher ? JSON.stringify(nachher) : null);
}

// Echte App, nur Superadmin/Manager (Gate in app.js). Die Test-Instanz liefert steuerung.
export function createTestmodusRouter({ db, steuerung, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  const zeige = (req, res, { status = 200, fehler = null } = {}) => {
    const flag = req.session.testmodus || null;
    res.status(status).render('admin/testmodus', {
      an: Boolean(flag),
      person: flag ? PERSONEN.find((p) => p.id === flag.personId) || null : null,
      personen: PERSONEN,
      fehler,
      zurueckgesetzt: req.query.zurueckgesetzt === '1',
    });
  };

  router.get('/', (req, res) => zeige(req, res));

  router.post('/ein', csrfProtection, async (req, res, next) => {
    try {
      if (!req.session.testmodus) {
        try {
          await steuerung.hole();
        } catch (err) {
          console.error('Testmodus: Spielwiese nicht erstellbar:', err?.message || err);
          return zeige(req, res, { status: 503, fehler: FEHLER_SPIELWIESE });
        }
        req.session.testmodus = { personId: STANDARD_PERSON };
        schreibeTestmodusAudit(db, req.currentPerson, 'eingeschaltet', { personId: STANDARD_PERSON });
      }
      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  router.post('/aus', csrfProtection, (req, res) => {
    if (req.session.testmodus) {
      delete req.session.testmodus;
      schreibeTestmodusAudit(db, req.currentPerson, 'ausgeschaltet');
    }
    res.redirect('/admin/testmodus');
  });

  router.post('/person', csrfProtection, (req, res) => {
    if (!req.session.testmodus) return res.redirect('/admin/testmodus');
    const personId = typeof req.body.personId === 'string' ? req.body.personId : '';
    if (!ERLAUBT.has(personId)) return res.status(400).render('error', { message: 'Unbekannte Beispielperson.' });
    if (req.session.testmodus.personId !== personId) {
      req.session.testmodus = { personId };
      schreibeTestmodusAudit(db, req.currentPerson, 'person_gewechselt', { personId });
    }
    res.redirect('/pool');
  });

  router.post('/zuruecksetzen', csrfProtection, async (req, res, next) => {
    try {
      if (req.session.testmodus && req.body.bestaetigt !== '1') {
        return zeige(req, res, { status: 400, fehler: 'Der Testmodus ist eingeschaltet: Bitte bestätige das Zurücksetzen der Spielwiese.' });
      }
      try {
        await steuerung.zuruecksetzen();
      } catch (err) {
        console.error('Testmodus: Spielwiese nicht erstellbar:', err?.message || err);
        if (req.session.testmodus) {
          delete req.session.testmodus;
          schreibeTestmodusAudit(db, req.currentPerson, 'ausgeschaltet', { anlass: 'spielwiese_fehler' });
        }
        return zeige(req, res, { status: 503, fehler: FEHLER_SPIELWIESE });
      }
      schreibeTestmodusAudit(db, req.currentPerson, 'zurueckgesetzt');
      res.redirect('/admin/testmodus?zurueckgesetzt=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
