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

test('extractCustomFieldValue finds a custom field by name and returns its trimmed value', () => {
  const person = {
    id: 9,
    customFields: [
      { id: 12, name: 'IBAN', value: '  CH93 0076 2011 6238 5295 7  ' },
      { id: 13, name: 'Kontoinhaber', value: 'Max Muster' },
    ],
  };
  assert.equal(extractCustomFieldValue(person, 'IBAN'), 'CH93 0076 2011 6238 5295 7');
});

test('extractCustomFieldValue finds a custom field by numeric id', () => {
  const person = { id: 9, customFields: [{ id: 12, name: 'IBAN', value: 'CH930076201162385295 7' }] };
  assert.equal(extractCustomFieldValue(person, '12'), 'CH930076201162385295 7');
});

test('extractCustomFieldValue returns null when the field is missing, empty, or the person has no customFields', () => {
  assert.equal(extractCustomFieldValue({ id: 9, customFields: [] }, 'IBAN'), null);
  assert.equal(extractCustomFieldValue({ id: 9, customFields: [{ id: 12, name: 'IBAN', value: '' }] }, 'IBAN'), null);
  assert.equal(extractCustomFieldValue({ id: 9 }, 'IBAN'), null);
  assert.equal(extractCustomFieldValue(null, 'IBAN'), null);
});
