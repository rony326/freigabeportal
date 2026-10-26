import { Router } from 'express';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listGeplantMailsGruppiertNachEmpfaenger } from '../db/mailLogRepo.js';
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
import { ladeDigestVorlage, stelleDigestZu } from '../services/mailZustellung.js';

const BEZEICHNUNG = { sofort: 'Sofort', taeglich: 'Täglich', woechentlich: 'Wöchentlich' };

function zweistellig(wert) {
  return String(Number(wert) || 0).padStart(2, '0');
}

export function createMeineBenachrichtigungenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function render(res, person, { status = 200, zugestellt = 0, fehler = null } = {}) {
    const zeit = `${zweistellig(getConfigValue(db, 'mail_batching_stunde'))}:${zweistellig(getConfigValue(db, 'mail_batching_minute'))}`;
    const standard = standardBenachrichtigung(db);
    const wochentag = WOCHENTAG_NAMEN[digestWochentag(db) - 1];
    const wahl = BENACHRICHTIGUNG_WERTE.includes(person.benachrichtigung) ? person.benachrichtigung : 'standard';
    const effektiv = wahl === 'standard' ? standard : wahl;
    const frist = kuerzesteFristStunden(db);
    res.status(status).render('meine-benachrichtigungen', {
      wahl,
      zeit,
      wochentag,
      standardBezeichnung: BEZEICHNUNG[standard],
      standardText: standard === 'sofort' ? 'Sofort' : standard === 'taeglich' ? `Täglich um ${zeit}` : `Wöchentlich am ${wochentag} um ${zeit}`,
      zeigeHinweis: frist != null && buendelungStunden(effektiv) > frist,
      zugestellt,
      fehler,
    });
  }

  router.get('/', (req, res) => {
    const zugestellt = Number.parseInt(req.query.zugestellt, 10);
    render(res, req.currentPerson, { zugestellt: Number.isInteger(zugestellt) && zugestellt > 0 ? zugestellt : 0 });
  });

  router.post('/', csrfProtection, async (req, res, next) => {
    try {
      const person = req.currentPerson;
      const eingabe = req.body.benachrichtigung;
      if (eingabe !== 'standard' && !BENACHRICHTIGUNG_WERTE.includes(eingabe)) {
        return render(res, person, { status: 422, fehler: 'Bitte eine der angebotenen Möglichkeiten wählen.' });
      }
      setzeBenachrichtigung(db, person.churchtools_person_id, eingabe === 'standard' ? null : eingabe);

      // Wer auf "sofort" wechselt, soll Wartendes nicht erst am nächsten Digest-Lauf bekommen.
      let zugestellt = 0;
      if (benachrichtigungFuer(db, person.email) === 'sofort') {
        const adresse = String(person.email ?? '').trim().toLowerCase();
        const zeilen = [...listGeplantMailsGruppiertNachEmpfaenger(db)]
          .filter(([empfaenger]) => empfaenger.trim().toLowerCase() === adresse)
          .flatMap(([, z]) => z);
        if (zeilen.length) {
          const vorlage = ladeDigestVorlage(db);
          const status = await stelleDigestZu(db, config, mailer, { empfaenger: zeilen[0].empfaenger, ids: zeilen.map((z) => z.id), vorlage });
          if (status === 'versendet') zugestellt = zeilen.length;
        }
      }
      res.redirect(`/meine-benachrichtigungen${zugestellt ? `?zugestellt=${zugestellt}` : ''}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
