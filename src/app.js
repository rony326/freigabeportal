// Express-App: hier wird alles zusammengesteckt – Sicherheits-Header, Session, CSRF, Rechte-Guards und
// sämtliche Router. `createApp()` wird vom echten Server (index.js), von den Tests und – rekursiv – für die
// Testmodus-Instanz (Spielwiese mit eigener Datenbank, docs/testmodus.md) aufgerufen.
//
// Die REIHENFOLGE der `app.use`-Aufrufe ist Teil der Sicherheit und der Funktion; nicht umsortieren, ohne
// die Begründungen an den Stellen zu lesen. Grobe Pipeline (docs/architektur.md, "Middleware-Pipeline"):
//   Security-Header → /healthz → Request-ID → statische Dateien → Branding → Body-Parser → Session →
//   Cookies → CSRF-Token → aktuelle Person → Testmodus-Weiche → Wartungsmodus → Nutzungserfassung →
//   Audit-Kontext/Zugriffs-Audit → Navigation → Router (Admin, Maschinen, Portal) → 404 → Fehler-Handler.
//
// Neuer Router? 1. Datei in src/routes/ anlegen (Fabrik `createXxxRouter({ db, config, … })`),
// 2. hier mit dem passenden Guard einhängen (requireLogin / requireRole / requirePermission),
// 3. schreibende Routen mit `csrfProtection` absichern (csrfSweep.test.js prüft das),
// 4. Menüeintrag in services/navigation.js, Doku in docs/admin-bereich.md bzw. docs/architektur.md.

import { randomBytes } from 'node:crypto';
import { parseEmpfaengerListe } from './services/auditNachweisJobs.js';
import { feldFehlerAttr } from './utils/feldFehler.js';
import express from 'express';
import compression from 'compression';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { belegName } from './services/belegName.js';
import { existsSync, statSync } from 'node:fs';
import { SqliteSessionStore } from './db/sessionStore.js';
import { createAuthRouter } from './routes/auth.js';
import { createCronRouter } from './routes/cron.js';
import { requireApiKey } from './middleware/apiKey.js';
import { requireCronSecret } from './middleware/cronAuth.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { ansichtWahl } from './middleware/ansicht.js';
import { createN8nJobsRouter } from './routes/n8n/jobs.js';
import { createN8nBackupRouter } from './routes/n8n/backup.js';
import { createN8nKkBelegeRouter } from './routes/n8n/kkBelege.js';
import { createN8nRapporteRouter } from './routes/n8n/rapporte.js';
import { loadCurrentPerson, loadBeispielperson, requireRole, requireLogin } from './middleware/roles.js';
import { requireAdminAreaAccess, requirePermission } from './middleware/permissions.js';
import { loadNavFlags } from './middleware/nav.js';
import { loadBranding } from './middleware/branding.js';
import { createBrandingRouter } from './routes/branding.js';
import { createKontenRouter } from './routes/admin/konten.js';
import { createKreditorenRouter } from './routes/admin/kreditoren.js';
import { createKreditkartenAdminRouter } from './routes/admin/kreditkarten.js';
import { createBenachrichtigungenRouter } from './routes/admin/benachrichtigungen.js';
import { createErscheinungsbildRouter } from './routes/admin/erscheinungsbild.js';
import { countZeitstempelUeberfaellig } from './db/jobsRepo.js';
import { getConfigValue } from './db/adminConfigRepo.js';
import { createErsteinrichtungRouter } from './routes/admin/ersteinrichtung.js';
import { einrichtungsStand, einrichtungAbgeschlossenAm } from './services/ersteinrichtung.js';
import { pruefeTechnik } from './services/einrichtungTests.js';
import { createZeitstempelAdminRouter } from './routes/admin/zeitstempel.js';
import { createPersonenRouter } from './routes/admin/personen.js';
import { createMailsRouter } from './routes/admin/mails.js';
import { createSyncRouter } from './routes/admin/sync.js';
import { createAdminAbgelehntRouter } from './routes/admin/abgelehnt.js';
import { createVorgaengeRouter } from './routes/admin/vorgaenge.js';
import { createBudgetsRouter } from './routes/admin/budgets.js';
import { createAuswertungRouter } from './routes/auswertung.js';
import { createAuditLogRouter } from './routes/admin/auditLog.js';
import { createGeplanteJobsRouter } from './routes/admin/geplanteJobs.js';
import { createBackupRouter } from './routes/admin/backup.js';
import { createModuleRouter } from './routes/admin/module.js';
import { wartungsmodusSperre } from './middleware/wartungsmodus.js';
import { createWartungsmodusRouter } from './routes/admin/wartungsmodus.js';
import { createGruppenrechteRouter } from './routes/admin/gruppenrechte.js';
import { createAltfaelleRouter } from './routes/admin/altfaelle.js';
import { createDateiQuarantaeneRouter } from './routes/admin/dateiQuarantaene.js';
import { createHealthzRouter } from './routes/healthz.js';
import { createTsaErreichbarkeit } from './services/statusTsa.js';
import { createStatusCache } from './services/statusPruefungen.js';
import { createBetriebRouter } from './routes/admin/betrieb.js';
import { createPoolRouter } from './routes/pool.js';
import { createPoolPageRouter } from './routes/poolPage.js';
import { createMeineAbgeschlossenenRouter } from './routes/meineAbgeschlossenen.js';
import { createMeineSpesenRouter } from './routes/meineSpesen.js';
import { createFerienmodusRouter } from './routes/ferienmodus.js';
import { createMeineBenachrichtigungenRouter } from './routes/meineBenachrichtigungen.js';
import { createBannerRouter } from './routes/banner.js';
import { createDatenschutzRouter } from './routes/datenschutz.js';
import { createFehlerMeldenRouter } from './routes/fehlerMelden.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createKkAbgleichRouter } from './routes/kkAbgleich.js';
import { createKontierungRouter } from './routes/kontierung.js';
import { createSpesenRouter } from './routes/spesen.js';
import { createSpesenFreigabe1Router } from './routes/spesenFreigabe1.js';
import { createFreigabe2Router } from './routes/freigabe2.js';
import { createAblehnungRouter } from './routes/ablehnung.js';
import { createZeitstempelPruefenRouter } from './routes/zeitstempelPruefen.js';
import { createKommentareRouter } from './routes/kommentare.js';
import { createRapporteRouter } from './routes/rapporte.js';
import { createAuditPruefenRouter } from './routes/auditPruefen.js';
import { createKreditkarteRouter } from './routes/kreditkarte.js';
import { createMailerOrFallback } from './services/mailer.js';
import { createTestMailer } from './services/testmodus/testMailer.js';
import { createTestmodusSteuerung } from './services/testmodus/steuerung.js';
import { testmodusWeiche } from './middleware/testmodusWeiche.js';
import { createTestmodusRouter } from './routes/admin/testmodus.js';
import { createTestmodusInstanzRouter } from './routes/testmodusInstanz.js';
import { zeitpunktAnzeige } from './services/auditLog.js';
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from './middleware/rateLimit.js';
import { getVersionInfo } from './utils/version.js';
import { auditContext, auditRequestContext } from './services/auditContext.js';
import { zugriffsAuditMiddleware, meldeZugriffVerweigert } from './services/zugriffsAudit.js';
import { nutzungErfassen } from './middleware/nutzungErfassen.js';
import { erfasseFehler } from './services/nutzung.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `mailer` ist für Tests austauschbar (ein Stub statt des SMTP-Versands).
// `testmodus`: Test-Instanz auf der Spiel-DB — ohne Sitzung (kommt von der echten App), ohne
// Login und /healthz, ohne TSA-Probe, Mailer = Test-Mailer; Person = gewählte Beispielperson.
// `limiter`: von aussen gereichte Rate-Limiter (die echte App gibt der Test-Instanz einen festen
// Satz, damit ein Zurücksetzen keine neuen MemoryStore-Timer und alten App-Graphen zurücklässt).
/**
 * Baut die komplette Express-App.
 * @param {object} opts
 * @param {object} opts.db geöffnete SQLite-Datenbank (`node:sqlite`)
 * @param {object} opts.config Laufzeitkonfiguration aus `loadConfig()`
 * @param {object} [opts.mailer] Mail-Versand; Standard: SMTP, ohne Konfiguration ein Fallback, der nur protokolliert
 * @param {Function} [opts.tsaVersuch] Test-Einschub für die TSA-Probe der Statusseite
 * @param {boolean} [opts.testmodus] true = Test-Instanz auf der Spiel-DB (siehe Kommentar unten)
 * @param {object} [opts.limiter] fertige Rate-Limiter (nur für die Test-Instanz)
 * @returns {import('express').Express}
 */
export function createApp({ db, config, mailer: injectedMailer = null, tsaVersuch = undefined, testmodus = false, limiter = null }) {
  const app = express();
  // AUS-03: kein `X-Powered-By: Express`-Header — verrät sonst die eingesetzte Technik (Fingerprint).
  app.disable('x-powered-by');
  // Eine TSA-Probe und ein Status-Cache (30 s) fuer /healthz, Dashboard und Statusseite.
  const statusCache = createStatusCache({ db, config, tsaErreichbarkeit: testmodus ? null : createTsaErreichbarkeit(), tsaVersuch });
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
  // Übersetzte Vorlagen behalten, auch ohne NODE_ENV=production: sonst übersetzt Express jede
  // Vorlage bei jedem Aufruf neu (gemessen: /pool rund 4-5x langsamer). `npm run dev` startet den
  // Prozess bei Änderungen ohnehin neu.
  app.set('view cache', true);
  // Einmal beim Start berechnet, nicht pro Anfrage: der laufende Commit ändert sich während des Prozesses
  // nicht, und bei jeder Anfrage git aufzurufen wäre Verschwendung.
  app.locals.version = getVersionInfo(join(__dirname, '..'));
  app.locals.zeitpunktAnzeige = zeitpunktAnzeige;
  app.locals.belegName = belegName;
  app.locals.feldFehlerAttr = feldFehlerAttr;
  // Versions-Parameter für /js/portal.js und /css/portal.css (aus dem Dateistand beim Start): neue
  // Stände werden sofort geladen, und eine im Browser gespeicherte alte Umleitung der nackten URL
  // greift nicht mehr (Rückmeldung 2026-10-27: ERR_TOO_MANY_REDIRECTS auf portal.js).
  app.locals.assetVersion = ['js/portal.js', 'js/belegUmschalter.js', 'css/portal.css', 'vendor/bootstrap-icons/symbole.svg', 'vendor/bootstrap/bootstrap.min.css', 'vendor/bootstrap/bootstrap.bundle.min.js']
    .map((datei) => Math.trunc(statSync(join(__dirname, '..', 'public', datei)).mtimeMs).toString(36))
    .join('');
  app.use((req, res, next) => {
    // X-Content-Type-Options: Die PDF-Prüfung beim Upload kontrolliert nur die ersten 4 Bytes. Der Header
    // verhindert, dass ein Browser eine präparierte Datei beim Ausliefern über /downloads oder /branding
    // als etwas anderes als den deklarierten Content-Type interpretiert (Sniffing).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options: SAMEORIGIN, nicht DENY — kontierung.ejs, freigabe2.ejs und pool.ejs binden die PDF-Vorschau
    // (signierte Download-URL) in einem gleich-originären <iframe> ein, und DENY blockiert auch das.
    // SameSite=Lax-Cookies werden bei seitenübergreifend eingebetteten Unterressourcen ohnehin nicht mitgesendet,
    // SAMEORIGIN schliesst den Fall "fremde Seite bettet uns ein" also weiterhin.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Referrer-Policy: Signierte Download-URLs tragen ihre Signatur in der Query (services/downloadUrl.js) und
    // stecken in <iframe>-Vorschauen. Ohne diesen Header könnte ein Link, der in einer gerenderten Rechnungs-PDF
    // angeklickt wird, eine noch gültige Download-URL über den Referer an Dritte weitergeben.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // AUS-01 Strict-Transport-Security: nur auf einer HTTPS-Anfrage setzen (req.secure wertet
    // hinter `trust proxy` = 1 das X-Forwarded-Proto des Infomaniak-Proxys aus). Im lokalen
    // HTTP-Dev bleibt der Header weg, damit der Browser dort nicht dauerhaft auf HTTPS festgelegt
    // wird. max-age 1 Jahr, inklusive Subdomains.
    if (req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // AUS-02 Permissions-Policy: das Portal nutzt keine dieser Browser-Funktionen — Kamera,
    // Mikrofon, Standort, Zahlungs- und USB-Schnittstelle ausdrücklich für alle Herkünfte sperren.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // AUS-07 COOP/CORP (Defense-in-depth): das Portal bettet nur eigene Ressourcen (PDF-Vorschau,
    // Thumbnails) same-origin ein und bindet keine fremden Seiten ein. `same-origin` für beide
    // kappt Cross-Origin-Zugriffe, ohne die eigene same-origin-Einbettung zu brechen.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Content-Security-Policy: zusätzliche Sicherung, nicht die primäre XSS-Abwehr — jede EJS-Ansicht wurde
    // geprüft und gibt vom Benutzer kontrollierte Daten nur mit dem escapenden `<%= %>` aus (der
    // "Roh-Ausgabe-Sweep" in test/integration/layoutSweep.test.js erzwingt das). Inline-<script>- und
    // <style>-Blöcke laufen nur mit dem Nonce dieser Anfrage (res.locals.cspNonce, an jedem Block in den Views gesetzt —
    // test/integration/cspSweep.test.js erzwingt es); ein eingeschleuster Block wird also selbst dann blockiert,
    // wenn das Escaping je versagen sollte. style=""-Attribute bleiben erlaubt (style-src-attr): viele Views nutzen
    // sie für Layout und berechnete Breiten, und CSS-Attribute können keinen Code ausführen. img-src erlaubt data:
    // (nur Bilder), weil Bootstraps CSS seine Icons als data-URI-SVGs mitbringt (Schliessen-X, Auswahlpfeil,
    // Häkchen); ohne das wären diese Icons unsichtbar.
    const nonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; ` +
        `style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; ` +
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; " +
        "form-action 'self'; frame-ancestors 'self'"
    );
    next();
  });
  // Frueh gemountet: kein Session-Cookie, kein CSRF, eigener Limiter (120/min/IP).
  if (!testmodus) app.use('/healthz', createHealthzRouter({ db, config, statusCache }));
  app.use(auditRequestContext);
  const publicDir = join(__dirname, '..', 'public');
  // Rückmeldung Live-Portal: der Browser holte "/js/portal.js/" (Schrägstrich angehängt) und bekam
  // die HTML-404 — Skript verweigert (MIME text/html). Keine Seite verweist so darauf; hängt ein
  // Proxy, Lesezeichen oder eine alte Seite den Schrägstrich an, führt eine 302 zur echten Datei.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = /^(\/(?:js|css|vendor)\/[^?]*?\.[a-z0-9]+)\/+$/i.exec(req.path);
    if (!m) return next();
    const ziel = resolve(publicDir, `.${m[1]}`);
    if (!ziel.startsWith(publicDir + sep) || !existsSync(ziel) || !statSync(ziel).isFile()) return next();
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    // 302, nicht 301: eine dauerhafte Umleitung speichert der Browser — zusammen mit einer alten,
    // gespeicherten Umleitung in die Gegenrichtung entstand live eine Endlosschleife.
    return res.redirect(302, m[1] + query);
  });
  // HTML, CSS, JS und SVG komprimiert ausliefern (Bootstrap-CSS 233 KB -> rund 31 KB). PDFs und
  // Bilder komprimiert die Bibliothek von sich aus nicht.
  app.use(compression());
  // Dateien mit ?v=<Stand> ändern sich unter dieser URL nie: ein Jahr cachen, ohne Rückfrage.
  // Ohne Version bleibt es bei der Rückfrage per ETag/Last-Modified.
  app.use(express.static(publicDir, {
    setHeaders(res) {
      if (res.req?.query?.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.use(loadBranding(db));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  if (!testmodus) app.use(
    session({
      store: new SqliteSessionStore(db),
      // Hinter HTTPS mit __Host--Präfix (nur Secure, Path=/, ohne Domain-Attribut): ein Cookie dieses
      // Namens kann nicht von einer Subdomain aus gesetzt oder überschrieben werden.
      name: config.publicBaseUrl?.startsWith('https://') ? '__Host-portal.sid' : 'connect.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // Aus publicBaseUrl abgeleitet (in Produktion laut env.js immer Pflicht) statt aus NODE_ENV, dessen
        // korrekte Setzung auf dem Host nichts erzwingt — ein nicht gesetztes NODE_ENV würde sonst still ohne
        // Secure-Flag starten, obwohl TLS Pflicht ist.
        secure: Boolean(config.publicBaseUrl?.startsWith('https://')),
        sameSite: 'lax',
        // 8 Stunden: Gruppenänderungen aus ChurchTools (Rollenentzug) greifen spätestens nach dem
        // nächsten Sync oder Login; die ChurchTools-Anmeldung dahinter erneuert still.
        maxAge: 8 * 60 * 60 * 1000,
      },
    })
  );
  // cookie-parser muss nach express-session laufen (die Session liest ihr eigenes Cookie zuerst) und vor der
  // CSRF-Middleware, die ihr eigenes, von der Session getrenntes Cookie liest und schreibt.
  app.use(cookieParser());
  app.use(ansichtWahl());
  const { attachCsrfToken, csrfProtection, generateCsrfToken } = createCsrfProtection(config);
  app.use((req, res, next) => {
    // /api/n8n/* und /internal/cron/* sind Maschinenrouten, die über die Header X-API-Key bzw. X-Cron-Secret
    // authentifiziert werden, nie über Session-Cookies — sie senden weder CSRF-Cookie noch -Token und müssen
    // ausgenommen bleiben. /api/pool dagegen ist per Session-Cookie authentifiziert (der Button "beanspruchen"
    // ist ein fetch()-Aufruf, geschützt über den Header x-csrf-token statt eines Formularfelds) und braucht CSRF.
    if (req.path.startsWith('/api/n8n/') || req.path.startsWith('/internal/cron')) return next();
    return attachCsrfToken(req, res, next);
  });
  app.use(testmodus ? loadBeispielperson(db) : loadCurrentPerson(db));
  // Echte App: Test-Instanz lazy im Speicher; die Weiche steht direkt nach der Person und vor
  // Nutzung/Audit, damit Testmodus-Anfragen (auch 401/403) im echten Betrieb nichts hinterlassen.
  let testLimiter = null;
  const testmodusSteuerung = testmodus ? null : createTestmodusSteuerung({
    echteDb: db,
    config,
    baueTestApp: (sp) => {
      testLimiter ??= { publicLimiter: createPublicRateLimiter(), sessionLimiter: createSessionRateLimiter(), machineLimiter: createMachineRateLimiter() };
      return createApp({ db: sp.db, config: sp.config, testmodus: true, limiter: testLimiter });
    },
  });
  if (testmodusSteuerung) {
    app.set('testmodusSteuerung', testmodusSteuerung);
    app.use(testmodusWeiche({
      db,
      config,
      holeTestApp: async () => (await testmodusSteuerung.hole()).app,
      echterCsrfToken: (req, res) => res.locals.csrfToken ?? generateCsrfToken(req, res),
    }));
  }
  // Vor Nutzungserfassung und Audit: im Wartungsmodus sollen normale Anfragen keine Daten schreiben.
  app.use(wartungsmodusSperre(db, config));
  app.use(nutzungErfassen(db));
  app.use(auditContext);
  app.use(zugriffsAuditMiddleware(db));
  app.use(loadNavFlags(db, config));

  const mailer = injectedMailer ?? (testmodus ? createTestMailer() : createMailerOrFallback(config.smtp));

  const publicLimiter = limiter?.publicLimiter ?? createPublicRateLimiter();
  const sessionLimiter = limiter?.sessionLimiter ?? createSessionRateLimiter();
  const machineLimiter = limiter?.machineLimiter ?? createMachineRateLimiter();

  // Ohne Limiter, wie die statischen Dateien: das Logo hängt an jeder Seite (bis zu zwei Bilder je
  // Aufruf). Am öffentlichen Limiter teilte es sich dessen IP-Zähler mit /, /auth und /audit-pruefen
  // und lief nach wenigen Dutzend Seitenaufrufen in 429. Das Ausliefern ist billig (Datei + ETag/304,
  // versionierte URLs werden vom Browser gecacht, siehe routes/branding.js).
  app.use('/branding', createBrandingRouter({ db }));
  app.use('/admin', sessionLimiter, requireAdminAreaAccess(db, config));
  // Admin-Startseite (Dashboard mit Hinweiskarten). Alle Unterseiten hängen darunter, jede mit eigenem Recht.
  app.get('/admin', (req, res) => {
    const zeitstempelWarnungSchwelle = Number(getConfigValue(db, 'zeitstempel_warnung_ab_stunden'));
    const tsaAktiv = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    // Gesamtstatus für die Betrieb-Karte; ein Fehler hier darf das Dashboard nie verhindern.
    let betriebStatus = null;
    if (res.locals.adminNav?.betrieb) {
      try {
        betriebStatus = statusCache.ergebnis().status;
      } catch { /* Karte ohne Status */ }
    }
    // Hinweis auf die Ersteinrichtung: nur Superadmin, solange Pflichtschritte offen und nicht verschoben;
    // nach dem ersten Abschluss nie mehr. Nie in der Test-Instanz: deren Pflichtschritte (TSA, Sync,
    // Sicherung) sind dort gesperrt und liessen sich nie abschliessen.
    let einrichtungHinweis = null;
    if (!testmodus && res.locals.adminNav?.ersteinrichtung === true && !einrichtungAbgeschlossenAm(db)) {
      try {
        const bis = Date.parse(getConfigValue(db, `einrichtung_spaeter_bis_${req.currentPerson.churchtools_person_id}`) || '');
        if (!(bis > Date.now())) {
          const { pflichtOffen, pflichtGesamt } = einrichtungsStand(db, config, { technik: pruefeTechnik(config), tsaErgebnis: statusCache.tsaErgebnis() });
          if (pflichtOffen > 0) einrichtungHinweis = { erledigt: pflichtGesamt - pflichtOffen, gesamt: pflichtGesamt };
        }
      } catch { /* Dashboard ohne Hinweis */ }
    }
    res.render('admin/dashboard', {
      einrichtungHinweis,
      betriebStatus,
      zeitstempelUeberfaellig: tsaAktiv ? countZeitstempelUeberfaellig(db, zeitstempelWarnungSchwelle) : 0,
      zeitstempelWarnungSchwelle,
      // Hinweis nur für Superadmins, nur solange der automatische Nachweis aktiv ist.
      auditRevisionEmpfaengerFehlt: res.locals.adminNav?.benachrichtigungen === true
        && getConfigValue(db, 'modul_audit_nachweis_aktiv') === '1'
        && parseEmpfaengerListe(getConfigValue(db, 'audit_revision_empfaenger')).adressen.length === 0,
    });
  });
  // ---- Admin-Bereich: je Seite ein Recht (Katalog: services/berechtigungKatalog.js, Übersicht: docs/admin-bereich.md) ----
  app.use('/admin/konten', requirePermission(db, config, 'konten_verwalten'), createKontenRouter({ db, csrfProtection }));
  app.use('/admin/kreditoren', requirePermission(db, config, 'kreditoren_verwalten'), createKreditorenRouter({ db, csrfProtection }));
  // Frueherer Pfad (fachlich falsch 'Debitoren'): Lesezeichen und vor dem Deployment geladene
  // Formulare werden weitergeleitet; 308 erhaelt Methode und Body, die Pruefungen gelten am Ziel.
  app.use('/admin/debitoren', (req, res) => res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, `/admin/kreditoren${req.url.replace(/^\/(?=\?|$)/, '')}`));
  app.use('/admin/kreditkarten', requirePermission(db, config, 'kreditkarten_verwalten'), createKreditkartenAdminRouter({ db, csrfProtection }));
  app.use('/admin/budgets', requirePermission(db, config, 'budgets_verwalten'), createBudgetsRouter({ db, csrfProtection }));
  app.use('/admin/benachrichtigungen', requirePermission(db, config, 'benachrichtigungen_verwalten'), createBenachrichtigungenRouter({ db, config, mailer, csrfProtection }));
  // Frühere Seiten (Lesezeichen): Eskalationszeiten und Mail-Einstellungen sind jetzt Ereignisse dort.
  app.get('/admin/eskalation', (req, res) => res.redirect('/admin/benachrichtigungen/reminder'));
  app.get('/admin/mail-einstellungen', (req, res) => res.redirect('/admin/benachrichtigungen/zusammenfassung'));
  app.use('/admin/erscheinungsbild', requirePermission(db, config, 'erscheinungsbild_verwalten'), createErscheinungsbildRouter({ db, config, csrfProtection }));
  app.use('/admin/ersteinrichtung', requirePermission(db, config, 'ersteinrichtung_verwalten'), createErsteinrichtungRouter({ db, config, mailer, statusCache, csrfProtection }));
  // Test-Instanz: TSA-Zugang nicht speicherbar (die Spiel-DB hält ihn ohnehin leer), keine Backups.
  const imTestmodusGesperrt = (message) => (req, res) => res.status(403).render('error', { message });
  if (testmodus) app.post('/admin/zeitstempel', imTestmodusGesperrt('Der Zeitstempeldienst ist im Testmodus deaktiviert.'));
  app.use('/admin/zeitstempel', requirePermission(db, config, 'zeitstempel_verwalten'), createZeitstempelAdminRouter({ db, config, mailer, csrfProtection }));
  app.use('/admin/personen', requirePermission(db, config, 'personen_einsehen'), createPersonenRouter({ db, config, csrfProtection }));
  app.use('/admin/mails', requirePermission(db, config, 'mails_einsehen'), createMailsRouter({ db, mailer, csrfProtection }));
  app.use('/admin/sync', requirePermission(db, config, 'sync_einsehen'), createSyncRouter({ db, config, csrfProtection }));
  app.use('/admin/abgelehnt', requirePermission(db, config, 'abgelehnt_verwalten'), createAdminAbgelehntRouter({ db, config, csrfProtection }));
  app.use('/admin/vorgaenge', requirePermission(db, config, 'vorgaenge_einsehen'), createVorgaengeRouter({ db, config, mailer, csrfProtection }));
  app.use('/admin/audit-log', requirePermission(db, config, 'audit_log_einsehen'), createAuditLogRouter({ db }));
  app.use('/admin/geplante-jobs', requirePermission(db, config, 'geplante_jobs_verwalten'), createGeplanteJobsRouter({ db, config, mailer, csrfProtection }));
  if (testmodus) app.use('/admin/backup', imTestmodusGesperrt('Backups sind im Testmodus nicht verfügbar.'));
  else app.use('/admin/backup', requirePermission(db, config, 'backup_verwalten'), createBackupRouter({ db, config, csrfProtection }));
  app.use('/admin/module', requirePermission(db, config, 'module_verwalten'), createModuleRouter({ db, csrfProtection }));
  app.use('/admin/wartungsmodus', requirePermission(db, config, 'wartungsmodus_schalten'), createWartungsmodusRouter({ db, csrfProtection }));
  app.use('/admin/gruppenrechte', requirePermission(db, config, 'gruppenrechte_verwalten'), createGruppenrechteRouter({ db, config, csrfProtection }));
  app.use('/admin/altfaelle', requirePermission(db, config, 'workflow_eingreifen'), createAltfaelleRouter({ db, config, csrfProtection }));
  app.use('/admin/dateiquarantaene', requirePermission(db, config, 'dateiquarantaene_verwalten'), createDateiQuarantaeneRouter({ db, config, csrfProtection }));
  if (testmodus) app.use('/testmodus', sessionLimiter, requireLogin(), createTestmodusInstanzRouter({ db, config, mailer, csrfProtection }));
  if (testmodusSteuerung) app.use('/admin/testmodus', requirePermission(db, config, 'testmodus_nutzen'), createTestmodusRouter({ db, steuerung: testmodusSteuerung, csrfProtection }));
  app.use('/admin/betrieb', requirePermission(db, config, 'betrieb_einsehen'), createBetriebRouter({ db, config, statusCache, csrfProtection }));

  // ---- Maschinenrouten (ohne Session, mit Schlüssel): n8n-Rechnungseingang/-abholung, Backup, Kreditkartenbelege, Rapporte ----
  // Vertrag: docs/n8n-schnittstelle.md. Das Backup hat einen eigenen Schlüssel (BACKUP_API_KEY).
  app.use('/api/n8n/jobs', machineLimiter, requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  app.use('/api/n8n/backup', machineLimiter, requireApiKey({ n8nApiKey: config.backupApiKey }), createN8nBackupRouter({ config }));
  app.use('/api/n8n/kk-belege', machineLimiter, requireApiKey(config), createN8nKkBelegeRouter({ db, config, mailer }));
  app.use('/api/n8n/rapporte', machineLimiter, requireApiKey(config), createN8nRapporteRouter({ db, config }));
  // ---- Portal-Seiten für angemeldete Personen ----
  app.use('/api/pool', sessionLimiter, requireRole(config, 'buchhaltung'), createPoolRouter({ db, csrfProtection }));
  // Dashboard für jede angemeldete Person, nicht nur Buchhaltung/Superadmin: "/" leitet immer hierher, seit die
  // alte Startseite entfallen ist, und auch eine reine Freigeber-1/2-Person (ohne Gruppenzugehörigkeit,
  // AUTH-WIDEN-1) braucht einen Einstieg. Der Pool der unzugewiesenen Rechnungen bleibt innerhalb von pool.ejs
  // beschränkt (über isBuchhaltung/isSuperadmin aus loadNavFlags) — nur das Routen-Tor ist weiter, nicht wer
  // den firmenweiten Pool sieht.
  app.use('/pool', sessionLimiter, requireLogin(), createPoolPageRouter({ db, config, mailer, csrfProtection }));
  app.use('/meine-abgeschlossenen', sessionLimiter, requireLogin(), createMeineAbgeschlossenenRouter({ db, config }));
  app.use('/auswertung', sessionLimiter, requireLogin(), createAuswertungRouter({ db, config }));
  app.use('/meine-spesen', sessionLimiter, requireLogin(), createMeineSpesenRouter({ db, config }));
  app.use('/kreditkarte', sessionLimiter, requireLogin(), createKreditkarteRouter({ db, config, csrfProtection }));
  app.use('/banner', sessionLimiter, requireLogin(), createBannerRouter({ db, csrfProtection }));
  app.use('/datenschutz', sessionLimiter, requireLogin(), createDatenschutzRouter({ db }));
  app.use('/fehler-melden', sessionLimiter, requireLogin(), createFehlerMeldenRouter({ db, config, mailer, csrfProtection }));
  app.use('/meine-benachrichtigungen', sessionLimiter, requireLogin(), createMeineBenachrichtigungenRouter({ db, config, mailer, csrfProtection }));
  app.use('/ferienmodus', sessionLimiter, requireLogin(), createFerienmodusRouter({ db, csrfProtection }));
  app.use('/downloads', createDownloadsRouter({ db, config, sessionLimiter, publicLimiter }));
  app.use('/kontierung', sessionLimiter, requireLogin(), createKkAbgleichRouter({ db, config, mailer, csrfProtection }));
  app.use('/kontierung', sessionLimiter, requireLogin(), createKontierungRouter({ db, config, mailer, csrfProtection }));
  app.use('/spesen', sessionLimiter, requireLogin(), createSpesenRouter({ db, config, mailer, csrfProtection }));
  app.use('/spesen-freigabe1', sessionLimiter, requireLogin(), createSpesenFreigabe1Router({ db, config, mailer, csrfProtection }));
  app.use('/freigabe2', sessionLimiter, requireLogin(), createFreigabe2Router({ db, config, mailer, csrfProtection }));
  app.use('/abgelehnt', sessionLimiter, requireLogin(), createAblehnungRouter({ db, config, csrfProtection }));
  app.use('/zeitstempel-pruefen', sessionLimiter, requireLogin(), createZeitstempelPruefenRouter({ db, config, csrfProtection }));
  app.use('/kommentare', sessionLimiter, requireLogin(), createKommentareRouter({ db, config, mailer, csrfProtection }));
  app.use('/rapporte', sessionLimiter, requireLogin(), createRapporteRouter({ db, config, mailer, csrfProtection }));

  // ---- Anmeldung, öffentliche Prüfseite und Cron-Aufrufe ----
  if (!testmodus) app.use('/auth', publicLimiter, createAuthRouter({ db, config, mailer, csrfProtection }));
  // Oeffentlich fuer die Revision (ohne Portal-Login), nur GET.
  app.use('/audit-pruefen', publicLimiter, createAuditPruefenRouter({ db }));
  app.use('/internal/cron', machineLimiter, requireCronSecret(config), createCronRouter({ db, config, mailer }));

  // Keine eigene Startseite: "/" führt angemeldete Personen direkt ins Dashboard (/pool), anonyme zur Anmeldung.
  app.get('/', publicLimiter, (req, res) => {
    res.redirect(req.currentPerson ? '/pool' : '/auth/login');
  });

  // Alles, was kein Router beantwortet hat.
  app.use((req, res) => {
    res.status(404).render('error', { message: 'Seite nicht gefunden.' });
  });

  // Zentraler Fehler-Handler (muss als letzter registriert sein): CSRF-Fehler → 403, kaputter Anfrage-Inhalt → 400,
  // alles andere → 500 mit kurzer Fehler-ID, die in der Betriebsseite (betrieb_fehler) nachgeschlagen werden kann.
  app.use((err, req, res, next) => {
    res.locals.branding ??= { primaryColor: null, secondaryColor: null, hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    if (err.code === 'EBADCSRFTOKEN') {
      // Meist ein veraltetes/abgelaufenes Formular (Session hat gewechselt, z. B. in einem anderen Tab ab- und wieder
      // angemeldet) und kein Angriff — deshalb kein Stack-Log. Als Zugriffsverweigerung wird es trotzdem
      // (gedrosselt, ohne das gesendete Token) erfasst.
      meldeZugriffVerweigert(req, { grund: 'csrf', status: 403 });
      return res
        .status(403)
        .render('error', { message: 'Sicherheitsprüfung fehlgeschlagen (ungültiges oder abgelaufenes Formular). Bitte lade die Seite neu und versuche es erneut.' });
    }
    // A4-04: Kaputter Anfrage-Inhalt (Body-Parser) ist ein Client-Fehler, kein Serverfehler, und
    // darf NICHT pro Anfrage `console.error(err.stack)` auslösen — sonst flutet ein
    // unauthentifizierter Client das Log. Erfasst werden entity.*-Fehler (kaputtes JSON, zu gross)
    // UND rohe zlib-Dekodierfehler eines defekten komprimierten Bodys (Content-Encoding: gzip +
    // Trailing-Bytes → err.code 'Z_DATA_ERROR' o.ä., ohne err.type). Beides als 400 ohne Stack-Log.
    // Der zlib-Zweig greift nur für den Anfrage-Body: body-parser markiert ihn als Client-Fehler
    // (status 400, expose). Ein serverseitiger zlib-Fehler (ohne diese Markierung) bleibt ein
    // normaler 500 mit Stack-Log und wird nicht als „Ungültiger Anfrage-Inhalt“ maskiert.
    const istKaputterBody = (typeof err.type === 'string' && err.type.startsWith('entity.'))
      || (typeof err.code === 'string' && err.code.startsWith('Z_') && (err.status ?? err.statusCode) === 400 && err.expose === true);
    if (istKaputterBody) {
      // Erfasst wird nur mit angemeldeter Person, damit anonyme Anfragen betrieb_fehler nicht füllen können.
      const fehlerId = req.currentPerson ? erfasseFehler(db, { req, err, status: 400 }).slice(0, 8) : null;
      return res.status(400).render('error', { message: 'Ungültiger Anfrage-Inhalt.', fehlerId });
    }
    console.error(err.stack || err);
    // Für das versteckte Seitenfeld im Meldeformular, falls loadNavFlags nicht mehr lief.
    res.locals.currentPath ??= String(req.originalUrl || '').split('?')[0];
    // Fehler-ID = Request-ID; angezeigt werden nur die ersten 8 Zeichen, nie der Stack.
    const fehlerId = erfasseFehler(db, { req, err, status: 500 }).slice(0, 8);
    res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.', fehlerId });
  });

  return app;
}
