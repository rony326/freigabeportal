// Admin → Budgets (`/admin/budgets`, Recht `budgets_verwalten`, docs/auswertung.md): Jahresbudget je Konto pflegen und aus einer CSV-/Excel-Datei importieren (Vorschau mit Bestätigung innerhalb von 15 Minuten).

import { Router } from 'express';
import multer from 'multer';
import { listKonten } from '../../db/kontenRepo.js';
import { mitAuditKontext } from '../../services/auditContext.js';
import { asyncCallback } from '../../middleware/asyncHandler.js';
import { leseTabelle, ordneZu, erkenneKopfzeile } from '../../services/budgetImport.js';
import { listBudgetsFuerJahr, setzeBudget, entferneBudget } from '../../db/budgetRepo.js';
import { formatChf, parseBetrag, zuerichHeute } from '../../services/auswertung.js';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const VORSCHAU_GUELTIG_MS = 15 * 60 * 1000;
const uploadImport = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });

// Gültiges Jahr (2000–2100) oder null.
function jahrAus(text) {
  const jahr = Number(text);
  return Number.isInteger(jahr) && jahr >= 2000 && jahr <= 2100 ? jahr : null;
}

export function createBudgetsRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // Tabellenzeilen aller aktiven Konten mit Budget des Jahres, Vorjahreswert und Fehlermarkierung.
  function zeilen(jahr, eingaben = null, fehlerIds = new Set()) {
    const budgets = listBudgetsFuerJahr(db, jahr);
    const vorjahr = listBudgetsFuerJahr(db, jahr - 1);
    const namen = new Map(db.prepare('SELECT churchtools_person_id AS id, vorname, nachname FROM personen').all()
      .map((p) => [p.id, `${p.vorname ?? ''} ${p.nachname ?? ''}`.trim()]));
    return listKonten(db).map((k) => ({
      id: k.id,
      kontonummer: k.kontonummer,
      bezeichnung: k.bezeichnung,
      freigeber1: namen.get(k.freigeber1_id) || '—',
      wert: eingaben ? (eingaben[k.id] ?? '') : (budgets.has(k.id) ? String(budgets.get(k.id)) : ''),
      vorjahr: vorjahr.has(k.id) ? formatChf(vorjahr.get(k.id)) : null,
      fehler: fehlerIds.has(k.id),
    }));
  }

  // Rendert die Seite.
  function seite(res, status, { jahr, konten, fehler = null, importFehler = null, gespeichert = false, importiert = null }) {
    return res.status(status).render('admin/budgets', { jahr, konten: konten ?? zeilen(jahr), fehler, importFehler, gespeichert, importiert });
  }

  // GET /admin/budgets?jahr= – Budgets des Jahres.
  router.get('/', (req, res) => {
    const jahr = jahrAus(req.query.jahr) ?? Number(zuerichHeute().slice(0, 4));
    const importiert = /^\d+$/.test(String(req.query.importiert ?? '')) ? Number(req.query.importiert) : null;
    seite(res, 200, { jahr, gespeichert: req.query.gespeichert === '1', importiert });
  });

  // ---------- Import ----------

  // Aktive Konten für die Zuordnung der Importzeilen.
  function aktiveKonten() {
    return listKonten(db).map((k) => ({ id: k.id, kontonummer: String(k.kontonummer).trim() }));
  }

  // Liest die gewählte Spalten-Zuordnung (Konto/Betrag/Kopfzeile) und begrenzt sie auf die Tabellenbreite.
  function zuordnungAus(quelle, importDaten) {
    const breite = Math.max(1, ...importDaten.zeilen.map((z) => z.length));
    const spalte = (wert, standard) => {
      const n = Number(wert);
      return Number.isInteger(n) && n >= 0 && n < breite ? n : standard;
    };
    const spalteKonto = spalte(quelle.spalteKonto, 0);
    const spalteBetrag = spalte(quelle.spalteBetrag, Math.min(1, breite - 1));
    const hatKopfzeile = quelle.kopfzeile === undefined ? erkenneKopfzeile(importDaten.zeilen, spalteBetrag) : quelle.kopfzeile === '1';
    return { spalteKonto, spalteBetrag, hatKopfzeile, breite };
  }

  // Liest die zwischengespeicherte Importvorschau der Sitzung (höchstens 15 Minuten alt).
  function gueltigerImport(req) {
    const daten = req.session?.budgetImport;
    if (!daten || Date.now() - daten.erstelltAm > VORSCHAU_GUELTIG_MS) {
      if (req.session) delete req.session.budgetImport;
      return null;
    }
    return daten;
  }

  // Rendert die Importvorschau (gültige und fehlerhafte Zeilen).
  function vorschau(res, daten, quelle) {
    const zuordnung = zuordnungAus(quelle, daten);
    const ergebnis = ordneZu(daten.zeilen, zuordnung, aktiveKonten(), listBudgetsFuerJahr(db, daten.jahr));
    const kopf = zuordnung.hatKopfzeile && daten.zeilen.length ? daten.zeilen[0] : [];
    const spalten = Array.from({ length: zuordnung.breite }, (_, i) => ({ index: i, name: kopf[i] ? `${String.fromCharCode(65 + (i % 26))}: ${kopf[i]}` : `Spalte ${String.fromCharCode(65 + (i % 26))}` }));
    res.render('admin/budgets-import', { daten, zuordnung, spalten, ergebnis, formatChf });
  }

  // POST /admin/budgets/import – Datei hochladen (höchstens 2 MB, CSV oder .xlsx), Spalten zuordnen und die Vorschau anzeigen.
  router.post('/import', (req, res, next) => {
    // multer vor csrfProtection: das Token steht im multipart-Body.
    mitAuditKontext(uploadImport.single('datei'))(req, res, (uploadErr) => {
      csrfProtection(req, res, asyncCallback(next, async (csrfErr) => {
        if (csrfErr) return next(csrfErr);
        const heute = Number(zuerichHeute().slice(0, 4));
        const jahr = jahrAus(req.body?.jahr) ?? heute;
        if (uploadErr) {
          const meldung = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Datei darf höchstens 2 MB gross sein.' : 'Fehler beim Hochladen der Datei.';
          return seite(res, 400, { jahr, importFehler: meldung });
        }
        if (!req.file) return seite(res, 400, { jahr, importFehler: 'Bitte eine Datei wählen.' });
        let tabelle;
        try {
          tabelle = await leseTabelle(req.file.buffer, req.file.originalname);
        } catch (err) {
          return seite(res, 400, { jahr, importFehler: err.message });
        }
        if (!tabelle.length) return seite(res, 400, { jahr, importFehler: 'Die Datei enthält keine Zeilen.' });
        req.session.budgetImport = { jahr, zeilen: tabelle, dateiname: String(req.file.originalname).slice(0, 200), erstelltAm: Date.now() };
        vorschau(res, req.session.budgetImport, {});
      }));
    });
  });

  // GET /admin/budgets/import/vorschau – Vorschau erneut anzeigen (z. B. nach Änderung der Spaltenwahl).
  router.get('/import/vorschau', (req, res) => {
    const daten = gueltigerImport(req);
    if (!daten) return seite(res, 400, { jahr: Number(zuerichHeute().slice(0, 4)), importFehler: 'Die Vorschau ist abgelaufen. Bitte die Datei erneut hochladen.' });
    vorschau(res, daten, req.query);
  });

  // POST /admin/budgets/import/bestaetigen – übernimmt die gültigen Zeilen der Vorschau als Budgets des Jahres.
  router.post('/import/bestaetigen', csrfProtection, (req, res) => {
    const daten = gueltigerImport(req);
    if (!daten) return seite(res, 400, { jahr: Number(zuerichHeute().slice(0, 4)), importFehler: 'Die Vorschau ist abgelaufen. Bitte die Datei erneut hochladen.' });
    const { gueltig } = ordneZu(daten.zeilen, zuordnungAus(req.body, daten), aktiveKonten(), new Map());
    const personId = req.currentPerson.churchtools_person_id;
    db.exec('BEGIN');
    try {
      for (const z of gueltig) setzeBudget(db, { kontoId: z.kontoId, jahr: daten.jahr, betrag: z.betrag, personId });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    delete req.session.budgetImport;
    res.redirect(`/admin/budgets?jahr=${daten.jahr}&importiert=${gueltig.length}`);
  });

  // POST /admin/budgets – speichert die von Hand erfassten Budgets des Jahres (leeres Feld = Budget entfernen).
  router.post('/', csrfProtection, (req, res) => {
    const jahr = jahrAus(req.body.jahr);
    if (jahr === null) {
      const heute = Number(zuerichHeute().slice(0, 4));
      return seite(res, 400, { jahr: heute, fehler: 'Ungültiges Jahr.' });
    }
    const konten = listKonten(db);
    const eingaben = {};
    const aenderungen = [];
    const fehlerIds = new Set();
    for (const k of konten) {
      const roh = req.body[`budget_${k.id}`];
      if (roh === undefined) continue;
      eingaben[k.id] = String(roh);
      if (String(roh).trim() === '') {
        aenderungen.push({ kontoId: k.id, betrag: null });
        continue;
      }
      const betrag = parseBetrag(roh);
      if (betrag === null) fehlerIds.add(k.id);
      else aenderungen.push({ kontoId: k.id, betrag });
    }
    if (fehlerIds.size) {
      return seite(res, 400, {
        jahr, konten: zeilen(jahr, eingaben, fehlerIds),
        fehler: 'Bitte die markierten Beträge korrigieren (z. B. 12000 oder 12\'000.50). Es wurde nichts gespeichert.',
      });
    }
    const personId = req.currentPerson.churchtools_person_id;
    db.exec('BEGIN');
    try {
      for (const { kontoId, betrag } of aenderungen) {
        if (betrag === null) entferneBudget(db, kontoId, jahr);
        else setzeBudget(db, { kontoId, jahr, betrag, personId });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.redirect(`/admin/budgets?jahr=${jahr}&gespeichert=1`);
  });

  return router;
}
