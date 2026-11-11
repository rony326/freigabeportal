// Client für die ChurchTools-Schnittstelle: OAuth2-Anmeldung (Autorisierung, Token, Profil) und – mit dem Login-Token des
// Sync-Dienstkontos – Personen, Gruppen und Gruppenmitglieder (docs/auth-und-rechte.md, docs/personen-sync.md). Im Testmodus
// ruft nichts nach aussen; es gibt feste Beispieldaten.

// A4-01: Alle produktiven ChurchTools-fetch-Aufrufe (Login und nächtlicher Sync) bekommen ein
// Zeitlimit. Eine hängende CT-Instanz (TCP offen, keine Antwort) darf weder die Login-Anfrage
// unbegrenzt blockieren noch den Sync dauerhaft lahmlegen (der Reentrancy-Guard im scheduler.js
// wird erst zurückgesetzt, wenn der Aufruf abbricht). AbortSignal.timeout wie bei TSA
// (tsaCrlUpdate.js) und dem Einrichtungs-Test (einrichtungTests.js).
const CT_FETCH_TIMEOUT_MS = 15000;

// Zeitlimit-Signal für einen CT-Aufruf. config.ctFetchTimeoutMs ist eine optionale Stellschraube
// (Betrieb/Test); produktiv gilt der Standard. Kein Abschwächen der Prüfung: der Standard bleibt.
function ctSignal(config) {
  return AbortSignal.timeout(config?.ctFetchTimeoutMs ?? CT_FETCH_TIMEOUT_MS);
}

// Adresse, an die der Browser zur ChurchTools-Anmeldung geschickt wird (`state` schützt vor CSRF).
export function buildAuthorizeUrl(config, state) {
  const url = new URL('/oauth/authorize', config.baseUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

// `status` wird angehängt, damit Aufrufer "ChurchTools sagt, das existiert nicht" (404/410) von Ausfällen, Ratenlimits oder
// Berechtigungsproblemen unterscheiden können — der Personen-Sync wertet nur Ersteres als entzogenen Portalzugang (services/sync.js).
async function parseOrThrow(response, label) {
  if (!response.ok) {
    throw Object.assign(new Error(`ChurchTools ${label} fehlgeschlagen: ${response.status}`), { status: response.status });
  }
  return response.json();
}

// Test-Instanz: nie ein Aufruf nach aussen (config.testmodus kommt aus der Test-Konfiguration).
function sperreImTestmodus(config) {
  if (config?.testmodus) throw Object.assign(new Error('ChurchTools ist im Testmodus deaktiviert.'), { testmodus: true });
}

// Beispiel-Zahlungsdaten (Muster-IBAN), damit Spesen im Testmodus freigegeben werden können.
export const TESTMODUS_IBAN = 'CH9300762011623852957';

// Tauscht den Autorisierungscode gegen ein OAuth2-Zugriffstoken.
export async function exchangeCodeForToken(config, code) {
  sperreImTestmodus(config);
  const url = new URL('/oauth/access_token', config.baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
    signal: ctSignal(config),
  });
  return parseOrThrow(response, 'Token-Austausch');
}

// Profil der angemeldeten Person (/oauth/userinfo).
export async function fetchPerson(config, accessToken) {
  sperreImTestmodus(config);
  // OAuth2-Zugriffstoken gelten nur für die eigenen /oauth/*-Endpunkte (authorize, access_token, userinfo) — nicht für die
  // allgemeine REST-Schnittstelle /api/*, die für eine Bearer-Anfrage mit 403 antwortet. /oauth/userinfo liefert das Profil
  // ausserdem als flaches Objekt, anders als die Hülle { data: {...} } von /api/*.
  const url = new URL('/oauth/userinfo', config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: ctSignal(config) });
  return parseOrThrow(response, 'Profilabruf');
}

// fetchPersonById und fetchGroupMemberIds werden nur mit einem ChurchTools-Login-Token (dem Token des Sync-Dienstkontos)
// aufgerufen, nie mit einem OAuth-Zugriffstoken — die allgemeine REST-Schnittstelle /api/* akzeptiert OAuth-Bearer-
// Authentifizierung gar nicht (siehe fetchPerson oben). Login-Token haben ein eigenes Schema: "Authorization: Login <token>",
// nicht "Bearer <token>" — gegen die Authentifizierungs-Doku von ChurchTools bestätigt. Das falsche Schema scheitert mit 401
// (sofort abgelehnt), nicht mit 403 (authentifiziert, aber abgelehnt) — die beiden Tokenarten sind nicht austauschbar und
// dürfen sich keinen Header-Helfer teilen, ohne ausdrücklich zu klären, welches Schema gilt.
export async function fetchPersonById(config, loginToken, personId) {
  if (config?.testmodus) {
    const daten = { id: personId };
    if (config.customFieldIban) daten[config.customFieldIban] = TESTMODUS_IBAN;
    if (config.customFieldKontoinhaber) daten[config.customFieldKontoinhaber] = 'Beispielperson';
    return daten;
  }
  const url = new URL(`/api/persons/${personId}`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Login ${loginToken}` }, signal: ctSignal(config) });
  const data = await parseOrThrow(response, 'Personenabruf');
  return data.data;
}

// An einer Live-Instanz bestätigt: Die Antwort von ChurchTools GET /api/persons/{id} hat gar kein eigenes customFields-Array.
// Benutzerdefinierte Felder erscheinen als flache, kleingeschriebene Eigenschaften direkt am Personenobjekt (z. B. "iban_1",
// "kontoinhaber") — CT_CUSTOM_FIELD_IBAN/CT_CUSTOM_FIELD_KONTOINHABER müssen also genau diesen Eigenschaftsschlüssel enthalten,
// nicht einen Anzeigenamen oder eine numerische Feld-ID.
export function extractCustomFieldValue(person, fieldKey) {
  if (!person || !fieldKey) return null;
  const wert = person[fieldKey];
  if (wert == null) return null;
  const getrimmt = String(wert).trim();
  return getrimmt || null;
}

// Gruppe (id, Name) – für die Prüfung der konfigurierten Gruppen-IDs in der Ersteinrichtung.
export async function fetchGroup(config, loginToken, groupId, { signal = ctSignal(config) } = {}) {
  sperreImTestmodus(config);
  const url = new URL(`/api/groups/${groupId}`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Login ${loginToken}` }, signal });
  const data = await parseOrThrow(response, 'Gruppenabruf');
  return { id: String(data.data.id), name: data.data.name };
}

// IDs aller Mitglieder einer Gruppe (als Text).
export async function fetchGroupMemberIds(config, loginToken, groupId, { signal = ctSignal(config) } = {}) {
  sperreImTestmodus(config);
  const url = new URL(`/api/groups/${groupId}/members`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Login ${loginToken}` }, signal });
  const data = await parseOrThrow(response, 'Gruppenabfrage');
  return data.data.map((member) => String(member.personId));
}

// Welche der Kandidaten-Gruppen enthalten die Person? (Beim Login: Rollen der Person bestimmen.) @returns {Promise<string[]>}
export async function resolveMemberGroupIds(config, loginToken, personId, candidateGroupIds) {
  const memberships = await Promise.all(
    candidateGroupIds.map(async (groupId) => {
      const memberIds = await fetchGroupMemberIds(config, loginToken, groupId);
      return memberIds.includes(String(personId)) ? String(groupId) : null;
    })
  );
  return memberships.filter(Boolean);
}
