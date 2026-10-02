import { randomBytes } from 'node:crypto';
import { lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createTimestampRequest, sendTimestampRequest, parseTimestampResponse } from 'pdf-rfc3161';
import { freshTimestampRequest, validateTimestampBinding } from './tsaResponse.js';
import { loadTsaTrustAnchors, validateTsaPath, tsaTrustOptions } from './tsaTrust.js';
import { loadTsaCrls, parseTsaCrl, crlZuPem, verifyTsaRevocation } from './tsaRevocation.js';
import { buildTsaHeaders } from './zeitstempel.js';
import { auditedJob } from './auditOperation.js';
import { resolveEmpfaenger, sendRenderedMail } from './notify.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

// Automatische Erneuerung der lokalen TSA-Sperrlisten (TSA_CRL_AUTO_UPDATE, docs/tsa-vertrauensanker.md).
//
// Die CRL-Adressen stammen ausschliesslich aus einer zuvor gegen die lokalen Anker validierten
// Kette eines frischen Testzeitstempels; jede geladene Liste durchlaeuft dieselbe Pruefung wie bei
// echten Zeitstempeln (Signatur, Aktualitaet, Erweiterungsprofil). Erst danach wird die Datei atomar
// ersetzt. Scheitert etwas, bleibt die bisherige Datei unveraendert. Ausnahme: authentische Listen,
// die die TSA sperren, werden trotzdem uebernommen, damit eine Sperrung nicht durch aeltere, noch
// gueltige Listen verdeckt wird.

export const WARNFRIST_MS = 7 * 24 * 3600 * 1000;
const MAX_CRL_BYTES = 4 * 1024 * 1024;
const TSA_TIMING = { timeout: 15000, retry: 2, retryDelay: 1000 };

async function holeUrlPerHttp(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Sperrliste ${url}: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_CRL_BYTES) throw new Error(`Sperrliste ${url} ist zu gross.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_CRL_BYTES) throw new Error(`Sperrliste ${url} ist zu gross.`);
  return bytes;
}

function alsDer(bytes) {
  const text = bytes.subarray(0, 32).toString('latin1');
  if (!text.startsWith('-----BEGIN X509 CRL-----')) return bytes;
  return Buffer.from(bytes.toString('latin1').replace(/-----[A-Z0-9 ]+-----|\s/g, ''), 'base64');
}

function verteilpunkte(certificate) {
  const cdp = certificate.extensions?.find((extension) => extension.extnID === '2.5.29.31')?.parsedValue;
  return (cdp?.distributionPoints || [])
    .filter((point) => point.reasons === undefined && point.cRLIssuer === undefined && Array.isArray(point.distributionPoint))
    .flatMap((point) => point.distributionPoint)
    .filter((name) => name.type === 6 && /^https?:\/\//i.test(name.value))
    .map((name) => name.value);
}

async function testzeitstempel(tsaConfig) {
  const request = freshTimestampRequest(await createTimestampRequest(Uint8Array.from(randomBytes(32)), { hashAlgorithm: 'SHA-256' }));
  const response = parseTimestampResponse(await sendTimestampRequest(request, { url: tsaConfig.url, headers: buildTsaHeaders(tsaConfig), ...TSA_TIMING }));
  if (![0, 1].includes(response.status) || !response.token) throw new Error('TSA hat keinen erfolgreichen Testzeitstempel geliefert.');
  return validateTimestampBinding(request, response.token);
}

function schreibeAtomar(pfad, inhalt) {
  let stat = null;
  try { stat = lstatSync(pfad); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (stat && !stat.isFile()) throw new Error('TSA-Sperrlistendatei muss eine regulaere Datei sein (kein Symlink).');
  const tmp = join(dirname(pfad), `.${basename(pfad)}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'wx', stat ? stat.mode & 0o777 : 0o644);
    try { writeFileSync(fd, inhalt); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, pfad);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export async function aktualisiereTsaCrls(tsaConfig, { holeUrl = holeUrlPerHttp } = {}) {
  if (!tsaConfig.url || !tsaConfig.crlFile) throw new Error('TSA-URL und TSA_CRL_FILE muessen konfiguriert sein.');
  const anchors = loadTsaTrustAnchors(tsaConfig.trustAnchorsFile, tsaConfig.trustAnchorsSha256);
  const { chain } = await validateTsaPath(await testzeitstempel(tsaConfig), anchors);
  const crls = [];
  for (const certificate of chain.slice(0, -1)) {
    const urls = verteilpunkte(certificate);
    if (!urls.length) throw new Error('TSA-Zertifikat nennt keinen HTTP-Sperrlisten-Verteilpunkt.');
    let letzterFehler;
    let crl = null;
    for (const url of urls) {
      try { crl = parseTsaCrl(alsDer(await holeUrl(url))); break; } catch (err) { letzterFehler = err; }
    }
    if (!crl) throw letzterFehler;
    crls.push(crl);
  }
  const inhalt = crls.map(crlZuPem).join('');
  try {
    await verifyTsaRevocation(chain, crls);
  } catch (err) {
    if (err.code === 'TSA_GESPERRT') schreibeAtomar(tsaConfig.crlFile, inhalt);
    throw err;
  }
  schreibeAtomar(tsaConfig.crlFile, inhalt);
  const sperrlisten = crls.map((crl) => ({ nextUpdate: crl.nextUpdate.value }));
  return { sperrlisten, naechsterAblauf: new Date(Math.min(...sperrlisten.map((s) => s.nextUpdate.getTime()))) };
}

function aktuellerAblauf(crlFile) {
  try {
    return Math.min(...loadTsaCrls(crlFile).map((crl) => crl.nextUpdate?.value.getTime() ?? 0));
  } catch {
    return null;
  }
}

async function alarmiere(db, config, mailer, { meldung, ablauf }) {
  const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sicherheitsalarm_empfaenger') ?? 'gruppe:admin').filter(Boolean);
  if (!empfaenger.length) return;
  const stand = ablauf ? `Die aktuellen Sperrlisten sind gueltig bis ${new Date(ablauf).toISOString()}.`
    : 'Es sind keine gueltigen Sperrlisten vorhanden.';
  await sendRenderedMail(db, mailer, {
    to: empfaenger.join(', '),
    typ: 'sicherheitsalarm',
    jobId: null,
    subject: 'Freigabeportal: TSA-Sperrlisten konnten nicht erneuert werden',
    text: `Die automatische Erneuerung der TSA-Sperrlisten ist fehlgeschlagen:\n\n${meldung}\n\n${stand} `
      + 'Danach werden neue Zeitstempel abgelehnt und betroffene Belege bleiben fuer den Export gesperrt.\n\n'
      + 'Manuell pruefen: npm run tsa:crl-update (siehe docs/tsa-vertrauensanker.md).\n\n'
      + `${getConfigValue(db, 'seiten_titel') || 'Freigabeportal'}`,
  });
}

async function runTsaCrlAktualisierungJobInternal(db, config, mailer, { holeUrl, jetzt = Date.now() } = {}) {
  const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
  if (!config.tsaCrlAutoUpdate || !tsaUrl) return { status: 'uebersprungen' };
  const tsaConfig = {
    ...tsaTrustOptions(config),
    url: tsaUrl,
    user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
    passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
  };
  try {
    const result = await aktualisiereTsaCrls(tsaConfig, holeUrl ? { holeUrl } : {});
    const details = `${result.sperrlisten.length} Sperrlisten erneuert, gueltig bis ${result.naechsterAblauf.toISOString()}`;
    return { status: 'erfolg', details };
  } catch (err) {
    const ablauf = aktuellerAblauf(config.tsaCrlFile);
    // Voruebergehende Ausfaelle sind bei wochenlang gueltigen Listen unkritisch; erst kurz vor Ablauf
    // (oder bei Sperrung bzw. fehlender Datei) wird alarmiert, dann bei jedem weiteren Fehlschlag.
    const alarm = err.code === 'TSA_GESPERRT' || !ablauf || ablauf - jetzt <= WARNFRIST_MS;
    if (alarm) await alarmiere(db, config, mailer, { meldung: err.message, ablauf });
    return { status: 'fehler', error: err.message, alarmiert: alarm };
  }
}

export const runTsaCrlAktualisierungJob = auditedJob('tsa-crl-aktualisierung', runTsaCrlAktualisierungJobInternal);
