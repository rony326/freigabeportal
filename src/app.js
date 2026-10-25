import { parseEmpfaengerListe } from './services/auditNachweisJobs.js';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { loadCurrentPerson, loadBeispielperson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';
import { requireAdminAreaAccess, requirePermission } from './middleware/permissions.js';
import { loadNavFlags } from './middleware/nav.js';
import { loadBranding } from './middleware/branding.js';
import { createBrandingRouter } from './routes/branding.js';
import { createKontenRouter } from './routes/admin/konten.js';
import { createKreditorenRouter } from './routes/admin/kreditoren.js';
import { createKreditkartenAdminRouter } from './routes/admin/kreditkarten.js';
import { createEskalationRouter } from './routes/admin/eskalation.js';
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
import { createAuditLogRouter } from './routes/admin/auditLog.js';
import { createGeplanteJobsRouter } from './routes/admin/geplanteJobs.js';
import { createBackupRouter } from './routes/admin/backup.js';
import { createModuleRouter } from './routes/admin/module.js';
import { createMailEinstellungenRouter } from './routes/admin/mailEinstellungen.js';
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

// `mailer` is injectable for tests (a stub instead of the SMTP-backed default).
// `testmodus`: Test-Instanz auf der Spiel-DB — ohne Sitzung (kommt von der echten App), ohne
// Login und /healthz, ohne TSA-Probe, Mailer = Test-Mailer; Person = gewählte Beispielperson.
// `limiter`: von aussen gereichte Rate-Limiter (die echte App gibt der Test-Instanz einen festen
// Satz, damit ein Zurücksetzen keine neuen MemoryStore-Timer und alten App-Graphen zurücklässt).
export function createApp({ db, config, mailer: injectedMailer = null, tsaVersuch = undefined, testmodus = false, limiter = null }) {
  const app = express();
  // Eine TSA-Probe und ein Status-Cache (30 s) fuer /healthz, Dashboard und Statusseite.
  const statusCache = createStatusCache({ db, config, tsaErreichbarkeit: testmodus ? null : createTsaErreichbarkeit(), tsaVersuch });
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
  // Computed once at startup, not per request — the deployed commit doesn't change while the
  // process is running, and shelling out to git on every request would be wasteful.
  app.locals.version = getVersionInfo(join(__dirname, '..'));
  app.locals.zeitpunktAnzeige = zeitpunktAnzeige;
  app.use((req, res, next) => {
    // X-Content-Type-Options: the PDF magic-byte check on upload only validates the first 4
    // bytes, so this stops a browser from sniffing a crafted upload into something other than
    // its declared Content-Type when served back from /downloads or /branding.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options: SAMEORIGIN, not DENY — kontierung.ejs, freigabe2.ejs, and pool.ejs all
    // embed the signed-download-URL PDF preview in a same-origin <iframe>, and DENY blocks
    // framing even from the same origin. SameSite=Lax cookies already aren't sent on cross-site
    // framed subresource requests, so SAMEORIGIN still closes the cross-site framing case.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Referrer-Policy: signed download URLs carry their signature in the query string
    // (services/downloadUrl.js) and are embedded in <iframe> previews — without this, a link
    // clicked inside a rendered invoice PDF could leak a live, still-valid download URL to a
    // third party via the Referer header.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Content-Security-Policy: defense-in-depth backstop, not the primary XSS defense — every EJS
    // view was audited to only ever use auto-escaping `<%= %>` on user-controlled data. `<%- %>`
    // (raw output) is used for `include()`s and for two view-local helpers that concatenate
    // include() results into HTML strings: `jobListe` in views/pool.ejs and `kkListe` in
    // views/kreditkarte.ejs. Those helpers interpolate nothing but the (self-escaping) partials'
    // output and fixed CSS class names — headings and other data stay outside, in `<%= %>`; the
    // "Roh-Ausgabe-Sweep" in test/integration/layoutSweep.test.js enforces this. So there's no
    // known unescaped-output path today. 'unsafe-inline' is required for script-src/style-src
    // because several views use inline <script> blocks and style="" attributes without nonces; a
    // future refactor to nonce-based CSP could drop it. Still meaningfully restricts where a future injection could
    // load resources from or exfiltrate to, and blocks base-tag/form-action hijacking outright.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; " +
        "form-action 'self'; frame-ancestors 'self'"
    );
    next();
  });
  // Frueh gemountet: kein Session-Cookie, kein CSRF, eigener Limiter (120/min/IP).
  if (!testmodus) app.use('/healthz', createHealthzRouter({ db, config, statusCache }));
  app.use(auditRequestContext);
  app.use(express.static(join(__dirname, '..', 'public')));
  app.use(loadBranding(db));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  if (!testmodus) app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // Derived from publicBaseUrl (always required in production via env.js) rather than
        // NODE_ENV, which nothing enforces being set correctly on the host — an unset NODE_ENV
        // would otherwise silently boot the app without the Secure flag on a TLS-required deployment.
        secure: Boolean(config.publicBaseUrl?.startsWith('https://')),
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );
  // cookie-parser must run after express-session (session parses its own cookie first) and
  // before the CSRF middleware, which reads/writes its own separate, non-session cookie.
  app.use(cookieParser());
  app.use(ansichtWahl());
  const { attachCsrfToken, csrfProtection, generateCsrfToken } = createCsrfProtection(config);
  app.use((req, res, next) => {
    // /api/n8n/* and /internal/cron/* are machine routes authenticated via X-API-Key /
    // X-Cron-Secret headers, never session cookies — they send no CSRF cookie or token and must
    // stay exempt. /api/pool is session-cookie authenticated (its beanspruchen button is a
    // fetch() call, protected via the x-csrf-token header instead of a form field) and does need
    // this.
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
  app.use(nutzungErfassen(db));
  app.use(auditContext);
  app.use(zugriffsAuditMiddleware(db));
  app.use(loadNavFlags(db, config));

  const mailer = injectedMailer ?? (testmodus ? createTestMailer() : createMailerOrFallback(config.smtp));

  const publicLimiter = limiter?.publicLimiter ?? createPublicRateLimiter();
  const sessionLimiter = limiter?.sessionLimiter ?? createSessionRateLimiter();
  const machineLimiter = limiter?.machineLimiter ?? createMachineRateLimiter();

  app.use('/branding', publicLimiter, createBrandingRouter({ db }));
  app.use('/admin', sessionLimiter, requireAdminAreaAccess(db, config));
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
    if (!testmodus && res.locals.isSuperadmin === true && !einrichtungAbgeschlossenAm(db)) {
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
      auditRevisionEmpfaengerFehlt: res.locals.isSuperadmin === true
        && getConfigValue(db, 'modul_audit_nachweis_aktiv') === '1'
        && parseEmpfaengerListe(getConfigValue(db, 'audit_revision_empfaenger')).adressen.length === 0,
    });
  });
  app.use('/admin/konten', requirePermission(db, config, 'konten_verwalten'), createKontenRouter({ db, csrfProtection }));
  app.use('/admin/kreditoren', requirePermission(db, config, 'kreditoren_verwalten'), createKreditorenRouter({ db, csrfProtection }));
  // Frueherer Pfad (fachlich falsch 'Debitoren'): Lesezeichen und vor dem Deployment geladene
  // Formulare werden weitergeleitet; 308 erhaelt Methode und Body, die Pruefungen gelten am Ziel.
  app.use('/admin/debitoren', (req, res) => res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, `/admin/kreditoren${req.url.replace(/^\/(?=\?|$)/, '')}`));
  app.use('/admin/kreditkarten', requirePermission(db, config, 'kreditkarten_verwalten'), createKreditkartenAdminRouter({ db, csrfProtection }));
  app.use('/admin/eskalation', requireRole(config, 'superadmin'), createEskalationRouter({ db, csrfProtection }));
  app.use('/admin/erscheinungsbild', requireRole(config, 'superadmin'), createErscheinungsbildRouter({ db, config, csrfProtection }));
  app.use('/admin/ersteinrichtung', requireRole(config, 'superadmin'), createErsteinrichtungRouter({ db, config, mailer, statusCache, csrfProtection }));
  // Test-Instanz: TSA-Zugang nicht speicherbar (die Spiel-DB hält ihn ohnehin leer), keine Backups.
  const imTestmodusGesperrt = (message) => (req, res) => res.status(403).render('error', { message });
  if (testmodus) app.post('/admin/zeitstempel', imTestmodusGesperrt('Der Zeitstempeldienst ist im Testmodus deaktiviert.'));
  app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db, config, mailer, csrfProtection }));
  app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config, csrfProtection }));
  app.use('/admin/mails', requirePermission(db, config, 'mails_einsehen'), createMailsRouter({ db, mailer, csrfProtection }));
  app.use('/admin/sync', requirePermission(db, config, 'sync_einsehen'), createSyncRouter({ db, config, csrfProtection }));
  app.use('/admin/abgelehnt', requirePermission(db, config, 'abgelehnt_verwalten'), createAdminAbgelehntRouter({ db, config, csrfProtection }));
  app.use('/admin/vorgaenge', requirePermission(db, config, 'vorgaenge_einsehen'), createVorgaengeRouter({ db, config, mailer, csrfProtection }));
  app.use('/admin/audit-log', requirePermission(db, config, 'audit_log_einsehen'), createAuditLogRouter({ db }));
  app.use('/admin/geplante-jobs', requirePermission(db, config, 'geplante_jobs_verwalten'), createGeplanteJobsRouter({ db, config, mailer, csrfProtection }));
  if (testmodus) app.use('/admin/backup', imTestmodusGesperrt('Backups sind im Testmodus nicht verfügbar.'));
  else app.use('/admin/backup', requireRole(config, 'superadmin'), createBackupRouter({ db, config, csrfProtection }));
  app.use('/admin/module', requireRole(config, 'superadmin'), createModuleRouter({ db, csrfProtection }));
  app.use('/admin/mail-einstellungen', requireRole(config, 'superadmin'), createMailEinstellungenRouter({ db, config, mailer, csrfProtection }));
  app.use('/admin/altfaelle', requirePermission(db, config, 'workflow_eingreifen'), createAltfaelleRouter({ db, config, csrfProtection }));
  app.use('/admin/dateiquarantaene', requireRole(config, 'superadmin'), createDateiQuarantaeneRouter({ db, config, csrfProtection }));
  if (testmodus) app.use('/testmodus', sessionLimiter, requireLogin(), createTestmodusInstanzRouter({ db, config, mailer, csrfProtection }));
  if (testmodusSteuerung) app.use('/admin/testmodus', requireAnyRole(config, ['superadmin', 'manager']), createTestmodusRouter({ db, steuerung: testmodusSteuerung, csrfProtection }));
  app.use('/admin/betrieb', requirePermission(db, config, 'betrieb_einsehen'), createBetriebRouter({ db, config, statusCache, csrfProtection }));

  app.use('/api/n8n/jobs', machineLimiter, requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  app.use('/api/n8n/backup', machineLimiter, requireApiKey({ n8nApiKey: config.backupApiKey }), createN8nBackupRouter({ config }));
  app.use('/api/n8n/kk-belege', machineLimiter, requireApiKey(config), createN8nKkBelegeRouter({ db, config, mailer }));
  app.use('/api/pool', sessionLimiter, requireRole(config, 'buchhaltung'), createPoolRouter({ db, csrfProtection }));
  // Dashboard for every logged-in person, not just Buchhaltung/Superadmin: "/" always redirects
  // here now that the old landing page is gone, and a Freigeber1/2-only person (no group
  // membership, AUTH-WIDEN-1) needs somewhere to land too. The pool-of-unassigned-invoices
  // section itself stays restricted inside pool.ejs (gated on isBuchhaltung/isSuperadmin from
  // loadNavFlags) — only the route-level gate widens, not who can see the company-wide pool.
  app.use('/pool', sessionLimiter, requireLogin(), createPoolPageRouter({ db, config, mailer, csrfProtection }));
  app.use('/meine-abgeschlossenen', sessionLimiter, requireLogin(), createMeineAbgeschlossenenRouter({ db }));
  app.use('/meine-spesen', sessionLimiter, requireLogin(), createMeineSpesenRouter({ db }));
  app.use('/kreditkarte', sessionLimiter, requireLogin(), createKreditkarteRouter({ db, config, csrfProtection }));
  app.use('/banner', sessionLimiter, requireLogin(), createBannerRouter({ db, csrfProtection }));
  app.use('/datenschutz', sessionLimiter, requireLogin(), createDatenschutzRouter({ db }));
  app.use('/fehler-melden', sessionLimiter, requireLogin(), createFehlerMeldenRouter({ db, config, mailer, csrfProtection }));
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

  if (!testmodus) app.use('/auth', publicLimiter, createAuthRouter({ db, config, mailer, csrfProtection }));
  // Oeffentlich fuer die Revision (ohne Portal-Login), nur GET.
  app.use('/audit-pruefen', publicLimiter, createAuditPruefenRouter({ db }));
  app.use('/internal/cron', machineLimiter, requireCronSecret(config), createCronRouter({ db, config, mailer }));

  // No standalone landing page: every visit to "/" goes straight to the dashboard (/pool) for a
  // logged-in person, or to login for an anonymous one.
  app.get('/', publicLimiter, (req, res) => {
    res.redirect(req.currentPerson ? '/pool' : '/auth/login');
  });

  app.use((req, res) => {
    res.status(404).render('error', { message: 'Seite nicht gefunden.' });
  });

  app.use((err, req, res, next) => {
    res.locals.branding ??= { primaryColor: null, secondaryColor: null, hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    if (err.code === 'EBADCSRFTOKEN') {
      // Most likely a stale/expired form (session changed since it was loaded, e.g. logged out
      // and back in another tab) rather than an actual attack — no need to log.stack this one.
      // Still recorded (throttled, without the submitted token) as a denied access.
      meldeZugriffVerweigert(req, { grund: 'csrf', status: 403 });
      return res
        .status(403)
        .render('error', { message: 'Sicherheitsprüfung fehlgeschlagen (ungültiges oder abgelaufenes Formular). Bitte lade die Seite neu und versuche es erneut.' });
    }
    if (typeof err.type === 'string' && err.type.startsWith('entity.')) {
      // Kaputter Anfrage-Inhalt (Body-Parser): Fehler der Anfrage, kein Serverfehler. Erfasst wird
      // nur mit angemeldeter Person, damit anonyme Anfragen betrieb_fehler nicht füllen können.
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
