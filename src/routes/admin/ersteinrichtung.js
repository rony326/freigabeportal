import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { currentAuditActor } from '../../services/auditContext.js';
import { einrichtungsStand, markiereSchritt, setzeOhneZeitstempel, SCHRITTE } from '../../services/ersteinrichtung.js';
import { pruefeTechnik, testeChurchtools, sendeTestmail, loeseKernjobsAus } from '../../services/einrichtungTests.js';

const KERNJOBS = ['sync-personen', 'pool-erinnerungen', 'mail-zustellung'];
const TAGE_7_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_NAMEN = { 'sync-personen': 'Personen-Abgleich', 'pool-erinnerungen': 'Pool-Erinnerungen', 'mail-zustellung': 'Mail-Zustellung' };

// Für Tests ohne Config-Änderung: expliziter Audit-Eintrag, nie mit Geheimnissen.
function schreibeAudit(db, aktion, nachher) {
  const actor = currentAuditActor();
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, ?, ?, 'ersteinrichtung', 'ersteinrichtung', ?, ?)`).run(new Date().toISOString(), actor.id, actor.name, aktion, JSON.stringify(nachher));
}

export function createErsteinrichtungRouter({ db, config, mailer, statusCache = null, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  // Letzte Testergebnisse nur im Speicher dieser App-Instanz (kein Geheimnis darin).
  const letzte = {};
  const zurueck = (res, id) => {
    statusCache?.leeren();
    res.redirect(`/admin/ersteinrichtung#schritt-${id}`);
  };

  router.get('/', (req, res) => {
    // Technische Prüfung bei jedem Aufruf neu: nur schnelle Dateisystem-Prüfungen, kein ChurchTools.
    const technik = pruefeTechnik(config);
    const stand = einrichtungsStand(db, config, { technik });
    res.render('admin/ersteinrichtung', {
      stand, technik, letzte, kernjobs: KERNJOBS, jobNamen: JOB_NAMEN,
      ohneZeitstempel: getConfigValue(db, 'einrichtung_ohne_zeitstempel') === '1',
      markiert: Object.fromEntries(SCHRITTE.filter((s) => s.manuell).map((s) => [s.id, getConfigValue(db, `einrichtung_markiert_${s.id}`) === '1'])),
      hatEmail: Boolean((req.currentPerson?.email || '').trim()),
    });
  });

  router.post('/technik', csrfProtection, (req, res) => {
    const technik = pruefeTechnik(config);
    schreibeAudit(db, 'test_technik', { nichtOk: technik.filter((p) => p.status !== 'ok').length });
    zurueck(res, 'grundlagen');
  });

  router.post('/churchtools-test', csrfProtection, async (req, res) => {
    const ergebnis = await testeChurchtools(config);
    letzte.churchtools = { ...ergebnis, zeit: new Date().toISOString() };
    schreibeAudit(db, 'test_churchtools', { ok: ergebnis.ok });
    zurueck(res, 'churchtools');
  });

  router.post('/testmail', csrfProtection, async (req, res) => {
    const ergebnis = await sendeTestmail(db, mailer, { person: req.currentPerson });
    letzte.testmail = { ...ergebnis, zeit: new Date().toISOString() };
    schreibeAudit(db, 'test_testmail', { status: ergebnis.status });
    zurueck(res, 'mail');
  });

  router.post('/jobs', csrfProtection, async (req, res) => {
    const ergebnis = await loeseKernjobsAus(db, config, mailer, KERNJOBS);
    letzte.jobs = { ergebnis, zeit: new Date().toISOString() };
    schreibeAudit(db, 'test_jobs', { jobs: ergebnis });
    zurueck(res, 'jobs');
  });

  router.post('/markieren', csrfProtection, (req, res) => {
    try {
      markiereSchritt(db, String(req.body.id || ''), req.body.wert === '1');
    } catch {
      return res.status(400).render('error', { message: 'Dieser Schritt kann nicht von Hand markiert werden.' });
    }
    zurueck(res, req.body.id);
  });

  router.post('/ohne-zeitstempel', csrfProtection, (req, res) => {
    setzeOhneZeitstempel(db, req.body.wert === '1');
    zurueck(res, 'zeitstempel');
  });

  // "Später": Hinweis auf dem Dashboard für 7 Tage ausblenden (pro Person).
  router.post('/spaeter', csrfProtection, (req, res) => {
    setConfigValue(db, `einrichtung_spaeter_bis_${req.currentPerson.churchtools_person_id}`, new Date(Date.now() + TAGE_7_MS).toISOString());
    res.redirect('/admin');
  });

  return router;
}
