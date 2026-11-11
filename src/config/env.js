// Liest und validiert alle Umgebungsvariablen (Quelle der Wahrheit für die Konfiguration).
//
// `loadConfig()` bricht den Start mit einer klaren Fehlermeldung ab, wenn ein Pflichtwert fehlt,
// ein Geheimnis zu kurz ist (< 32 Zeichen) oder noch den Platzhalter aus `.env.example` enthält.
// Die Konfiguration wird einmal beim Start gelesen und als `config`-Objekt durchgereicht – kein
// Modul liest `process.env` selbst (Ausnahme: die CLI-Werkzeuge für die TSA-Dateien).
// Beschreibung aller Variablen: README.md (Abschnitt Konfiguration) und docs/betrieb-und-nutzung.md.

// Mindestlänge für alle Geheimnisse (Session, Download-Signatur, Cron, n8n, ChurchTools-Token …).
const MIN_SECRET_LENGTH = 32;

// Pflichtvariable: wirft, wenn sie nicht gesetzt oder leer ist.
function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

// Pflichtvariable, die zusätzlich als Geheimnis gilt: Mindestlänge und kein `changeme`-Platzhalter.
function requiredSecret(env, name) {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`Umgebungsvariable ${name} ist zu kurz (mindestens ${MIN_SECRET_LENGTH} Zeichen erforderlich).`);
  }
  if (value.toLowerCase().includes('changeme')) {
    throw new Error(
      `Umgebungsvariable ${name} verwendet noch den Platzhalterwert aus .env.example — bitte durch einen echten, zufälligen Wert ersetzen.`
    );
  }
  return value;
}

// Nur die Speicherorte (DB, Branding, Jobs/PDFs, Backups) – eigene Funktion, weil die CLI-Werkzeuge
// (Backup-Wiederherstellung, Audit-Export, TSA-Sperrlisten) den Datenspeicher ohne die restlichen
// Pflichtgeheimnisse öffnen müssen. Der tatsächlich aktive Speicher kann nach einem Restore davon
// abweichen und wird über `resolveStorageConfig()` (services/storageState.js) aufgelöst.
export function loadStorageConfig(env = process.env) {
  return {
    dbPath: env.DB_PATH || './data/freigabeportal.sqlite',
    brandingDir: env.BRANDING_DIR || './data/branding',
    jobsDir: env.JOBS_DIR || './data/jobs',
    backupDir: env.BACKUP_DIR || './data/backups',
    backupKeyringFile: env.BACKUP_KEYRING_FILE || null,
  };
}

// Vollständige Laufzeitkonfiguration für den Server. Wirft bei fehlenden/ungültigen Werten.
// Gegenseitige Abhängigkeiten, die hier geprüft werden:
//   - TSA-Vertrauensanker-Datei und ihr SHA-256 müssen zusammen gesetzt sein
//   - TSA_CRL_AUTO_UPDATE=true setzt TSA_CRL_FILE und Vertrauensanker voraus
//   - BACKUP_API_KEY (optional) darf nicht mit N8N_API_KEY übereinstimmen (getrennte Rechte)
export function loadConfig(env = process.env) {
  if (Boolean(env.TSA_TRUST_ANCHORS_FILE) !== Boolean(env.TSA_TRUST_ANCHORS_SHA256) ||
      env.TSA_TRUST_ANCHORS_SHA256 && !/^[a-f0-9]{64}$/.test(env.TSA_TRUST_ANCHORS_SHA256)) {
    throw new Error('TSA_TRUST_ANCHORS_FILE und TSA_TRUST_ANCHORS_SHA256 muessen gemeinsam mit einem gueltigen SHA-256 gesetzt werden.');
  }
  if (env.TSA_CRL_AUTO_UPDATE && (!['true', 'false'].includes(env.TSA_CRL_AUTO_UPDATE) ||
      (env.TSA_CRL_AUTO_UPDATE === 'true' && (!env.TSA_CRL_FILE || !env.TSA_TRUST_ANCHORS_FILE)))) {
    throw new Error('TSA_CRL_AUTO_UPDATE muss true oder false sein und setzt TSA_CRL_FILE sowie die TSA-Vertrauensanker voraus.');
  }
  if (env.BACKUP_API_KEY && env.BACKUP_API_KEY === env.N8N_API_KEY) {
    throw new Error('BACKUP_API_KEY muss sich von N8N_API_KEY unterscheiden.');
  }
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT) || 3000,
    sessionSecret: requiredSecret(env, 'SESSION_SECRET'),
    ...loadStorageConfig(env),
    downloadSigningSecret: requiredSecret(env, 'DOWNLOAD_SIGNING_SECRET'),
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
    churchtools: {
      baseUrl: required(env, 'CT_BASE_URL'),
      clientId: required(env, 'CT_CLIENT_ID'),
      clientSecret: requiredSecret(env, 'CT_CLIENT_SECRET'),
      redirectUri: required(env, 'CT_REDIRECT_URI'),
      groupIdBuchhaltung: required(env, 'CT_GROUP_ID_BUCHHALTUNG'),
      groupIdAdmin: required(env, 'CT_GROUP_ID_ADMIN'),
      groupIdManager: env.CT_GROUP_ID_MANAGER || null,
      syncServiceToken: requiredSecret(env, 'CT_SYNC_SERVICE_TOKEN'),
      customFieldIban: required(env, 'CT_CUSTOM_FIELD_IBAN'),
      customFieldKontoinhaber: required(env, 'CT_CUSTOM_FIELD_KONTOINHABER'),
    },
    cronSecret: requiredSecret(env, 'CRON_SECRET'),
    n8nApiKey: requiredSecret(env, 'N8N_API_KEY'),
    backupApiKey: env.BACKUP_API_KEY ? requiredSecret(env, 'BACKUP_API_KEY') : null,
    // Zeitstempel ohne gültigen Vertrauensanker gelten nie als geprüft (siehe docs/tsa-vertrauensanker.md).
    tsaTrustRequired: true,
    tsaCrlFile: env.TSA_CRL_FILE || null,
    tsaCrlAutoUpdate: env.TSA_CRL_AUTO_UPDATE === 'true',
    tsaTrustAnchorsFile: env.TSA_TRUST_ANCHORS_FILE || null,
    tsaTrustAnchorsSha256: env.TSA_TRUST_ANCHORS_SHA256 || null,
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    },
  };
}
