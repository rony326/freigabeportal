// Signierte Download-Adressen für PDFs (`/downloads/:jobId?expires=…&signature=…`): HMAC-SHA256 über Job-ID und Ablaufzeit,
// damit n8n und die PDF-Vorschau im Browser ohne Sitzung gezielt eine Datei abrufen können. Routen: routes/downloads.js.

import crypto from 'node:crypto';

// Gültigkeit der Vorschau-Adresse im Browser (5 Minuten; die Seite bietet "Link erneuern").
export const PDF_PREVIEW_TTL_SECONDS = 5 * 60;

function sign(secret, jobId, expires) {
  return crypto.createHmac('sha256', secret).update(`${jobId}.${expires}`).digest('hex');
}

// @returns {string} relative Adresse mit Ablaufzeit und Signatur
export function buildSignedDownloadUrl(config, jobId, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = sign(config.downloadSigningSecret, jobId, expires);
  return `/downloads/${jobId}?expires=${expires}&signature=${signature}`;
}

// Prüft Ablauf und Signatur (zeitkonstanter Vergleich). @returns {boolean}
export function verifySignedDownload(config, jobId, expires, signature) {
  const expiresNum = Number(expires);
  if (!Number.isInteger(expiresNum)) return false;
  if (Math.floor(Date.now() / 1000) > expiresNum) return false;

  const expected = sign(config.downloadSigningSecret, jobId, expiresNum);
  let providedBuf;
  let expectedBuf;
  try {
    providedBuf = Buffer.from(String(signature ?? ''), 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
