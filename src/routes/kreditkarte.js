import { Router } from 'express';
import multer from 'multer';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { getKreditkarteById } from '../db/kreditkartenRepo.js';
import { listKonten, getKontoById } from '../db/kontenRepo.js';
import { listActivePersons, getPersonById } from '../db/personenRepo.js';
import {
  createKkBeleg, getKkBelegById, updateKkBelegDaten, ersetzeKkBelegDatei, verwerfeKkBeleg,
  listKkBelegeFuerPerson, listOffeneKkBelegeFuerVerantwortlich, logKkBelegEreignis, aktiviereKkBelegEntwurf,
} from '../db/kkBelegeRepo.js';
import { detectBelegMimetype } from '../services/belegAnhaengen.js';
import { darfAufKarteErfassen, listErfassbareKarten, darfBelegBearbeiten, darfBelegSehen } from '../services/kkRechte.js';
import { POSITION_PATTERN } from '../services/aufsplitten.js';
import { speichereKkBelegDatei, loescheDateienStill, KK_BETRAG_PATTERN, KK_DATUM_PATTERN, normalisiereBetrag } from '../services/kkBelegDatei.js';

const MAX_BELEG_SIZE = 20 * 1024 * 1024;
const uploadBeleg = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BELEG_SIZE, files: 1 } });

function heute() {
  return new Date().toISOString().slice(0, 10);
}

export function createKreditkarteRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();
  const modulAktiv = () => getConfigValue(db, 'modul_kreditkarten_aktiv') === '1';
  const personId = (req) => req.currentPerson.churchtools_person_id;

  // Prüft die fachlichen Felder eines Belegs (Upload, Bearbeiten, später Ergänzen). Liefert die
  // normalisierten Werte oder Fehlermeldungen; `karteErlaubt` prüft das Erfass-Recht.
  // `bisherigeKarteId`/`bisherigerKaeuferId`: beim Bearbeiten dürfen die bisherige Karte bzw. die
  // bisherige "Kauf getätigt von"-Person des Belegs inzwischen deaktiviert sein.
  function pruefeFelder(req, body, { bisherigeKarteId = null, bisherigerKaeuferId = null } = {}) {
    const errors = [];
    const karte = body.kreditkarteId ? getKreditkarteById(db, Number(body.kreditkarteId)) : null;
    if (!karte || (!karte.aktiv && karte.id !== bisherigeKarteId)) errors.push('Bitte eine gültige Karte wählen.');
    const betrag = (body.betrag || '').trim();
    if (!KK_BETRAG_PATTERN.test(betrag)) errors.push('Bitte einen gültigen Betrag angeben (z.B. 12.50, bei Rückerstattung -12.50).');
    const kaufdatum = (body.kaufdatum || '').trim();
    if (!KK_DATUM_PATTERN.test(kaufdatum) || Number.isNaN(new Date(kaufdatum).getTime()) || kaufdatum > heute()) {
      errors.push('Bitte ein gültiges Kaufdatum angeben, das nicht in der Zukunft liegt.');
    }
    const beschreibung = (body.beschreibung || '').trim();
    if (!beschreibung) errors.push('Bitte eine Beschreibung angeben.');
    // Die Beschreibung wird beim Abgleich zur Position und damit gestempelt.
    else if (!POSITION_PATTERN.test(beschreibung)) errors.push('Die Beschreibung enthält Zeichen, die nicht gestempelt werden können (z.B. Emojis). Bitte nur normale Buchstaben, Ziffern und Satzzeichen verwenden.');
    const konto = body.kontoId ? getKontoById(db, Number(body.kontoId)) : null;
    if (body.kontoId && (!konto || !konto.aktiv)) errors.push('Das gewählte Konto ist nicht gültig.');
    const gekauftVonId = (body.gekauftVon || '').trim() || req.currentPerson.churchtools_person_id;
    const gekauftVon = getPersonById(db, gekauftVonId);
    if (!gekauftVon || (!gekauftVon.aktiv && gekauftVonId !== bisherigerKaeuferId)) errors.push('Bitte eine gültige Person für "Kauf getätigt von" wählen.');
    return {
      errors,
      karte,
      werte: { kreditkarteId: karte?.id ?? null, betrag: errors.length ? betrag : normalisiereBetrag(betrag), kaufdatum, beschreibung, kontoId: konto?.id ?? null, gekauftVon: gekauftVonId },
    };
  }

  function pruefeDatei(file, pflicht) {
    if (!file) return pflicht ? { error: 'Bitte einen Beleg hochladen.' } : { mimetype: null };
    const mimetype = detectBelegMimetype(file.buffer);
    if (!mimetype || mimetype !== file.mimetype) return { error: 'Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.' };
    return { mimetype };
  }

  function renderSeite(req, res, status, { values = {}, errors = [] } = {}) {
    const id = personId(req);
    const meine = listKkBelegeFuerPerson(db, id);
    res.status(status).render('kreditkarte', {
      karten: listErfassbareKarten(db, id),
      alleKonten: listKonten(db),
      personen: listActivePersons(db),
      offen: meine.filter((b) => b.status === 'offen'),
      entwuerfe: meine.filter((b) => b.status === 'entwurf'),
      erledigt: meine.filter((b) => b.status === 'zugeordnet' || b.status === 'verworfen'),
      verantwortlichOffen: listOffeneKkBelegeFuerVerantwortlich(db, id),
      values: { kreditkarteId: '', betrag: '', kaufdatum: '', beschreibung: '', kontoId: '', gekauftVon: id, ...values },
      errors,
      gespeichert: req.query.gespeichert === '1',
    });
  }

  router.get('/', (req, res) => {
    if (!modulAktiv()) return res.status(403).render('error', { message: 'Die Kreditkarten-Belege sind derzeit deaktiviert.' });
    renderSeite(req, res, 200);
  });

  router.post('/belege', (req, res, next) => {
    uploadBeleg.single('beleg')(req, res, (uploadErr) => {
      csrfProtection(req, res, async (csrfErr) => {
        if (csrfErr) return next(csrfErr);
        try {
          if (!modulAktiv()) return res.status(403).render('error', { message: 'Die Kreditkarten-Belege sind derzeit deaktiviert.' });
          const { errors, karte, werte } = pruefeFelder(req, req.body);
          if (karte && !darfAufKarteErfassen(db, karte, personId(req))) {
            return res.status(403).render('error', { message: 'Du darfst auf diese Karte keine Belege erfassen.' });
          }
          if (uploadErr) errors.push(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Der Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
          const datei = uploadErr ? {} : pruefeDatei(req.file, true);
          if (datei.error) errors.push(datei.error);
          if (errors.length > 0) return renderSeite(req, res, 400, { values: req.body, errors });

          const { pdfPfad, thumbnailPfad } = await speichereKkBelegDatei(config, req.file.buffer, datei.mimetype);
          const id = createKkBeleg(db, {
            ...werte, hochgeladenVon: personId(req), quelle: 'web', pdfPfad, thumbnailPfad, status: 'offen',
          });
          logKkBelegEreignis(db, { belegId: id, personId: personId(req), aktion: 'kk_beleg_erfasst', kommentar: `${werte.betrag} ${werte.beschreibung}` });
          res.redirect('/kreditkarte?gespeichert=1');
        } catch (err) {
          next(err);
        }
      });
    });
  });

  function ladeBearbeitbarenBeleg(req, res) {
    const beleg = getKkBelegById(db, Number(req.params.id));
    if (!beleg || !darfBelegBearbeiten(db, beleg, personId(req))) {
      res.status(403).render('error', { message: 'Dieser Beleg kann von dir nicht (mehr) bearbeitet werden.' });
      return null;
    }
    return beleg;
  }

  function renderBearbeiten(req, res, status, beleg, values, errors) {
    // Beim Bearbeiten stehen alle Karten zur Wahl, auf die die Person erfassen darf -- plus die
    // aktuelle Karte des Belegs, damit die verantwortliche Person einen Beleg bearbeiten kann,
    // ohne selbst auf der Erfasser-Liste zu stehen.
    // Ein Entwurf wird dagegen erst beim Ergänzen erfasst und braucht deshalb das Erfass-Recht.
    const karten = listErfassbareKarten(db, personId(req));
    const aktuelle = beleg.kreditkarte_id ? getKreditkarteById(db, beleg.kreditkarte_id) : null;
    if (aktuelle && beleg.status !== 'entwurf' && !karten.some((k) => k.id === aktuelle.id)) karten.push(aktuelle);
    // Ist die bisherige "Kauf getätigt von"-Person inzwischen inaktiv, bleibt sie wählbar, statt beim
    // Speichern stillschweigend durch die erste aktive Person ersetzt zu werden.
    const personen = listActivePersons(db);
    const kaeufer = getPersonById(db, beleg.gekauft_von);
    if (kaeufer && !kaeufer.aktiv) personen.unshift({ ...kaeufer, inaktiv: true });
    res.status(status).render('kreditkarte-beleg-bearbeiten', { beleg, karten, alleKonten: listKonten(db), personen, values, errors });
  }

  router.get('/belege/:id/bearbeiten', (req, res) => {
    const beleg = ladeBearbeitbarenBeleg(req, res);
    if (!beleg) return;
    renderBearbeiten(req, res, 200, beleg, {
      kreditkarteId: String(beleg.kreditkarte_id ?? ''), betrag: beleg.betrag ?? '', kaufdatum: beleg.kaufdatum ?? '',
      beschreibung: beleg.beschreibung ?? '', kontoId: beleg.konto_id ? String(beleg.konto_id) : '', gekauftVon: beleg.gekauft_von,
    }, []);
  });

  router.post('/belege/:id', (req, res, next) => {
    uploadBeleg.single('beleg')(req, res, (uploadErr) => {
      csrfProtection(req, res, async (csrfErr) => {
        if (csrfErr) return next(csrfErr);
        try {
          const beleg = ladeBearbeitbarenBeleg(req, res);
          if (!beleg) return;
          const istEntwurf = beleg.status === 'entwurf';
          const { errors, karte, werte } = pruefeFelder(req, req.body, {
            bisherigeKarteId: istEntwurf ? null : beleg.kreditkarte_id,
            bisherigerKaeuferId: beleg.gekauft_von,
          });
          // Ein Entwurf wird erst jetzt auf die Karte erfasst: keine Abkürzung über die vorbelegte Karte.
          const karteErlaubt = karte && ((!istEntwurf && karte.id === beleg.kreditkarte_id) || darfAufKarteErfassen(db, karte, personId(req)));
          if (karte && !karteErlaubt) errors.push('Auf diese Karte darfst du keine Belege erfassen.');
          if (uploadErr) errors.push(uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Der Beleg darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.');
          const datei = uploadErr ? {} : pruefeDatei(req.file, false);
          if (datei.error) errors.push(datei.error);
          if (errors.length > 0) return renderBearbeiten(req, res, 400, beleg, req.body, errors);

          const aktualisiert = updateKkBelegDaten(db, beleg.id, werte);
          if (!aktualisiert) return res.status(409).render('error', { message: 'Der Beleg wurde inzwischen zugeordnet oder verworfen.' });
          if (req.file) {
            const neu = await speichereKkBelegDatei(config, req.file.buffer, datei.mimetype);
            if (ersetzeKkBelegDatei(db, beleg.id, neu)) {
              loescheDateienStill(beleg.pdf_pfad, beleg.thumbnail_pfad);
            } else {
              loescheDateienStill(neu.pdfPfad, neu.thumbnailPfad);
            }
          }
          if (istEntwurf && aktiviereKkBelegEntwurf(db, beleg.id)) {
            logKkBelegEreignis(db, { belegId: beleg.id, personId: personId(req), aktion: 'kk_beleg_ergaenzt', kommentar: null });
          } else {
            logKkBelegEreignis(db, { belegId: beleg.id, personId: personId(req), aktion: 'kk_beleg_geaendert', kommentar: req.file ? 'inkl. neuer Datei' : null });
          }
          res.redirect('/kreditkarte?gespeichert=1');
        } catch (err) {
          next(err);
        }
      });
    });
  });

  router.post('/belege/:id/verwerfen', csrfProtection, (req, res) => {
    const beleg = ladeBearbeitbarenBeleg(req, res);
    if (!beleg) return;
    const grund = (req.body.grund || '').trim();
    if (!grund) return res.status(400).render('error', { message: 'Bitte einen Grund für das Verwerfen angeben.' });
    if (!verwerfeKkBeleg(db, beleg.id, { personId: personId(req), grund })) {
      return res.status(409).render('error', { message: 'Der Beleg wurde inzwischen zugeordnet oder verworfen.' });
    }
    logKkBelegEreignis(db, { belegId: beleg.id, personId: personId(req), aktion: 'kk_beleg_verworfen', kommentar: grund });
    res.redirect('/kreditkarte');
  });

  function streamDatei(req, res, feld, contentType) {
    const beleg = getKkBelegById(db, Number(req.params.id));
    if (!beleg || !darfBelegSehen(db, config, beleg, req.currentPerson)) return res.status(404).json({ error: 'Nicht gefunden.' });
    const pfad = beleg[feld];
    if (!pfad || !existsSync(pfad)) return res.status(404).json({ error: 'Datei nicht vorhanden.' });
    res.type(contentType);
    if (contentType === 'application/pdf') {
      res.setHeader('Content-Disposition', `inline; filename="kreditkartenbeleg-${beleg.id}.pdf"`);
      res.setHeader('Content-Length', statSync(pfad).size);
    }
    const stream = createReadStream(pfad);
    stream.on('error', () => {
      // Mirrors downloads.js's error handler: a stream failure that occurs before any bytes
      // were sent (e.g. the file vanished between the existsSync check above and this read)
      // must still produce a clean JSON 404 rather than a half-written/hung response — once
      // headers are already sent there is nothing left to do but abort the connection.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(404).type('json').json({ error: 'Datei nicht vorhanden.' });
    });
    stream.pipe(res);
  }

  router.get('/belege/:id/datei', (req, res) => streamDatei(req, res, 'pdf_pfad', 'application/pdf'));
  router.get('/belege/:id/thumbnail', (req, res) => streamDatei(req, res, 'thumbnail_pfad', 'image/png'));

  return router;
}
