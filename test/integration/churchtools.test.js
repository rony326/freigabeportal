import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchPerson,
  fetchPersonById,
  fetchGroupMemberIds,
  resolveMemberGroupIds,
  extractCustomFieldValue,
} from '../../src/services/churchtools.js';

const CONFIG = {
  baseUrl: 'https://ct.example.org',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://portal.example.org/auth/callback',
};

test('buildAuthorizeUrl includes client id, redirect uri and state', () => {
  const url = new URL(buildAuthorizeUrl(CONFIG, 'the-state'));
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('state'), 'the-state');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('exchangeCodeForToken returns the parsed token response', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/oauth/access_token', method: 'POST' })
    .reply(200, { access_token: 'abc123', token_type: 'Bearer' });

  const result = await exchangeCodeForToken(CONFIG, 'the-code');
  assert.equal(result.access_token, 'abc123');
});

test('exchangeCodeForToken throws on a non-ok response', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(401, {});
  await assert.rejects(() => exchangeCodeForToken(CONFIG, 'bad-code'));
});

test('fetchPerson returns the whoami payload', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });

  const person = await fetchPerson(CONFIG, 'token');
  assert.equal(person.firstName, 'Max');
});

test('fetchPersonById returns a specific person by id', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/api/persons/9', method: 'GET' })
    .reply(200, { data: { id: 9, firstName: 'Ana', lastName: 'Muster', email: 'ana@example.org' } });

  const person = await fetchPersonById(CONFIG, 'token', 9);
  assert.equal(person.lastName, 'Muster');
});

test('fetchGroupMemberIds returns member ids as strings', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/api/groups/42/members', method: 'GET' })
    .reply(200, { data: [{ personId: 7 }, { personId: 9 }] });

  const ids = await fetchGroupMemberIds(CONFIG, 'token', 42);
  assert.deepEqual(ids, ['7', '9']);
});

test('resolveMemberGroupIds returns only groups the person belongs to', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 5 }] });

  const groups = await resolveMemberGroupIds(CONFIG, 'token', 7, ['10', '20']);
  assert.deepEqual(groups, ['10']);
});

test('extractCustomFieldValue reads a flat top-level property by its exact key and returns its trimmed value', () => {
  const person = { id: 9, iban_1: '  CH93 0076 2011 6238 5295 7  ', kontoinhaber: 'Max Muster' };
  assert.equal(extractCustomFieldValue(person, 'iban_1'), 'CH93 0076 2011 6238 5295 7');
  assert.equal(extractCustomFieldValue(person, 'kontoinhaber'), 'Max Muster');
});

test('extractCustomFieldValue returns null when the property is missing, empty, null, or the person itself is null', () => {
  assert.equal(extractCustomFieldValue({ id: 9 }, 'iban_1'), null, 'property absent entirely');
  assert.equal(extractCustomFieldValue({ id: 9, iban_1: '' }, 'iban_1'), null, 'empty string');
  assert.equal(extractCustomFieldValue({ id: 9, iban_1: null }, 'iban_1'), null, 'explicit null');
  assert.equal(extractCustomFieldValue(null, 'iban_1'), null, 'no person at all');
  assert.equal(extractCustomFieldValue({ id: 9, iban_1: 'CH93' }, null), null, 'no field key given');
});

// ---- Gruppenmitglieder: Statusfilter, Blättern, Personenfeld (Befunde S1, B1, B5) ----

// Stellt eine Gruppe mit `mitglieder` bereit und antwortet wie ChurchTools seitenweise (limit/page aus der Anfrage).
// Gibt die Liste der gesehenen Anfragepfade zurück. `ohneLastPage`: meta.pagination ohne lastPage.
function stelleGruppeBereit(client, gruppenId, mitglieder, { ohneLastPage = false, fehlerAufSeite = null } = {}) {
  const anfragen = [];
  client
    .intercept({ path: (p) => p.startsWith(`/api/groups/${gruppenId}/members`), method: 'GET' })
    .reply((opts) => {
      anfragen.push(opts.path);
      const q = new URL(opts.path, 'https://ct.example.org').searchParams;
      const limit = Number(q.get('limit') ?? 10);
      const seite = Number(q.get('page') ?? 1);
      if (seite === fehlerAufSeite) return { statusCode: 500, data: {} };
      const pagination = { total: mitglieder.length, limit, current: seite };
      if (!ohneLastPage) pagination.lastPage = Math.max(1, Math.ceil(mitglieder.length / limit));
      return { statusCode: 200, data: { data: mitglieder.slice((seite - 1) * limit, seite * limit), meta: { count: 0, pagination } } };
    })
    .persist();
  return anfragen;
}

const aktiv = (id) => ({ personId: id, person: { domainIdentifier: String(id) }, groupMemberStatus: 'active' });

test('S1: fetchGroupMemberIds sendet den Statusfilter active und limit=200', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  const anfragen = stelleGruppeBereit(client, 42, [aktiv(1)]);
  await fetchGroupMemberIds(CONFIG, 'token', 42);
  const q = new URL(anfragen[0], 'https://ct.example.org').searchParams;
  assert.deepEqual(q.getAll('group_member_statuses[]'), ['active']);
  assert.equal(q.get('limit'), '200');
});

test('S1: Einträge mit Status requested, waiting oder to_delete zählen nicht als Mitglied', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  stelleGruppeBereit(client, 42, [
    aktiv(1),
    { personId: 2, groupMemberStatus: 'requested' },
    { personId: 3, groupMemberStatus: 'waiting' },
    { personId: 4, groupMemberStatus: 'to_delete' },
    { personId: 5 }, // ohne Status: im Zweifel kein Mitglied
  ]);
  assert.deepEqual(await fetchGroupMemberIds(CONFIG, 'token', 42), ['1']);
});

test('B1: 11 Mitglieder über zwei Seiten werden vollständig gelesen', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  // Server mit kleinem Seitenlimit (Maximum serverseitig 10): die Antwort-Pagination bestimmt das Blättern.
  const mitglieder = Array.from({ length: 11 }, (_, i) => aktiv(i + 1));
  client
    .intercept({ path: (p) => p.startsWith('/api/groups/42/members'), method: 'GET' })
    .reply((opts) => {
      const seite = Number(new URL(opts.path, 'https://ct.example.org').searchParams.get('page') ?? 1);
      return { statusCode: 200, data: { data: mitglieder.slice((seite - 1) * 10, seite * 10), meta: { pagination: { total: 11, limit: 10, current: seite, lastPage: 2 } } } };
    })
    .persist();
  const ids = await fetchGroupMemberIds(CONFIG, 'token', 42);
  assert.equal(ids.length, 11);
  assert.equal(ids[10], '11');
});

test('B1: 201 Mitglieder werden mit limit=200 auf zwei Seiten gelesen', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  const anfragen = stelleGruppeBereit(client, 42, Array.from({ length: 201 }, (_, i) => aktiv(i + 1)));
  const ids = await fetchGroupMemberIds(CONFIG, 'token', 42);
  assert.equal(ids.length, 201);
  assert.equal(new Set(ids).size, 201);
  assert.equal(anfragen.length, 2);
});

test('B1: ohne lastPage hört das Blättern bei einer Seite mit weniger als limit Einträgen auf', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  const anfragen = stelleGruppeBereit(client, 42, Array.from({ length: 201 }, (_, i) => aktiv(i + 1)), { ohneLastPage: true });
  assert.equal((await fetchGroupMemberIds(CONFIG, 'token', 42)).length, 201);
  assert.equal(anfragen.length, 2);
});

test('B1: ein Fehler auf einer späteren Seite wirft, statt eine unvollständige Liste zu liefern', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  stelleGruppeBereit(client, 42, Array.from({ length: 250 }, (_, i) => aktiv(i + 1)), { fehlerAufSeite: 2 });
  await assert.rejects(() => fetchGroupMemberIds(CONFIG, 'token', 42), (err) => err.status === 500);
});

test('B1: endloses Blättern wird durch eine Seitenobergrenze abgebrochen (Fehler, keine Teilliste)', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  // Fehlerhafter Server: jede Seite ist voll und lastPage fehlt.
  client
    .intercept({ path: (p) => p.startsWith('/api/groups/42/members'), method: 'GET' })
    .reply(200, () => ({ data: Array.from({ length: 200 }, (_, i) => aktiv(i + 1)), meta: { pagination: { current: 1 } } }))
    .persist();
  await assert.rejects(() => fetchGroupMemberIds(CONFIG, 'token', 42), /Seiten/);
});

test('B5: person.domainIdentifier wird gelesen, wenn personId fehlt; personId bleibt als Rückfall', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  stelleGruppeBereit(client, 42, [
    { person: { domainIdentifier: '11' }, groupMemberStatus: 'active' },
    { personId: 12, groupMemberStatus: 'active' },
    { personId: 13, person: { domainIdentifier: '13' }, groupMemberStatus: 'active' },
  ]);
  assert.deepEqual(await fetchGroupMemberIds(CONFIG, 'token', 42), ['11', '12', '13']);
});
