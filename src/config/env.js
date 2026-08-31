const MIN_SECRET_LENGTH = 32;

function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

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

export function loadConfig(env = process.env) {
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT) || 3000,
    sessionSecret: requiredSecret(env, 'SESSION_SECRET'),
    dbPath: env.DB_PATH || './data/freigabeportal.sqlite',
    brandingDir: env.BRANDING_DIR || './data/branding',
    jobsDir: env.JOBS_DIR || './data/jobs',
    backupDir: env.BACKUP_DIR || './data/backups',
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
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    },
  };
}
