import { Router } from 'express';
import { listActivePersons, getPersonById } from '../db/personenRepo.js';
import { personHasPermission } from '../middleware/permissions.js';
import { sendNotification } from '../services/notify.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

const MAX_BESCHREIBUNG = 2000;
// Wie in admin/betrieb.js: UUID-Präfix oder volle UUID.
const FEHLER_ID_MUSTER = /^[0-9a-f][0-9a-f-]{7,63}$/i;

// Referer-Pfad ohne Query, nur wenn er zum eigenen Portal gehört.
function seiteAusReferer(req, config) {
  const referer = req.get('referer');
  if (!referer || !config.publicBaseUrl) return null;
  try {
    const url = new URL(referer);
    if (url.origin !== new URL(config.publicBaseUrl).origin) return null;
    return url.pathname.slice(0, 500);
  } catch {
    return null;
  }
}

// Verknüpfung nur bei genau einem Treffer, der der meldenden Person gehört (oder keiner Person).
function findeFehlerRequestId(db, fehlerId, personId) {
  if (typeof fehlerId !== 'string' || !FEHLER_ID_MUSTER.test(fehlerId)) return null;
  const treffer = db
    .prepare("SELECT request_id, person_id FROM betrieb_fehler WHERE request_id LIKE ? ESCAPE '\\' LIMIT 2")
    .all(`${fehlerId.toLowerCase()}%`);
  if (treffer.length !== 1) return null;
  const { request_id: requestId, person_id: fehlerPerson } = treffer[0];
  return fehlerPerson == null || fehlerPerson === personId ? requestId : null;
}

export function createFehlerMeldenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    const fehlerId = typeof req.query.fehler === 'string' && FEHLER_ID_MUSTER.test(req.query.fehler) ? req.query.fehler.slice(0, 8) : '';
    res.render('fehler-melden', { gesendet: false, fehlerId, beschreibung: '', fehlerText: null });
  });

  router.post('/', csrfProtection, async (req, res) => {
    const person = req.currentPerson;
    const personId = person.churchtools_person_id;
    const fehlerId = typeof req.body.fehlerId === 'string' ? req.body.fehlerId.trim() : '';
    const beschreibung = typeof req.body.beschreibung === 'string' ? req.body.beschreibung.trim() : '';

    if (beschreibung.length > MAX_BESCHREIBUNG) {
      return res.status(400).render('fehler-melden', {
        gesendet: false, fehlerId, beschreibung, fehlerText: `Die Beschreibung darf höchstens ${MAX_BESCHREIBUNG} Zeichen lang sein.`,
      });
    }

    const requestId = findeFehlerRequestId(db, fehlerId, personId);
    const seite = seiteAusReferer(req, config);
    const userAgent = (req.get('user-agent') || '').slice(0, 500) || null;
    const meldungId = db
      .prepare('INSERT INTO betrieb_fehlermeldungen (zeitpunkt, person_id, request_id, beschreibung, seite, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), personId, requestId, beschreibung || null, seite, userAgent).lastInsertRowid;

    // Mails dürfen die Dankesseite nie verhindern.
    try {
      const variablen = {
        meldendePerson: `${person.vorname} ${person.nachname}`,
        seite: seite || 'unbekannt',
        fehlerId: requestId ? requestId.slice(0, 8) : 'keine',
        beschreibung: beschreibung || '(keine Beschreibung)',
        link: `${config.publicBaseUrl}/admin/betrieb/meldungen/${meldungId}`,
        portalName: getConfigValue(db, 'seiten_titel') || 'Freigabeportal',
      };
      for (const kandidat of listActivePersons(db)) {
        const voll = getPersonById(db, kandidat.churchtools_person_id);
        if (!voll?.email || !personHasPermission(db, config, voll, 'betrieb_einsehen')) continue;
        await sendNotification(db, mailer, { to: voll.email, typ: 'fehlermeldung', jobId: null, variablen });
      }
    } catch (err) {
      console.error('Fehlermeldung: Benachrichtigung fehlgeschlagen', err);
    }

    res.render('fehler-melden', { gesendet: true, fehlerId: '', beschreibung: '', fehlerText: null });
  });

  return router;
}
