import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sichereRueckkehr } from '../../src/utils/rueckkehrZiel.js';

test('erlaubt eigene Seitenpfade, auch mit Query', () => {
  assert.equal(sichereRueckkehr('/kontierung/123'), '/kontierung/123');
  assert.equal(sichereRueckkehr('/zeitstempel-pruefen?jobId=5'), '/zeitstempel-pruefen?jobId=5');
  assert.equal(sichereRueckkehr('/admin/konten'), '/admin/konten');
});

test('lehnt Fremdes und Fehlformen ab', () => {
  for (const x of [
    undefined, null, 42, '', 'kontierung/1', 'https://evil.example/x', 'http://evil.example', '//evil.example/x', '/\\evil.example', '\\\\evil.example',
    '/a\\b', '/a\r\nSet-Cookie: x=1', '/a\u0000b', '/a b', '/a#frag', '/' + 'a'.repeat(400), 'javascript:alert(1)', '/%0d%0aX',
  ]) assert.equal(sichereRueckkehr(x), null, JSON.stringify(x));
});

test('lehnt Ziele ab, die kein HTML-Ziel sind', () => {
  for (const x of [
    '/auth/login', '/auth/callback?code=1', '/auth/abgemeldet', '/api/pool/1', '/api/n8n/jobs', '/internal/cron/x', '/healthz', '/downloads/1/oeffnen',
    '/branding/logo', '/audit-pruefen', '/admin/backup/dateien/x.fpbak', '/auswertung/export/konten.csv', '/kreditkarte/belege/3/datei', '/AUTH/login', '/Downloads/1',
  ]) assert.equal(sichereRueckkehr(x), null, x);
});
