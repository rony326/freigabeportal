import { Router } from 'express';
import { queryGlobalAuditLog } from '../../services/globalAuditLog.js';
import { listAllPersons } from '../../db/personenRepo.js';
import { listKonten } from '../../db/kontenRepo.js';
import { EREIGNIS_LABEL } from '../../services/auditLog.js';

// Ein Von-Datum ("2026-08-01") ist als reiner Tages-Präfix bereits inklusiv (String-Vergleich:
// "2026-08-01T09:00:00Z" > "2026-08-01"). Ein Bis-Datum muss dagegen auf das Tagesende erweitert
// werden, sonst schneidet "zeitpunkt <= '2026-08-01'" jeden Eintrag mit Uhrzeit an diesem Tag ab.
function bisEndeDesTages(bis) {
  if (!bis) return null;
  return bis.length === 10 ? `${bis}T23:59:59.999Z` : bis;
}

// Historische Ereignisse vor der fachlichen Korrektur tragen die alten Tabellennamen. Sie werden
// nicht umgeschrieben (unveraenderliches Protokoll), nur fuer die Anzeige erlaeutert.
const HISTORISCHE_OBJEKTNAMEN = {
  debitoren: 'kreditoren (historisch: debitoren)',
  debitor_ibans: 'kreditor_ibans (historisch: debitor_ibans)',
  gruppenrechte: 'Gruppenrechte',
  person_berechtigungen: 'Einzelrechte',
};

export function objektLabel(objekt) {
  return HISTORISCHE_OBJEKTNAMEN[objekt] || objekt;
}

// Filter der Änderungshistorie (audit_ereignisse). Eigene Parameter mit Präfix h_, damit sie sich
// nicht mit dem Filter der Freigaben/Löschungen weiter unten vermischen.
const HISTORIE_FELDER = ['h_objekt', 'h_lauf', 'h_aktion', 'h_person', 'h_von', 'h_bis', 'h_q'];
const HISTORIE_LIMIT = 50;

const likeMuster = (wert) => `%${String(wert).replace(/[\\%_]/g, (z) => `\\${z}`)}%`;

function ladeHistorie(db, query) {
  const werte = {};
  for (const feld of HISTORIE_FELDER) {
    const wert = typeof query[feld] === 'string' ? query[feld].trim() : '';
    if (wert) werte[feld] = wert;
  }
  const bedingungen = ['e.id < ?'];
  const parameter = [Number(query.vor) || Number.MAX_SAFE_INTEGER];
  if (werte.h_objekt) { bedingungen.push('e.objekt = ?'); parameter.push(werte.h_objekt); }
  if (werte.h_aktion) { bedingungen.push('e.aktion = ?'); parameter.push(werte.h_aktion); }
  if (werte.h_lauf) { bedingungen.push('l.lauf_typ = ?'); parameter.push(werte.h_lauf); }
  if (werte.h_von) { bedingungen.push('e.zeitpunkt >= ?'); parameter.push(werte.h_von); }
  if (werte.h_bis) { bedingungen.push('e.zeitpunkt <= ?'); parameter.push(bisEndeDesTages(werte.h_bis)); }
  if (werte.h_person) {
    bedingungen.push("(e.person_id = ? OR e.person_name LIKE ? ESCAPE '\\')");
    parameter.push(werte.h_person, likeMuster(werte.h_person));
  }
  if (werte.h_q) {
    const muster = likeMuster(werte.h_q);
    bedingungen.push(`(e.objekt_id LIKE ? ESCAPE '\\' OR e.vorher LIKE ? ESCAPE '\\' OR e.nachher LIKE ? ESCAPE '\\'
      OR e.begruendung LIKE ? ESCAPE '\\' OR r.request_id LIKE ? ESCAPE '\\' OR l.lauf_id LIKE ? ESCAPE '\\')`);
    parameter.push(muster, muster, muster, muster, muster, muster);
  }
  const zeilen = db.prepare(`SELECT e.*, r.request_id, l.lauf_id, l.lauf_typ
    FROM audit_ereignisse e LEFT JOIN audit_request_zuordnung r ON r.ereignis_id = e.id
    LEFT JOIN audit_lauf_zuordnung l ON l.ereignis_id = e.id
    WHERE ${bedingungen.join(' AND ')} ORDER BY e.id DESC LIMIT ${HISTORIE_LIMIT}`).all(...parameter);
  const naechsteSeite = zeilen.length === HISTORIE_LIMIT
    ? new URLSearchParams({ ...werte, vor: String(zeilen[zeilen.length - 1].id) }).toString() : null;
  return {
    zeilen,
    werte,
    gefiltert: Object.keys(werte).length > 0,
    naechsteSeite,
    objekte: db.prepare('SELECT DISTINCT objekt FROM audit_ereignisse ORDER BY objekt').all().map((z) => z.objekt),
    aktionen: db.prepare('SELECT DISTINCT aktion FROM audit_ereignisse ORDER BY aktion').all().map((z) => z.aktion),
    laeufe: db.prepare('SELECT DISTINCT lauf_typ FROM audit_lauf_zuordnung ORDER BY lauf_typ').all().map((z) => z.lauf_typ),
  };
}

export function createAuditLogRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const filter = {
      personId: req.query.person || null,
      kontoId: req.query.konto ? Number(req.query.konto) : null,
      von: req.query.von || null,
      bis: bisEndeDesTages(req.query.bis || null),
      ereignisTyp: req.query.typ || null,
      suchbegriff: req.query.q || null,
    };
    const seiteAngefragt = Math.max(1, Number(req.query.seite) || 1);
    const { eintraege, gesamtAnzahl, seite, proSeite } = queryGlobalAuditLog(db, filter, { seite: seiteAngefragt });

    const historie = ladeHistorie(db, req.query);

    res.render('admin/audit-log', {
      // Ohne eigenen Historie-Filter bleibt die Historie ausgeblendet, sobald unten gefiltert wird.
      aenderungen: Object.values(filter).some(Boolean) && !historie.gefiltert ? [] : historie.zeilen,
      historie,
      eintraege,
      gesamtAnzahl,
      seite,
      proSeite,
      gesamtSeiten: Math.max(1, Math.ceil(gesamtAnzahl / proSeite)),
      query: req.query,
      personen: listAllPersons(db),
      konten: listKonten(db, { includeInactive: true }),
      ereignisLabels: EREIGNIS_LABEL,
      objektLabel,
    });
  });

  return router;
}
