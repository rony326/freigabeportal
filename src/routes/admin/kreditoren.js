// Admin → Kreditoren (`/admin/kreditoren`, Recht `kreditoren_verwalten`, docs/qr-bill-und-betrugserkennung.md und docs/kreditoren-statt-debitoren.md): Lieferanten mit Standardkonto, Zahlungsart und "Beträge schwanken", ihre IBANs und die Zuweisungsregeln (Absender-Muster → Kreditor).
// Die Liste zeigt nur die Kreditoren (mit Anzahl IBANs/Regeln); IBANs und Regeln pflegt man auf der Kreditor-Seite (/:id/bearbeiten).
// (Bis 2026-09 hiess die Seite "Debitoren"; der alte Pfad /admin/debitoren leitet weiter.) Bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht.

import { Router } from 'express';
import {
  createKreditor, updateKreditor, deactivateKreditor, activateKreditor, getKreditorById, listKreditoren,
  ZAHLUNGSARTEN, ZAHLUNGSART_LABEL, brauchtIban, istKreditorVollstaendig,
} from '../../db/kreditorenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
} from '../../db/zuweisungsregelnRepo.js';
import { listKonten, getKontoById, filterKontenFuerTyp } from '../../db/kontenRepo.js';
import { createKreditorIban, deleteKreditorIban, getKreditorIbanById, listKreditorIbansAll, listKreditorIbansByKreditor, findKreditorIbanByIban } from '../../db/kreditorIbanRepo.js';
import { normalizeIban, isValidIbanInternational, ibanKurz } from '../../services/ibanUtils.js';
import { pruefeNeuenKreditor, pruefeStandardKonto, legeKreditorAn, pruefeAbsenderMuster } from '../../services/kreditorAnlegen.js';
import { kreditorIdAusEingabe, KreditorFeldKonflikt } from '../../services/kreditorFelder.js';
import { meldeIbanAenderung } from '../../services/ibanAenderung.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const IBAN_PFLICHT_FEHLER = 'Bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht.';
const IBAN_UNGUELTIG_FEHLER = 'IBAN ist ungültig (Prüfziffer oder Länge stimmt nicht).';
const LETZTE_IBAN_FEHLER = 'Die letzte IBAN kann nicht gelöscht werden, solange der Lieferant per Überweisung oder Dauerauftrag bezahlt wird.';
const KREDITOR_INAKTIV_FEHLER = 'Der Kreditor ist deaktiviert. Reaktiviere ihn, um IBANs oder Zuweisungsregeln hinzuzufügen.';
const KREDITOR_UNGUELTIG_FEHLER = 'Kreditor nicht gefunden oder deaktiviert.';

// Pfad der Kreditor-Seite (Stammdaten, IBANs, Zuweisungsregeln).
const kreditorSeite = (id) => `/admin/kreditoren/${id}/bearbeiten`;

// Auswahl für das Standard-Konto: nur Konten, die Rechnungen erlauben. Ein schon gesetztes Konto bleibt
// sichtbar (auch wenn es inzwischen nicht mehr passt), damit Speichern es nicht still entfernt.
// (Siehe Kommentar oben.)
function kontenFuerBearbeiten(db, kreditor) {
  const konten = filterKontenFuerTyp(listKonten(db), 'rechnung');
  if (kreditor.konto_id && !konten.some((k) => k.id === kreditor.konto_id)) {
    const bestehendes = getKontoById(db, kreditor.konto_id);
    if (bestehendes) konten.push(bestehendes);
  }
  return konten;
}

// `config` und `mailer` brauchen die Meldung bei IBAN-Änderungen (services/ibanAenderung.js); ohne `config` entfällt sie.
export function createKreditorenRouter({ db, config = null, mailer = null, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // Liest die Zahlungsart aus dem Formular.
  function zahlungsartAusEingabe(body) {
    return body.zahlungsart || 'ueberweisung';
  }

  // Kreditor zur kreditorId aus dem Formular – nie blind übernehmen: nur ganze Zahlen, und der Kreditor muss existieren.
  function kreditorAusFormular(kreditorId) {
    if (!kreditorId || !/^\d+$/.test(kreditorId)) return null;
    return getKreditorById(db, Number(kreditorId));
  }

  // Rendert die Liste: nur Kreditoren, je mit Anzahl IBANs und Zuweisungsregeln.
  function renderListe(req, res, status) {
    const konten = listKonten(db, { includeInactive: true });
    const zaehle = (zeilen) => zeilen.reduce((m, z) => m.set(z.kreditor_id, (m.get(z.kreditor_id) || 0) + 1), new Map());
    const ibanAnzahl = zaehle(listKreditorIbansAll(db));
    const regelAnzahl = zaehle(listZuweisungsregeln(db));
    const kreditoren = listKreditoren(db, { includeInactive: true }).map((kreditor) => ({
      ...kreditor,
      konto: kreditor.konto_id ? konten.find((k) => k.id === kreditor.konto_id) : null,
      zahlungsartLabel: ZAHLUNGSART_LABEL[kreditor.zahlungsart] || kreditor.zahlungsart,
      unvollstaendig: kreditor.aktiv && !istKreditorVollstaendig(db, kreditor),
      ibanAnzahl: ibanAnzahl.get(kreditor.id) || 0,
      regelAnzahl: regelAnzahl.get(kreditor.id) || 0,
    }));
    const ohneIbanAnzahl = kreditoren.filter((k) => k.unvollstaendig).length;
    res.status(status).render('admin/kreditoren-liste', {
      kreditoren,
      ohneIbanAnzahl,
      gespeichert: req.query.gespeichert === '1',
    });
  }

  // Rendert die Kreditor-Seite: Stammdaten-Formular, eigene IBANs, eigene Zuweisungsregeln (Fehler und Werte aus overrides).
  function renderKreditorSeite(req, res, status, kreditor, overrides = {}) {
    res.status(status).render('admin/kreditoren-form', {
      kreditor,
      values: {
        name: kreditor.name,
        kontoId: kreditor.konto_id ? String(kreditor.konto_id) : '',
        zahlungsart: kreditor.zahlungsart,
        betragSchwankt: !!kreditor.betrag_schwankt,
      },
      errors: [],
      konten: kontenFuerBearbeiten(db, kreditor),
      ZAHLUNGSARTEN,
      ZAHLUNGSART_LABEL,
      ibanKurz,
      ibans: listKreditorIbansByKreditor(db, kreditor.id),
      regeln: listZuweisungsregeln(db).filter((r) => r.kreditor_id === kreditor.id),
      ibanErrors: [],
      ibanValues: {},
      regelErrors: [],
      regelValues: {},
      gespeichert: req.query.gespeichert === '1',
      ...overrides,
    });
  }

  // GET /admin/kreditoren – Liste der Kreditoren.
  router.get('/', (req, res) => {
    renderListe(req, res, 200);
  });

  // Anlegen auf einer eigenen Seite (wie „Bearbeiten“), nicht als Formular unter der Liste.
  // Rendert die Seite zum Anlegen.
  function renderNeu(res, status, { errors = [], values = {} } = {}) {
    res.status(status).render('admin/kreditoren-form', {
      kreditor: null,
      values: { zahlungsart: 'ueberweisung', ...values },
      errors,
      konten: filterKontenFuerTyp(listKonten(db), 'rechnung'),
      ZAHLUNGSARTEN,
      ZAHLUNGSART_LABEL,
    });
  }

  // GET /admin/kreditoren/neu – Formular zum Anlegen.
  router.get('/neu', (req, res) => {
    renderNeu(res, 200);
  });

  // POST /admin/kreditoren – legt einen Kreditor an (mit erster IBAN und, falls ein Absender angegeben ist, erster
  // Zuweisungsregel). Erst alles prüfen, dann alles in einer Transaktion anlegen: entweder alles oder nichts.
  router.post('/', csrfProtection, asyncHandler(async (req, res) => {
    const { name, kontoId, iban } = req.body;
    const absenderMuster = typeof req.body.absenderMuster === 'string' ? req.body.absenderMuster.trim() : '';
    const zahlungsart = zahlungsartAusEingabe(req.body);
    const betragSchwankt = req.body.betragSchwankt === 'on';
    const { errors, normalizedIban } = pruefeNeuenKreditor(db, { name, zahlungsart, iban, kontoId });
    if (absenderMuster) errors.push(...pruefeAbsenderMuster(db, absenderMuster));

    if (errors.length > 0) {
      return renderNeu(res, 400, { errors, values: { name, kontoId, iban, zahlungsart, betragSchwankt, absenderMuster } });
    }

    const id = legeKreditorAn(db, { name, kontoId, zahlungsart, betragSchwankt, normalizedIban, absenderMuster: absenderMuster || null });
    if (normalizedIban) {
      await meldeIbanAenderung(db, config, mailer, { kreditor: { id, name: name.trim() }, iban: normalizedIban, art: 'hinzugefuegt', person: req.currentPerson, neuerLieferant: true });
    }
    res.redirect(`${kreditorSeite(id)}?gespeichert=1`);
  }));

  // Die /regeln*-Routen müssen vor den allgemeinen /:id*-Kreditor-Routen unten registriert werden — sonst träfe POST/GET /admin/kreditoren/regeln(...) zuerst das Muster `/:id` des Routers (mit id="regeln", einem NaN-Number()) und endete mit 404, bevor es diese Handler erreicht.
  // POST /admin/kreditoren/regeln – legt eine Zuweisungsregel an (Absender-Muster = E-Mail oder Domain, Ziel-Kreditor aus
  // dem versteckten Feld der Kreditor-Seite); doppelte Muster werden abgelehnt. Fehler erscheinen auf der Kreditor-Seite.
  router.post('/regeln', csrfProtection, (req, res) => {
    const { absenderMuster } = req.body;
    const kreditor = kreditorAusFormular(kreditorIdAusEingabe(req.body));
    if (!kreditor) return res.status(400).render('error', { message: 'Kreditor nicht gefunden.' });
    const regelValues = { absenderMuster };
    if (!kreditor.aktiv) return renderKreditorSeite(req, res, 400, kreditor, { regelErrors: [KREDITOR_INAKTIV_FEHLER], regelValues });

    const errors = pruefeAbsenderMuster(db, absenderMuster);
    if (errors.length > 0) {
      return renderKreditorSeite(req, res, 400, kreditor, { regelErrors: errors, regelValues });
    }

    createZuweisungsregel(db, { absenderMuster, kreditorId: kreditor.id });
    res.redirect(`${kreditorSeite(kreditor.id)}?gespeichert=1`);
  });

  // GET /admin/kreditoren/regeln/:id/bearbeiten – Regel bearbeiten.
  router.get('/regeln/:id/bearbeiten', (req, res) => {
    const regel = getZuweisungsregelById(db, Number(req.params.id));
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }
    res.render('admin/kreditoren-regel-form', {
      regel,
      values: { absenderMuster: regel.absender_muster, kreditorId: regel.kreditor_id },
      errors: [],
      kreditoren: listKreditoren(db),
    });
  });

  // POST /admin/kreditoren/regeln/:id – Regel speichern (Kreditor kann umgehängt werden: nur auf einen bestehenden,
  // aktiven Kreditor; der bisherige darf bleiben, auch wenn er inzwischen deaktiviert ist).
  router.post('/regeln/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const regel = getZuweisungsregelById(db, id);
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }

    const { absenderMuster } = req.body;
    const kreditorId = kreditorIdAusEingabe(req.body);
    const errors = pruefeAbsenderMuster(db, absenderMuster, { regelId: id });
    const kreditor = kreditorAusFormular(kreditorId);
    if (!kreditorId) errors.push('Kreditor ist ein Pflichtfeld.');
    else if (!kreditor || (!kreditor.aktiv && kreditor.id !== regel.kreditor_id)) errors.push(KREDITOR_UNGUELTIG_FEHLER);

    if (errors.length > 0) {
      return res.status(400).render('admin/kreditoren-regel-form', { regel, values: { absenderMuster, kreditorId }, errors, kreditoren: listKreditoren(db) });
    }

    updateZuweisungsregel(db, id, { absenderMuster, kreditorId: kreditor.id });
    res.redirect(`${kreditorSeite(kreditor.id)}?gespeichert=1`);
  });

  // POST /admin/kreditoren/regeln/:id/loeschen – Regel löschen, zurück auf die Seite ihres Kreditors.
  router.post('/regeln/:id/loeschen', csrfProtection, (req, res) => {
    const regel = getZuweisungsregelById(db, Number(req.params.id));
    if (!regel) return res.redirect('/admin/kreditoren');
    deleteZuweisungsregel(db, regel.id);
    res.redirect(`${kreditorSeite(regel.kreditor_id)}?gespeichert=1`);
  });

  // Die /ibans*-Routen müssen vor den allgemeinen /:id*-Kreditor-Routen unten registriert werden — sonst träfe POST /admin/kreditoren/ibans(...) zuerst das Muster `/:id` des Routers (mit id="ibans", einem NaN-Number()) und endete mit 404, bevor es diese Handler erreicht.
  // POST /admin/kreditoren/ibans – fügt einem (aktiven) Kreditor eine IBAN hinzu (normalisiert, Prüfziffer/Länge, noch
  // keinem anderen Kreditor zugeordnet). Fehler erscheinen auf der Kreditor-Seite.
  router.post('/ibans', csrfProtection, asyncHandler(async (req, res) => {
    const { iban } = req.body;
    const kreditor = kreditorAusFormular(kreditorIdAusEingabe(req.body));
    if (!kreditor) return res.status(400).render('error', { message: 'Kreditor nicht gefunden.' });
    const ibanValues = { iban };
    if (!kreditor.aktiv) return renderKreditorSeite(req, res, 400, kreditor, { ibanErrors: [KREDITOR_INAKTIV_FEHLER], ibanValues });

    const normalizedIban = normalizeIban(iban);
    const errors = [];
    if (!normalizedIban) {
      errors.push('IBAN ist ein Pflichtfeld.');
    } else if (!isValidIbanInternational(normalizedIban)) {
      errors.push(IBAN_UNGUELTIG_FEHLER);
    } else if (findKreditorIbanByIban(db, normalizedIban)) {
      errors.push('Diese IBAN ist bereits einem Lieferanten zugeordnet.');
    }

    if (errors.length > 0) {
      return renderKreditorSeite(req, res, 400, kreditor, { ibanErrors: errors, ibanValues });
    }

    createKreditorIban(db, { kreditorId: kreditor.id, iban: normalizedIban, quelle: 'manuell', erstelltVon: req.currentPerson?.churchtools_person_id });
    await meldeIbanAenderung(db, config, mailer, { kreditor, iban: normalizedIban, art: 'hinzugefuegt', person: req.currentPerson });
    res.redirect(`${kreditorSeite(kreditor.id)}?gespeichert=1`);
  }));

  // POST /admin/kreditoren/ibans/:id/loeschen – löscht eine IBAN (die letzte nur, wenn keine IBAN-Pflicht besteht), zurück auf die Kreditor-Seite.
  router.post('/ibans/:id/loeschen', csrfProtection, asyncHandler(async (req, res) => {
    const row = getKreditorIbanById(db, Number(req.params.id));
    if (!row) return res.redirect('/admin/kreditoren');
    const kreditor = getKreditorById(db, row.kreditor_id);
    if (kreditor && brauchtIban(kreditor.zahlungsart) && listKreditorIbansByKreditor(db, kreditor.id).length <= 1) {
      return renderKreditorSeite(req, res, 400, kreditor, { ibanErrors: [LETZTE_IBAN_FEHLER] });
    }
    deleteKreditorIban(db, row.id);
    if (kreditor) await meldeIbanAenderung(db, config, mailer, { kreditor, iban: row.iban, art: 'geloescht', person: req.currentPerson });
    res.redirect(kreditor ? `${kreditorSeite(kreditor.id)}?gespeichert=1` : '/admin/kreditoren');
  }));

  // GET /admin/kreditoren/:id/bearbeiten – Kreditor-Seite (Stammdaten, IBANs, Zuweisungsregeln).
  router.get('/:id/bearbeiten', (req, res) => {
    const kreditor = getKreditorById(db, Number(req.params.id));
    if (!kreditor) {
      return res.status(404).render('error', { message: 'Kreditor nicht gefunden.' });
    }
    renderKreditorSeite(req, res, 200, kreditor);
  });

  // POST /admin/kreditoren/:id – speichert Name, Standardkonto, Zahlungsart, "Beträge schwanken".
  router.post('/:id', csrfProtection, (req, res) => {
    const id = Number(req.params.id);
    const kreditor = getKreditorById(db, id);
    if (!kreditor) {
      return res.status(404).render('error', { message: 'Kreditor nicht gefunden.' });
    }
    const { name, kontoId } = req.body;
    const zahlungsart = req.body.zahlungsart || kreditor.zahlungsart;
    const betragSchwankt = req.body.betragSchwankt === 'on';
    const errors = [];
    const kontoFehler = pruefeStandardKonto(db, kontoId);
    if (kontoFehler) errors.push(kontoFehler);
    if (!name || !name.trim()) errors.push('Name ist ein Pflichtfeld.');
    if (!ZAHLUNGSARTEN.includes(zahlungsart)) {
      errors.push('Zahlungsart ist ungültig.');
    } else if (brauchtIban(zahlungsart) && listKreditorIbansByKreditor(db, id).length === 0) {
      errors.push(IBAN_PFLICHT_FEHLER);
    }

    if (errors.length > 0) {
      return renderKreditorSeite(req, res, 400, kreditor, { values: { name, kontoId, zahlungsart, betragSchwankt }, errors });
    }

    updateKreditor(db, id, { name: name.trim(), kontoId: kontoId ? Number(kontoId) : null, zahlungsart, betragSchwankt });
    res.redirect(`${kreditorSeite(id)}?gespeichert=1`);
  });

  // POST /admin/kreditoren/:id/deaktivieren – Kreditor abschalten.
  router.post('/:id/deaktivieren', csrfProtection, (req, res) => {
    deactivateKreditor(db, Number(req.params.id));
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  // POST /admin/kreditoren/:id/aktivieren – Kreditor wieder einschalten.
  router.post('/:id/aktivieren', csrfProtection, (req, res) => {
    activateKreditor(db, Number(req.params.id));
    res.redirect('/admin/kreditoren?gespeichert=1');
  });

  // Widerspruechliche alte/neue Feldnamen (kreditorId/debitorId) werden abgelehnt.
  router.use((err, req, res, next) => {
    if (err instanceof KreditorFeldKonflikt) return res.status(400).render('error', { message: err.message });
    next(err);
  });

  return router;
}
