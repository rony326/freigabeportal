// Durchlauf-Test (docs/durchlauf-test.md): Sicherheitsprüfungen vor dem Lauf.
// Reine Logik: Live-Adresse ausschliessen, gespeicherte Sitzung (Playwright-storageState) prüfen,
// Vier-Augen-Prinzip (Person A und B verschieden), Bestätigung des Betreibers auswerten.

// Name des Sitzungs-Cookies (src/app.js): hinter HTTPS mit __Host--Präfix, lokal ohne.
export const SITZUNGS_COOKIES = ['__Host-portal.sid', 'connect.sid'];
// Reserve: eine Sitzung, die in weniger als dieser Zeit abläuft, gilt schon als abgelaufen.
export const SITZUNG_RESERVE_MS = 30 * 60 * 1000;

// Die Live-Adresse steht nie im Repo. Kennt die Umgebung sie (PRUEF_ZIEL_URL, Abschlussprüfung), darf das Ziel
// nicht auf denselben Host zeigen. @returns {string|null} Fehlertext oder null
export function pruefeNichtLive(zielUrl, umgebung = {}) {
  const live = umgebung.PRUEF_ZIEL_URL;
  if (!live || !zielUrl) return null;
  let liveHost;
  try { liveHost = new URL(live).hostname.toLowerCase(); } catch { return null; }
  if (new URL(zielUrl).hostname.toLowerCase() === liveHost) {
    return 'DURCHLAUF_ZIEL_URL zeigt auf die Live-Adresse (gleicher Host wie PRUEF_ZIEL_URL). Der Durchlauf läuft nur gegen eine Testinstanz.';
  }
  return null;
}

// Dateiname der gespeicherten Sitzung je Person ('a' oder 'b').
export function sitzungsDatei(person) {
  return `person-${person}.json`;
}

// Prüft eine gespeicherte Sitzung (Playwright-storageState) ohne Netz: passendes Sitzungs-Cookie für den
// Zielhost und genug Restlaufzeit. `jetztMs` für Tests.
// @returns {{ ok: boolean, grund: string|null, gueltigBis: Date|null }}
export function pruefeSitzungsDatei(storageState, zielUrl, jetztMs = Date.now(), person = 'a') {
  const nachholen = `zuerst npm run durchlauf:anmelden -- ${person}`;
  if (!storageState || !Array.isArray(storageState.cookies)) {
    return { ok: false, grund: `Keine gespeicherte Sitzung für Person ${person.toUpperCase()}: ${nachholen}`, gueltigBis: null };
  }
  const host = new URL(zielUrl).hostname.toLowerCase();
  const cookie = storageState.cookies.find((c) => SITZUNGS_COOKIES.includes(c.name)
    && String(c.domain || '').replace(/^\./, '').toLowerCase() === host);
  if (!cookie) {
    return { ok: false, grund: `Die Sitzung von Person ${person.toUpperCase()} gehört nicht zu ${zielUrl.origin}: ${nachholen}`, gueltigBis: null };
  }
  // expires in Sekunden; -1 = Sitzungs-Cookie ohne Ablauf (kommt beim Portal nicht vor, maxAge 8 h).
  const gueltigBis = typeof cookie.expires === 'number' && cookie.expires > 0 ? new Date(cookie.expires * 1000) : null;
  if (gueltigBis && gueltigBis.getTime() - jetztMs < SITZUNG_RESERVE_MS) {
    return { ok: false, grund: `Die Sitzung von Person ${person.toUpperCase()} ist abgelaufen oder läuft in weniger als 30 Minuten ab: ${nachholen}`, gueltigBis };
  }
  return { ok: true, grund: null, gueltigBis };
}

// Vier-Augen-Prinzip: Freigabe 1 und Freigabe 2 dürfen nicht dieselbe Person sein.
// @returns {string|null} Fehlertext oder null
export function pruefePersonenVerschieden(nameA, nameB) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!norm(nameA) || !norm(nameB)) return 'Der Name von Person A oder B ist nicht feststellbar (Kopfzeile «Angemeldet als» fehlt).';
  if (norm(nameA) === norm(nameB)) {
    return `Person A und Person B sind dieselbe Person (${nameA}). Für das Vier-Augen-Prinzip braucht es zwei verschiedene Testkonten: npm run durchlauf:anmelden -- b mit dem zweiten Konto.`;
  }
  return null;
}

// Antwort auf die Sicherheitsabfrage: nur ein ausdrückliches «ja» zählt.
export function istBestaetigt(antwort) {
  return String(antwort ?? '').trim().toLowerCase() === 'ja';
}

// Behält aus einem storageState nur Cookies und Speicher des Portals. Die ChurchTools-Anmeldung (fremder Host)
// wird nicht gespeichert: sie braucht der Durchlauf nicht, und eine gestohlene Datei öffnet so höchstens das Testportal.
export function nurPortalSitzung(storageState, zielUrl) {
  const host = new URL(zielUrl).hostname.toLowerCase();
  return {
    cookies: (storageState?.cookies ?? []).filter((c) => String(c.domain || '').replace(/^\./, '').toLowerCase() === host),
    origins: (storageState?.origins ?? []).filter((o) => o.origin === new URL(zielUrl).origin),
  };
}
