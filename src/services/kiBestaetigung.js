// Bestätigungspflicht für KI-Werte in der Kontierung (und beim Aufsplitten): Rechnungsnummer, Zahlungsziel und Betrag, die
// n8n beim Eingang mitgeschickt hat (services/eingangVorbefuellung.js, z. B. von einem KI-Modell gelesen), müssen die
// kontierende Person ausdrücklich bestätigen – per Haken am Feldrand (views/_ki_bestaetigen.ejs) oder indem sie den Wert
// selbst ändert. Ein unverändert übernommener Wert ohne Haken wird serverseitig abgelehnt; so lassen sich KI-Werte nicht
// einfach durchklicken.
//
// Nicht betroffen: Werte aus dem QR-Code (maschinenlesbar und verlässlich; ein QR-Betrag ersetzt den Upload-Betrag) und
// bereits kontierte Vorgänge (jobs.betrag gesetzt, z. B. Überarbeitung nach Ablehnung) – dort hat schon jemand bestätigt.

const FELDER = ['rechnungsnummer', 'zahlungsziel', 'betrag'];

const LABEL = { rechnungsnummer: 'Rechnungsnummer', zahlungsziel: 'Zahlungsziel', betrag: 'Betrag' };

/**
 * KI-Werte des Vorgangs, die noch bestätigt werden müssen.
 * @param {object} job Zeile aus `jobs`
 * @returns {{rechnungsnummer: string|null, zahlungsziel: string|null, betrag: string|null}}
 */
export function kiFelder(job) {
  const kontiert = job.betrag != null && job.betrag !== '';
  if (kontiert) return { rechnungsnummer: null, zahlungsziel: null, betrag: null };
  return {
    rechnungsnummer: job.rechnungsnummer || null,
    zahlungsziel: job.zahlungsziel || null,
    betrag: !job.qr_betrag && job.betrag_vorschlag ? job.betrag_vorschlag : null,
  };
}

// Vergleichsform: getrimmt; beim Betrag numerisch (99,9 = 99.90), damit eine reine Schreibweise keine "Änderung" ist.
function gleich(feld, a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (feld === 'betrag') {
    const nx = Number(x.replace(',', '.'));
    const ny = Number(y.replace(',', '.'));
    return x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) ? nx === ny : x === y;
  }
  return x === y;
}

/** @returns {boolean} true, wenn der Haken für `feld` gesetzt ist (genau der Text "1", kein Array) */
export function istBestaetigt(body, feld) {
  return body?.[`bestaetigt_${feld}`] === '1';
}

/**
 * @param {{rechnungsnummer?: string|null, zahlungsziel?: string|null, betrag?: string|null}} ki Ergebnis von kiFelder
 * @param {object} werte abgesendete Formularwerte (rechnungsnummer, zahlungsziel, betrag)
 * @param {object} body req.body (Haken `bestaetigt_<feld>`)
 * @returns {string[]} Felder, deren KI-Wert unverändert und ohne Haken abgesendet wurde
 */
export function fehlendeBestaetigungen(ki, werte, body) {
  return FELDER.filter((feld) => ki[feld] && gleich(feld, werte[feld], ki[feld]) && !istBestaetigt(body, feld));
}

/** Feldfehler-Text für ein nicht bestätigtes KI-Feld. */
export function bestaetigungsMeldung(feld) {
  return `${LABEL[feld]} wurde automatisch erkannt: bitte prüfen und mit dem Haken bestätigen oder korrigieren.`;
}

/** Hakenstatus für die erneute Anzeige des Formulars. */
export function hakenAusBody(body) {
  return Object.fromEntries(FELDER.map((feld) => [feld, istBestaetigt(body, feld)]));
}
