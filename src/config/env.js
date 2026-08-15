function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT) || 3000,
    sessionSecret: required(env, 'SESSION_SECRET'),
    dbPath: env.DB_PATH || './data/freigabeportal.sqlite',
    brandingDir: env.BRANDING_DIR || './data/branding',
    jobsDir: env.JOBS_DIR || './data/jobs',
    downloadSigningSecret: required(env, 'DOWNLOAD_SIGNING_SECRET'),
    churchtools: {
      baseUrl: required(env, 'CT_BASE_URL'),
      clientId: required(env, 'CT_CLIENT_ID'),
      clientSecret: required(env, 'CT_CLIENT_SECRET'),
      redirectUri: required(env, 'CT_REDIRECT_URI'),
      groupIdBuchhaltung: required(env, 'CT_GROUP_ID_BUCHHALTUNG'),
      groupIdAdmin: required(env, 'CT_GROUP_ID_ADMIN'),
      syncServiceToken: required(env, 'CT_SYNC_SERVICE_TOKEN'),
    },
    cronSecret: required(env, 'CRON_SECRET'),
    n8nApiKey: required(env, 'N8N_API_KEY'),
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    },
  };
}
