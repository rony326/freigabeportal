// Seite "Auswertung" (`/auswertung`, docs/auswertung.md): Kennzahlen, Budget je Konto, Durchlaufzeiten, Engpässe, Lieferanten und CSV-Export.
// Zugang: wer das Recht `auswertung_einsehen` hat (alle Konten) oder Freigeber 1/Stellvertretung eines Kontos ist (nur diese Konten) – siehe services/auswertung.js `zugangFuer`.

import { Router } from 'express';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { personHasPermission } from '../middleware/permissions.js';
import { meldeZugriffVerweigert } from '../services/zugriffsAudit.js';
import {
  parseZeitraum, zugangFuer, kennzahlen, budgetProKonto, durchlaufzeiten, engpaesse, lieferanten,
  formatChf, zuerichHeute,
} from '../services/auswertung.js';

const ABSCHNITTE = ['budget', 'durchlauf', 'engpaesse', 'lieferanten'];
const STUFEN_LABEL = { pool: 'Eingang bis Zuweisung (Pool)', freigabe1: 'Kontierung & Freigabe 1', freigabe2: 'Freigabe 2' };

// "1 Tag" / "2.5 Tage" bzw. "—" ohne Wert.
export function formatTage(tage) {
  if (tage === null || tage === undefined) return '—';
  const text = Number.isInteger(tage) ? String(tage) : tage.toFixed(1);
  return `${text} ${tage === 1 ? 'Tag' : 'Tage'}`;
}

// Semikolon-CSV für Excel (UTF-8 mit BOM). Zellen, die mit = + - @ beginnen, bekommen ein
// führendes Apostroph, damit Excel sie nicht als Formel ausführt.
function csvZelle(wert) {
  let text = wert === null || wert === undefined ? '' : String(wert);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) || text.startsWith("'") ? `"${text.replaceAll('"', '""')}"` : text;
}

// Baut den CSV-Text (Semikolon, UTF-8 mit BOM, CRLF).
function csv(kopf, zeilen) {
  return `﻿${[kopf, ...zeilen].map((z) => z.map(csvZelle).join(';')).join('\r\n')}\r\n`;
}

const zahl = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));

export function createAuswertungRouter({ db, config }) {
  const router = Router();

  // Zugang + Filter für Seite und Export. Gibt null zurück, wenn die Antwort schon gesendet ist.
  function kontext(req, res) {
    const person = req.currentPerson;
    const zugang = zugangFuer(db, config, person);
    if (!zugang) {
      meldeZugriffVerweigert(req, { grund: 'fehlendes_recht', status: 403, recht: 'auswertung_einsehen' });
      res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
      return null;
    }
    const heute = zuerichHeute();
    const zeitraum = parseZeitraum(req.query, heute);
    const kontenSql = zugang.kontoIds
      ? `SELECT * FROM konten WHERE aktiv = 1 AND id IN (${zugang.kontoIds.map(() => '?').join(',')}) ORDER BY kontonummer, id`
      : 'SELECT * FROM konten WHERE aktiv = 1 ORDER BY kontonummer, id';
    const konten = db.prepare(kontenSql).all(...(zugang.kontoIds ?? []));
    const kontoNr = typeof req.query.konto === 'string' ? req.query.konto.trim() : '';
    let kontoIds = zugang.kontoIds;
    if (kontoNr) {
      const treffer = konten.filter((k) => k.kontonummer === kontoNr).map((k) => k.id);
      if (!treffer.length) {
        meldeZugriffVerweigert(req, { grund: 'objekt_verweigert', status: 403, recht: 'auswertung_einsehen' });
        res.status(403).render('error', { message: 'Für dieses Konto hast du keine Auswertung.' });
        return null;
      }
      kontoIds = treffer;
    }
    const schwelleTage = Number(getConfigValue(db, 'auswertung_offen_schwelle_tage')) || 14;
    return { person, zugang, heute, zeitraum, konten, kontoNr, kontoIds, schwelleTage };
  }

  // GET /auswertung?zeitraum=jahr|12m|vorjahr|eigen&von=&bis=&konto= – die Seite.
  router.get('/', (req, res) => {
    const k = kontext(req, res);
    if (!k) return;
    const { zeitraum, kontoIds, heute, schwelleTage, zugang } = k;
    const filter = { von: zeitraum.von, bis: zeitraum.bis, kontoIds };
    const query = new URLSearchParams();
    if (req.query.zeitraum) query.set('zeitraum', zeitraum.art);
    if (zeitraum.art === 'eigen') { query.set('von', zeitraum.von); query.set('bis', zeitraum.bis); }
    if (k.kontoNr) query.set('konto', k.kontoNr);
    res.render('auswertung', {
      zeitraum,
      aktuellesJahr: Number(heute.slice(0, 4)),
      voreinstellungen: Object.fromEntries(['jahr', '12m', 'vorjahr'].map((art) => {
        const z = parseZeitraum({ zeitraum: art }, heute);
        return [art, { von: z.von, bis: z.bis }];
      })),
      konten: k.konten,
      kontoNr: k.kontoNr,
      zugang,
      schwelleTage,
      exportQuery: query.toString(),
      kennzahlen: kennzahlen(db, { ...filter, schwelleTage, heute }),
      budget: budgetProKonto(db, { ...filter, budgetJahr: zeitraum.budgetJahr }),
      durchlauf: durchlaufzeiten(db, filter),
      engpaesse: zugang.engpaesse ? engpaesse(db, { kontoIds, heute }) : null,
      lieferanten: lieferanten(db, filter),
      darfBudgetsPflegen: personHasPermission(db, config, k.person, 'budgets_verwalten'),
      darfVorgaenge: personHasPermission(db, config, k.person, 'vorgaenge_einsehen'),
      stufenLabel: STUFEN_LABEL,
      formatChf,
      formatTage,
    });
  });

  // GET /auswertung/export/<budget|durchlauf|engpaesse|lieferanten>.csv – CSV-Export mit denselben Filtern (Engpässe nur mit vollem Zugang).
  router.get('/export/:abschnitt.csv', (req, res) => {
    const { abschnitt } = req.params;
    if (!ABSCHNITTE.includes(abschnitt)) return res.status(404).render('error', { message: 'Diesen Export gibt es nicht.' });
    const k = kontext(req, res);
    if (!k) return;
    const { zeitraum, kontoIds, heute, zugang } = k;
    const filter = { von: zeitraum.von, bis: zeitraum.bis, kontoIds };
    let kopf;
    let zeilen;
    if (abschnitt === 'budget') {
      kopf = ['Konto', 'Bezeichnung', 'Budgetverantwortlich', `Budget ${zeitraum.budgetJahr} CHF`, 'Freigegeben CHF', 'In Freigabe CHF', 'Ausschöpfung %', 'Über Budget'];
      zeilen = budgetProKonto(db, { ...filter, budgetJahr: zeitraum.budgetJahr }).map((z) => [
        z.kontonummer, z.bezeichnung, z.verantwortlich ?? '', zahl(z.budget), zahl(z.freigegeben), zahl(z.inFreigabe),
        z.ausschoepfung === null ? '' : (z.ausschoepfung * 100).toFixed(1), z.ueberBudget ? 'ja' : 'nein',
      ]);
    } else if (abschnitt === 'durchlauf') {
      kopf = ['Stufe', 'Median Tage', 'Langsamste 10 % Tage', 'Rechnungen'];
      zeilen = durchlaufzeiten(db, filter).map((s) => [STUFEN_LABEL[s.stufe], s.median ?? '', s.p90 ?? '', s.anzahl]);
    } else if (abschnitt === 'engpaesse') {
      if (!zugang.engpaesse) {
        meldeZugriffVerweigert(req, { grund: 'fehlendes_recht', status: 403, recht: 'auswertung_einsehen' });
        return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
      }
      kopf = ['Zuständig', 'Stufe', 'Offen', 'Älteste Tage'];
      zeilen = engpaesse(db, { kontoIds, heute }).map((e) => [e.name, e.stufe, e.anzahl, e.aeltesteTage]);
    } else {
      kopf = ['Lieferant', 'Rechnungen', 'Betrag CHF', 'Anteil %', 'Häufigste Konten'];
      zeilen = lieferanten(db, filter).map((l) => [l.name, l.anzahl, zahl(l.betrag), (l.anteil * 100).toFixed(1), l.konten.join(', ')]);
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="auswertung-${abschnitt}-${zeitraum.von}-${zeitraum.bis}.csv"`);
    res.send(csv(kopf, zeilen));
  });

  return router;
}
