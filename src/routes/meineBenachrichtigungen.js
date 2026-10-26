import { Router } from 'express';
import { getConfigValue } from '../db/adminConfigRepo.js';
import {
  BENACHRICHTIGUNG_WERTE,
  WOCHENTAG_NAMEN,
  standardBenachrichtigung,
  benachrichtigungFuer,
  digestWochentag,
  setzeBenachrichtigung,
  kuerzesteFristStunden,
  buendelungStunden,
} from '../services/benachrichtigung.js';
import { stelleWartendeSofortZu } from '../services/mailZustellung.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const BEZEICHNUNG = { sofort: 'Sofort', taeglich: 'Täglich', woechentlich: 'Wöchentlich' };

function hatAdresse(person) {
  return String(person.email ?? '').trim() !== '';
}

function zweistellig(wert) {
  return String(Number(wert) || 0).padStart(2, '0');
}

export function createMeineBenachrichtigungenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function render(res, person, { status = 200, zugestellt = 0, flushFehler = false, fehler = null } = {}) {
    const zeit = `${zweistellig(getConfigValue(db, 'mail_batching_stunde'))}:${zweistellig(getConfigValue(db, 'mail_batching_minute'))}`;
    const standard = standardBenachrichtigung(db);
    const wochentag = WOCHENTAG_NAMEN[digestWochentag(db) - 1];
    const wahl = BENACHRICHTIGUNG_WERTE.includes(person.benachrichtigung) ? person.benachrichtigung : 'standard';
    const eigene = wahl === 'standard' ? standard : wahl;
    const adresse = hatAdresse(person);
    // Gemeinsame Adresse: die kürzeste Bündelung aller Personen gilt (benachrichtigungFuer).
    const effektiv = adresse ? benachrichtigungFuer(db, person.email) : eigene;
    const frist = kuerzesteFristStunden(db);
    res.status(status).render('meine-benachrichtigungen', {
      wahl,
      zeit,
      wochentag,
      standardBezeichnung: BEZEICHNUNG[standard],
      standardText: standard === 'sofort' ? 'Sofort' : standard === 'taeglich' ? `Täglich um ${zeit}` : `Wöchentlich am ${wochentag} um ${zeit}`,
      zeigeHinweis: frist != null && buendelungStunden(effektiv) > frist,
      zugestellt,
      flushFehler,
      fehler,
      keineAdresse: !adresse,
      geteilt: adresse && effektiv !== eigene ? BEZEICHNUNG[effektiv] : null,
    });
  }

  router.get('/', (req, res) => {
    const zugestellt = Number.parseInt(req.query.zugestellt, 10);
    render(res, req.currentPerson, { zugestellt: Number.isInteger(zugestellt) && zugestellt > 0 ? zugestellt : 0, flushFehler: req.query.flushFehler === '1' });
  });

  router.post('/', csrfProtection, asyncHandler(async (req, res, next) => {
    try {
      const person = req.currentPerson;
      const eingabe = req.body.benachrichtigung;
      if (eingabe !== 'standard' && !BENACHRICHTIGUNG_WERTE.includes(eingabe)) {
        return render(res, person, { status: 422, fehler: 'Bitte eine der angebotenen Möglichkeiten wählen.' });
      }
      const vorher = benachrichtigungFuer(db, person.email);
      setzeBenachrichtigung(db, person.churchtools_person_id, eingabe === 'standard' ? null : eingabe);

      // Wer auf "sofort" wechselt, soll Wartendes nicht erst am nächsten Digest-Lauf bekommen.
      let zugestellt = 0;
      let flushFehler = false;
      if (hatAdresse(person) && benachrichtigungFuer(db, person.email) === 'sofort') {
        const ergebnis = await stelleWartendeSofortZu(db, config, mailer, person.email, { vorher });
        zugestellt = ergebnis.zugestellt;
        flushFehler = ergebnis.fehlgeschlagen > 0;
      }
      const query = [zugestellt ? `zugestellt=${zugestellt}` : '', flushFehler ? 'flushFehler=1' : ''].filter(Boolean).join('&');
      res.redirect(`/meine-benachrichtigungen${query ? `?${query}` : ''}`);
    } catch (err) {
      next(err);
    }
  }));

  return router;
}
