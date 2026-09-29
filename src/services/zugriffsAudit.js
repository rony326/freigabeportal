import { currentAuditActor, currentAuditRequestId, currentAuditOperation, withAuditActor, withAuditRequest, withAuditOperationContext } from './auditContext.js';

// Protokollierung verweigerter Zugriffe. Grundsaetze:
// - Die Zugriffsentscheidung faellt immer vor und unabhaengig von der Protokollierung. Ein
//   Audit-Fehler wird aufgefangen, gezaehlt und ohne Anfragedaten gemeldet; er fuehrt niemals zu
//   einer Freigabe und aendert weder Statuscode noch Antwort.
// - Gespeichert werden nur Grund, Status, Methode, ein Bereich aus einer festen Liste und ggf. das
//   benoetigte Recht aus dem festen Rechtekatalog. Keine Pfade mit IDs, Query-Strings, Header,
//   Cookies, Tokens, API-Keys, Bodies oder IP-Adressen.
// - Wachstum ist je Stundenfenster begrenzt: je Schluessel (Grund/Bereich/Akteur) wenige
//   Einzelereignisse, global eine Obergrenze, danach nur noch ein Drosselhinweis und Zaehler.

export const FENSTER_MS = 60 * 60 * 1000;
export const EINZEL_PRO_SCHLUESSEL = 3;
export const EINZEL_PRO_FENSTER = 50;
export const DROSSELHINWEISE_PRO_FENSTER = 25;
export const SCHLUESSEL_PRO_FENSTER = 200;
const UEBERLAUF = '#ueberlauf';
const EINZEL_ZAEHLER = '#einzel';
const HINWEIS_ZAEHLER = '#hinweise';

export const ZUGRIFF_GRUENDE = new Set([
  'nicht_angemeldet', 'fehlende_rolle', 'fehlendes_recht', 'kein_adminbereich', 'csrf',
  'api_key', 'cron_secret', 'anmeldung_ungueltig', 'objekt_verweigert',
]);

const METHODEN = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ERSTE_SEGMENTE = new Set([
  'admin', 'api', 'internal', 'auth', 'branding', 'downloads', 'pool', 'meine-abgeschlossenen',
  'meine-spesen', 'kreditkarte', 'ferienmodus', 'kontierung', 'spesen', 'spesen-freigabe1',
  'freigabe2', 'abgelehnt', 'zeitstempel-pruefen',
]);
const ZWEITE_SEGMENTE = {
  admin: new Set([
    'konten', 'kreditoren', 'debitoren', 'kreditkarten', 'eskalation', 'erscheinungsbild', 'zeitstempel',
    'personen', 'mails', 'sync', 'abgelehnt', 'audit-log', 'geplante-jobs', 'backup', 'module',
    'mail-einstellungen', 'altfaelle', 'dateiquarantaene',
  ]),
  api: new Set(['n8n', 'pool']),
  internal: new Set(['cron']),
};
const N8N_SEGMENTE = new Set(['jobs', 'backup', 'kk-belege']);
const RECHT_MUSTER = /^[a-z_]{1,40}$/;

let fehlerAnzahl = 0;
let letzterFehlerAm = null;

export function zugriffsAuditFehlerStatus() {
  return { fehlerAnzahl, letzterFehlerAm };
}

// Bereich aus einer festen Liste: ein Angreifer kann durch zufaellige Pfade keine neuen
// Schluessel und damit kein unbegrenztes Wachstum der Drosseltabelle erzeugen.
export function zugriffsBereich(req) {
  const pfad = String(req.originalUrl || req.url || '').split('?')[0];
  const teile = pfad.split('/').filter(Boolean);
  const erstes = teile[0] || '';
  if (!ERSTE_SEGMENTE.has(erstes)) return pfad === '/' ? '/' : 'sonstige';
  const zweite = ZWEITE_SEGMENTE[erstes];
  if (!zweite || !zweite.has(teile[1])) return `/${erstes}`;
  if (erstes === 'api' && teile[1] === 'n8n' && N8N_SEGMENTE.has(teile[2])) return `/api/n8n/${teile[2]}`;
  return `/${erstes}/${teile[1]}`;
}

const ERFASST = Symbol('zugriffVerweigertErfasst');

function schreibeEreignis(db, actor, aktion, bereich, nachher) {
  db.prepare(`INSERT INTO audit_ereignisse
    (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, ?, ?, 'zugriff', ?, ?, ?)`).run(new Date().toISOString(), String(actor.id), String(actor.name), bereich, aktion, JSON.stringify(nachher));
}

function zaehle(db, fenster, schluessel) {
  return db.prepare(`INSERT INTO audit_zugriff_drosselung (fenster_start, schluessel, anzahl) VALUES (?, ?, 1)
    ON CONFLICT(fenster_start, schluessel) DO UPDATE SET anzahl = anzahl + 1
    RETURNING anzahl, protokolliert, drosselung_gemeldet`).get(fenster, schluessel);
}

function zaehlerStand(db, fenster, schluessel) {
  return db.prepare('SELECT anzahl FROM audit_zugriff_drosselung WHERE fenster_start = ? AND schluessel = ?').get(fenster, schluessel)?.anzahl || 0;
}

export function protokolliereZugriffVerweigerung(db, req, { grund, status, recht = null }, now = new Date()) {
  if (req[ERFASST]) return false;
  req[ERFASST] = true;
  let savepoint = false;
  try {
    if (!ZUGRIFF_GRUENDE.has(grund) || ![400, 401, 403].includes(status)) throw new Error('Ungueltige Zugriffsverweigerung.');
    const actor = currentAuditActor();
    const bereich = zugriffsBereich(req);
    const methode = METHODEN.has(req.method) ? req.method : 'ANDERE';
    const fenster = new Date(Math.floor(now.getTime() / FENSTER_MS) * FENSTER_MS).toISOString();
    let schluessel = `${grund}|${bereich}|${actor.id}`.slice(0, 200);
    db.exec('SAVEPOINT zugriff_verweigert');
    savepoint = true;
    const bekannt = db.prepare('SELECT 1 FROM audit_zugriff_drosselung WHERE fenster_start = ? AND schluessel = ?').get(fenster, schluessel);
    if (!bekannt && db.prepare("SELECT count(*) AS n FROM audit_zugriff_drosselung WHERE fenster_start = ? AND schluessel NOT LIKE '#%'").get(fenster).n >= SCHLUESSEL_PRO_FENSTER) {
      schluessel = UEBERLAUF;
    }
    const stand = zaehle(db, fenster, schluessel);
    let protokolliert = false;
    if (schluessel !== UEBERLAUF && stand.protokolliert < EINZEL_PRO_SCHLUESSEL && zaehlerStand(db, fenster, EINZEL_ZAEHLER) < EINZEL_PRO_FENSTER) {
      schreibeEreignis(db, actor, 'zugriff_verweigert', bereich, {
        grund, status, methode, bereich, ...(recht && RECHT_MUSTER.test(recht) ? { recht } : {}),
      });
      db.prepare('UPDATE audit_zugriff_drosselung SET protokolliert = protokolliert + 1 WHERE fenster_start = ? AND schluessel = ?').run(fenster, schluessel);
      zaehle(db, fenster, EINZEL_ZAEHLER);
      protokolliert = true;
    } else if (!stand.drosselung_gemeldet && zaehlerStand(db, fenster, HINWEIS_ZAEHLER) < DROSSELHINWEISE_PRO_FENSTER) {
      schreibeEreignis(db, actor, 'zugriff_verweigert_gedrosselt', schluessel === UEBERLAUF ? 'ueberlauf' : bereich, {
        grund: schluessel === UEBERLAUF ? null : grund, fensterStart: fenster, ueberlauf: schluessel === UEBERLAUF,
      });
      db.prepare('UPDATE audit_zugriff_drosselung SET drosselung_gemeldet = 1 WHERE fenster_start = ? AND schluessel = ?').run(fenster, schluessel);
      zaehle(db, fenster, HINWEIS_ZAEHLER);
    }
    db.exec('RELEASE zugriff_verweigert');
    return protokolliert;
  } catch (err) {
    if (savepoint) {
      try { db.exec('ROLLBACK TO zugriff_verweigert; RELEASE zugriff_verweigert'); } catch { /* Verbindung bereits unbrauchbar. */ }
    }
    fehlerAnzahl += 1;
    letzterFehlerAm = now.toISOString();
    // Keine Anfragedaten und keine Fehlermeldung mit moeglichen Werten ausgeben, nur den Code.
    console.error(`Zugriffsverweigerung konnte nicht protokolliert werden (${typeof err?.code === 'string' ? err.code : 'AUDIT_FEHLER'}). Die Verweigerung bleibt wirksam.`);
    return false;
  }
}

// Guards melden ueber diesen Helfer. Ohne installierte Middleware (z.B. isoliert getestete Router)
// ist er wirkungslos; die Zugriffsentscheidung haengt nie davon ab.
export function meldeZugriffVerweigert(req, info) {
  try { req.zugriffVerweigert?.(info); } catch { /* Protokollierung darf die Verweigerung nicht beeinflussen. */ }
}

export function zugriffsAuditMiddleware(db) {
  return (req, res, next) => {
    req.zugriffVerweigert = (info) => protokolliereZugriffVerweigerung(db, req, info);
    // Rueckfallebene fuer Verweigerungen innerhalb von Routen (z.B. fremder Beleg). Der Kontext
    // wird jetzt festgehalten, weil 'finish' ausserhalb des Request-Kontexts ausgeloest wird.
    const requestId = currentAuditRequestId();
    const actor = currentAuditActor();
    const operation = currentAuditOperation();
    res.on('finish', () => {
      if (req[ERFASST] || ![401, 403].includes(res.statusCode)) return;
      withAuditOperationContext(operation, () => withAuditRequest(requestId, () => withAuditActor(actor, () =>
        protokolliereZugriffVerweigerung(db, req, { grund: res.statusCode === 401 ? 'nicht_angemeldet' : 'objekt_verweigert', status: res.statusCode }))));
    });
    next();
  };
}
