import { createHash } from 'node:crypto';
import { Certificate } from 'pkijs';
import { crlDer } from './tsaRevocation.js';

// Nachweis der bei Ausstellung eines Zeitstempels tatsaechlich verwendeten Evidenz:
// Token, Zertifikatskette (Signer bis lokaler Vertrauensanker), die zur Sperrpruefung verwendeten
// CRLs samt Gueltigkeitsfenster, Pruefzeitpunkt, Truststore-Hash und Zuordnung zum Dokument.
//
// Grenzen (bewusst im Nachweis selbst vermerkt): Die Evidenz belegt, was zum lokalen
// Pruefzeitpunkt vorlag und geprueft wurde. Sie ist keine historische Langzeitvalidierung
// (kein LTV/DSS in der PDF, keine OCSP-Antworten, keine Archivzeitstempel-Erneuerung, keine
// Pruefung der Evidenz durch Dritte) und beweist keine externe Unveraenderlichkeit.

const GRENZEN = 'Sperrstatus zum lokalen Pruefzeitpunkt mittels lokal bereitgestellter CRLs. Keine historische Langzeitvalidierung, keine OCSP-Evidenz, keine externe Unveraenderlichkeit.';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const certDer = (cert) => Buffer.from(cert.toSchema().toBER(false));
const name = (rdn) => rdn.typesAndValues.map((tv) => `${tv.type}=${tv.value.valueBlock.value}`).join(',');

// Kanonisches JSON (sortierte Schluessel), damit der Nachweis-Hash reproduzierbar ist.
export function kanonischesJson(wert) {
  if (Array.isArray(wert)) return `[${wert.map(kanonischesJson).join(',')}]`;
  if (wert && typeof wert === 'object') return `{${Object.keys(wert).sort().map((k) => `${JSON.stringify(k)}:${kanonischesJson(wert[k])}`).join(',')}}`;
  return JSON.stringify(wert);
}

export function baueTsaNachweis({ binding, token, kette = null, trustAnchorsSha256 = null, pruefzeitpunkt = new Date() }) {
  const objekte = [];
  const merke = (art, der) => {
    const hash = sha256(der);
    if (!objekte.some((objekt) => objekt.sha256 === hash)) objekte.push({ sha256: hash, art, der });
    return hash;
  };
  const tokenSha256 = merke('zeitstempel_token', Buffer.from(token));
  const zertifikate = kette
    ? kette.kettenzertifikate.map((cert, index, alle) => ({
      sha256: merke('zertifikat', certDer(cert)), rolle: index === 0 ? 'signer' : index === alle.length - 1 ? 'vertrauensanker' : 'zwischen',
      subject: name(cert.subject), gueltigVon: cert.notBefore.value.toISOString(), gueltigBis: cert.notAfter.value.toISOString(),
    }))
    : (binding.signed.certificates || []).filter((cert) => cert instanceof Certificate).map((cert) => ({
      sha256: merke('zertifikat', certDer(cert)), rolle: cert === binding.signer ? 'signer' : 'im_token',
      subject: name(cert.subject), gueltigVon: cert.notBefore.value.toISOString(), gueltigBis: cert.notAfter.value.toISOString(),
    }));
  const sperrlisten = (kette?.sperrlisten || []).map((crl) => ({
    sha256: merke('sperrliste', crlDer(crl)), aussteller: name(crl.issuer),
    thisUpdate: crl.thisUpdate.value.toISOString(), nextUpdate: crl.nextUpdate.value.toISOString(),
  }));
  const pruefzeit = (kette?.pruefzeitpunkt || pruefzeitpunkt).toISOString();
  const daten = {
    version: 1,
    pruefzeitpunkt: pruefzeit,
    zeitstempelZeit: binding.info.genTime.toISOString(),
    policy: binding.info.policy,
    tokenSha256,
    kettenpruefung: kette ? 'geprueft' : 'nicht_konfiguriert',
    sperrpruefung: kette ? 'crl_zum_pruefzeitpunkt' : 'nicht_geprueft',
    truststoreSha256: kette ? trustAnchorsSha256 : null,
    signerSha256: kette ? kette.signerSha256 : sha256(certDer(binding.signer)),
    zertifikate,
    sperrlisten,
    grenzen: GRENZEN,
  };
  return { daten, objekte };
}

// Muss innerhalb der Transaktion laufen, die auch den Zeitstempel-Hash des Jobs setzt: ohne
// gespeicherten Nachweis wird der Zeitstempel nicht festgeschrieben (Fail-closed).
export function speichereTsaNachweis(db, { jobId, bezug, dokumentSha256, nachweis }) {
  if (!db.isTransaction) throw new Error('TSA-Nachweis muss mit dem Zeitstempel-Hash gemeinsam gespeichert werden.');
  if (!nachweis?.daten || !Array.isArray(nachweis.objekte)) throw new Error('TSA-Nachweis fehlt.');
  const jetzt = new Date().toISOString();
  for (const objekt of nachweis.objekte) {
    if (sha256(objekt.der) !== objekt.sha256) throw new Error('TSA-Evidenzobjekt passt nicht zu seinem Hash.');
    db.prepare('INSERT INTO tsa_evidenz_objekte (sha256, art, der, erfasst_am) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING')
      .run(objekt.sha256, objekt.art, objekt.der, jetzt);
  }
  const json = kanonischesJson(nachweis.daten);
  db.prepare(`INSERT INTO tsa_pruefnachweise (job_id, bezug, dokument_sha256, geprueft_am, kettenpruefung, nachweis, nachweis_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jobId, bezug, dokumentSha256, nachweis.daten.pruefzeitpunkt, nachweis.daten.kettenpruefung, json, sha256(json));
}

// Liest einen Nachweis und prueft lokal, dass Nachweis-JSON und alle referenzierten Objekte noch
// zu ihren Hashes passen. Das ist eine Konsistenzpruefung, kein Beweis externer Unveraenderlichkeit.
export function ladeTsaNachweis(db, { jobId, bezug, dokumentSha256 }) {
  const row = db.prepare('SELECT * FROM tsa_pruefnachweise WHERE job_id = ? AND bezug = ? AND dokument_sha256 = ?').get(jobId, bezug, dokumentSha256);
  if (!row) return null;
  const daten = JSON.parse(row.nachweis);
  const hashes = [daten.tokenSha256, ...daten.zertifikate.map((z) => z.sha256), ...daten.sperrlisten.map((s) => s.sha256)];
  const fehlend = [];
  for (const hash of hashes) {
    const objekt = db.prepare('SELECT der FROM tsa_evidenz_objekte WHERE sha256 = ?').get(hash);
    if (!objekt || sha256(Buffer.from(objekt.der)) !== hash) fehlend.push(hash);
  }
  return {
    ...row,
    daten,
    integritaet: sha256(row.nachweis) === row.nachweis_sha256 && fehlend.length === 0 ? 'lokal_konsistent' : 'abweichung',
    fehlendeObjekte: fehlend,
  };
}
