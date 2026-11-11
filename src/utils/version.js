// Ermittelt die angezeigte Version (Fusszeile) direkt aus Git – siehe Kommentar unten.

import { execFileSync } from 'node:child_process';

/**
 * Macht aus einer Git-Remote-URL eine https-Adresse ohne `.git` (für Links auf Commit/Release).
 * @param {string|null|undefined} remoteUrl z. B. `git@github.com:org/repo.git`
 * @returns {string|null} `https://github.com/org/repo` oder null ohne Remote
 */
export function normalizeRepoUrl(remoteUrl) {
  if (!remoteUrl) return null;
  let url = remoteUrl.trim();
  if (url.startsWith('git@github.com:')) {
    url = `https://github.com/${url.slice('git@github.com:'.length)}`;
  }
  return url.replace(/\.git$/, '');
}

// Führt git ohne Shell aus und liefert die getrimmte Ausgabe (wirft bei Fehler, z. B. kein Repository).
function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Liest den ausgelieferten Commit bzw. Tag direkt aus git statt aus package.json, damit die Fusszeile immer
// dem entspricht, was wirklich läuft – und nicht davon abhängt, dass jemand ein Versionsfeld hochzählt.
/**
 * @param {string} cwd Verzeichnis des Repositories
 * @returns {{display: string|null, url: string|null, repoUrl: string|null}} Versionstext, Link auf
 *   Release bzw. Commit und Repository-URL; alles null, wenn kein Git verfügbar ist (z. B. ZIP-Deployment).
 */
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
      // HEAD liegt nicht genau auf einem Tag – der Link zeigt weiter auf den Commit.
    }

    return { display, url, repoUrl };
  } catch {
    return { display: null, url: null, repoUrl: null };
  }
}
