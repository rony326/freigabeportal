import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env.js';

const FULL_ENV = {
  SESSION_SECRET: 'test-session-secret-please-ignore-1234567890',
  CT_BASE_URL: 'https://ct.example.org',
  CT_CLIENT_ID: 'client-id',
  CT_CLIENT_SECRET: 'test-ct-client-secret-please-ignore-1234567890',
  CT_REDIRECT_URI: 'https://portal.example.org/auth/callback',
  CT_GROUP_ID_BUCHHALTUNG: '10',
  CT_GROUP_ID_ADMIN: '20',
  CT_SYNC_SERVICE_TOKEN: 'test-ct-sync-service-token-please-ignore-1234567890',
  CT_CUSTOM_FIELD_IBAN: 'IBAN',
  CT_CUSTOM_FIELD_KONTOINHABER: 'Kontoinhaber',
  CRON_SECRET: 'test-cron-secret-please-ignore-1234567890',
  N8N_API_KEY: 'test-n8n-api-key-please-ignore-1234567890',
  DOWNLOAD_SIGNING_SECRET: 'test-download-signing-secret-please-ignore-1234567890',
  PUBLIC_BASE_URL: 'https://portal.example.org',
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

test('loadConfig throws a German error when PUBLIC_BASE_URL is missing', () => {
  const { PUBLIC_BASE_URL, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: PUBLIC_BASE_URL/);
});

test('loadConfig exposes publicBaseUrl', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.publicBaseUrl, 'https://portal.example.org');
});

test('loadConfig rejects a secret shorter than 32 characters', () => {
  const tooShort = { ...FULL_ENV, SESSION_SECRET: 'short-secret' };
  assert.throws(() => loadConfig(tooShort), /SESSION_SECRET ist zu kurz/);
});

test('loadConfig rejects the .env.example placeholder value, even if long enough', () => {
  const placeholder = { ...FULL_ENV, CRON_SECRET: 'changeme-long-random-string-1234567890' };
  assert.throws(() => loadConfig(placeholder), /CRON_SECRET verwendet noch den Platzhalterwert/);
});

test('loadConfig applies the strength check to every secret-shaped variable', () => {
  for (const name of ['SESSION_SECRET', 'DOWNLOAD_SIGNING_SECRET', 'CT_CLIENT_SECRET', 'CT_SYNC_SERVICE_TOKEN', 'CRON_SECRET', 'N8N_API_KEY']) {
    const tooShort = { ...FULL_ENV, [name]: 'x' };
    assert.throws(() => loadConfig(tooShort), new RegExp(`${name} ist zu kurz`), `${name} should be validated as a secret`);
  }
});

test('loadConfig defaults backupDir to ./data/backups and honors BACKUP_DIR', () => {
  const defaultConfig = loadConfig(FULL_ENV);
  assert.equal(defaultConfig.backupDir, './data/backups');

  const customConfig = loadConfig({ ...FULL_ENV, BACKUP_DIR: '/srv/backups' });
  assert.equal(customConfig.backupDir, '/srv/backups');
});

test('loadConfig exposes the ChurchTools custom-field names for IBAN/Kontoinhaber', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.churchtools.customFieldIban, 'IBAN');
  assert.equal(config.churchtools.customFieldKontoinhaber, 'Kontoinhaber');
});

test('loadConfig throws when CT_CUSTOM_FIELD_IBAN is missing', () => {
  const { CT_CUSTOM_FIELD_IBAN, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: CT_CUSTOM_FIELD_IBAN/);
});
