import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoUrl, getVersionInfo } from '../../src/utils/version.js';

test('normalizeRepoUrl converts SSH github remotes to https', () => {
  assert.equal(
    normalizeRepoUrl('git@github.com:rony326/freigabeportal.git'),
    'https://github.com/rony326/freigabeportal',
  );
});

test('normalizeRepoUrl strips .git suffix from https remotes', () => {
  assert.equal(
    normalizeRepoUrl('https://github.com/rony326/freigabeportal.git'),
    'https://github.com/rony326/freigabeportal',
  );
});

test('normalizeRepoUrl returns null for missing input', () => {
  assert.equal(normalizeRepoUrl(null), null);
  assert.equal(normalizeRepoUrl(''), null);
});

test('getVersionInfo reads a commit-based display and url when run inside this repo', () => {
  const info = getVersionInfo(new URL('../..', import.meta.url));
  assert.ok(info.display, 'expected a non-empty display string');
  assert.match(info.repoUrl, /^https:\/\/github\.com\/.+\/freigabeportal$/);
  assert.match(info.url, /^https:\/\/github\.com\/.+\/(commit|releases\/tag)\/.+/);
});

test('getVersionInfo falls back to nulls when git is unavailable', () => {
  const info = getVersionInfo('/nonexistent-path-for-git-test');
  assert.deepEqual(info, { display: null, url: null, repoUrl: null });
});
