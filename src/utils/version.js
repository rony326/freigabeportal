import { execFileSync } from 'node:child_process';

export function normalizeRepoUrl(remoteUrl) {
  if (!remoteUrl) return null;
  let url = remoteUrl.trim();
  if (url.startsWith('git@github.com:')) {
    url = `https://github.com/${url.slice('git@github.com:'.length)}`;
  }
  return url.replace(/\.git$/, '');
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Reads the deployed commit/tag straight from git rather than package.json, so the footer
// always matches what's actually running instead of relying on someone bumping a version field.
export function getVersionInfo(cwd) {
  try {
    const display = runGit(['describe', '--tags', '--always'], cwd);
    const commitHash = runGit(['rev-parse', 'HEAD'], cwd);
    const repoUrl = normalizeRepoUrl(runGit(['config', '--get', 'remote.origin.url'], cwd));

    let url = repoUrl ? `${repoUrl}/commit/${commitHash}` : null;
    try {
      const exactTag = runGit(['describe', '--tags', '--exact-match'], cwd);
      if (repoUrl) url = `${repoUrl}/releases/tag/${exactTag}`;
    } catch {
      // HEAD isn't exactly on a tag — keep linking to the commit.
    }

    return { display, url, repoUrl };
  } catch {
    return { display: null, url: null, repoUrl: null };
  }
}
