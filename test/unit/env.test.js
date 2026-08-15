import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env.js';

const FULL_ENV = {
  SESSION_SECRET: 'secret',
  CT_BASE_URL: 'https://ct.example.org',
  CT_CLIENT_ID: 'client-id',
  CT_CLIENT_SECRET: 'client-secret',
  CT_REDIRECT_URI: 'https://portal.example.org/auth/callback',
  CT_GROUP_ID_BUCHHALTUNG: '10',
  CT_GROUP_ID_ADMIN: '20',
  CT_SYNC_SERVICE_TOKEN: 'sync-token',
  CRON_SECRET: 'cron-secret',
  N8N_API_KEY: 'n8n-key',
  DOWNLOAD_SIGNING_SECRET: 'download-signing-secret',
  SMTP_HOST: 'smtp.example.org',
  SMTP_USER: 'smtp-user',
  SMTP_PASS: 'smtp-pass',
  SMTP_FROM: 'portal@example.org',
};

test('loadConfig returns full config when all variables are set', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.churchtools.baseUrl, 'https://ct.example.org');
  assert.equal(config.smtp.port, 587);
  assert.equal(config.port, 3000);
});

test('loadConfig throws a German error when a required variable is missing', () => {
  const { SESSION_SECRET, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: SESSION_SECRET/);
});

test('loadConfig.env reflects NODE_ENV or defaults to development', () => {
  const withNode = loadConfig({ ...FULL_ENV, NODE_ENV: 'production' });
  assert.equal(withNode.env, 'production');

  const withoutNode = loadConfig(FULL_ENV);
  assert.equal(withoutNode.env, 'development');
});

test('loadConfig succeeds when SMTP_* variables are absent, leaving smtp fields undefined', () => {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM, ...withoutSmtp } = FULL_ENV;
  const config = loadConfig(withoutSmtp);
  assert.equal(config.smtp.host, undefined);
  assert.equal(config.smtp.user, undefined);
  assert.equal(config.smtp.pass, undefined);
  assert.equal(config.smtp.from, undefined);
  assert.equal(config.smtp.port, 587);
});

test('loadConfig defaults jobsDir and requires downloadSigningSecret', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.jobsDir, './data/jobs');
  const { DOWNLOAD_SIGNING_SECRET, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: DOWNLOAD_SIGNING_SECRET/);
});
