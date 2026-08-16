export function buildAuthorizeUrl(config, state) {
  const url = new URL('/oauth/authorize', config.baseUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

async function parseOrThrow(response, label) {
  if (!response.ok) {
    throw new Error(`ChurchTools ${label} fehlgeschlagen: ${response.status}`);
  }
  return response.json();
}

export async function exchangeCodeForToken(config, code) {
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
  });
  return parseOrThrow(response, 'Token-Austausch');
}

export async function fetchPerson(config, accessToken) {
  // OAuth2 access tokens are only valid against the dedicated /oauth/* endpoints (authorize,
  // access_token, userinfo) — not the general /api/* REST surface, which returns 403 for a
  // Bearer-token request. /oauth/userinfo also returns the profile as a flat object, unlike
  // /api/*'s { data: {...} } envelope.
  const url = new URL('/oauth/userinfo', config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return parseOrThrow(response, 'Profilabruf');
}

// fetchPersonById and fetchGroupMemberIds are only ever called with a ChurchTools Login-Token
// (the sync service account's token), never an OAuth access token — the general /api/* REST
// surface doesn't accept OAuth Bearer auth at all (see fetchPerson above). Login-Tokens use
// their own, different scheme: "Authorization: Login <token>", not "Bearer <token>" — confirmed
// against ChurchTools' own API authentication docs. Using the wrong scheme fails as a 401
// (rejected outright), not a 403 (rejected but authenticated) — the two token types are not
// interchangeable and must never share a header-building helper without being explicit about
// which scheme applies.
export async function fetchPersonById(config, loginToken, personId) {
  const url = new URL(`/api/persons/${personId}`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Login ${loginToken}` } });
  const data = await parseOrThrow(response, 'Personenabruf');
  return data.data;
}

export async function fetchGroupMemberIds(config, loginToken, groupId) {
  const url = new URL(`/api/groups/${groupId}/members`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Login ${loginToken}` } });
  const data = await parseOrThrow(response, 'Gruppenabfrage');
  return data.data.map((member) => String(member.personId));
}

export async function resolveMemberGroupIds(config, loginToken, personId, candidateGroupIds) {
  const memberships = await Promise.all(
    candidateGroupIds.map(async (groupId) => {
      const memberIds = await fetchGroupMemberIds(config, loginToken, groupId);
      return memberIds.includes(String(personId)) ? String(groupId) : null;
    })
  );
  return memberships.filter(Boolean);
}
