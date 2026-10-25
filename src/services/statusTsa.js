import { randomBytes } from 'node:crypto';
import { createTimestampRequest, sendTimestampRequest, parseTimestampResponse } from 'pdf-rfc3161';
import { freshTimestampRequest, validateTimestampBinding } from './tsaResponse.js';
import { buildTsaHeaders } from './zeitstempel.js';
import { tsaConfigAusDb } from './auditZeitstempel.js';

const INTERVALL_MS = 15 * 60 * 1000;
const TSA_TIMING = { timeout: 15000, retry: 0 };

// Echter Testzeitstempel über 32 Zufallsbytes; das Ergebnis wird verworfen. Wirft bei Fehlern.
export async function tsaTestversuch(tsaConfig) {
  const req = freshTimestampRequest(await createTimestampRequest(Uint8Array.from(randomBytes(32)), { hashAlgorithm: 'SHA-256' }));
  const res = parseTimestampResponse(await sendTimestampRequest(req, { url: tsaConfig.url, headers: buildTsaHeaders(tsaConfig), ...TSA_TIMING }));
  if (![0, 1].includes(res.status) || !res.token) throw new Error('TSA hat keinen erfolgreichen Testzeitstempel geliefert.');
  validateTimestampBinding(req, res.token);
}

// Eigener Zustand pro Instanz (Tests); der Versuch läuft im Hintergrund und wird nie awaited.
// Jeder Versuch ist ein echter Zeitstempel-Request (höchstens alle 15 min, nur bei Aufruf).
// Ändert sich die TSA-URL, gilt das alte Ergebnis nicht mehr; ein später eintreffendes
// Ergebnis für die alte URL wird verworfen (Generation).
export function createTsaErreichbarkeit() {
  const LEER = { erreichbar: null, geprueft_am: null };
  let letzter = LEER;
  let laufend = false;
  let letzterStart = null;
  let url = null;
  let generation = 0;
  return function tsaErreichbarkeit(db, config, { jetzt = new Date(), versuch = tsaTestversuch } = {}) {
    const tsaConfig = tsaConfigAusDb(db, config);
    if (!tsaConfig) return LEER;
    if (tsaConfig.url !== url) {
      url = tsaConfig.url;
      generation += 1;
      letzter = LEER;
      laufend = false;
      letzterStart = null;
    }
    if (!laufend && (letzterStart === null || jetzt.getTime() - letzterStart >= INTERVALL_MS)) {
      laufend = true;
      letzterStart = jetzt.getTime();
      const meine = generation;
      let p;
      try { p = Promise.resolve(versuch(tsaConfig)); } catch (err) { p = Promise.reject(err); }
      p.then(() => true, () => false).then((ok) => {
        if (meine !== generation) return;
        letzter = { erreichbar: ok, geprueft_am: new Date().toISOString() };
        laufend = false;
      });
    }
    return letzter;
  };
}

export const tsaErreichbarkeit = createTsaErreichbarkeit();
