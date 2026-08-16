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
  const url = new URL('/api/whoami', config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseOrThrow(response, 'Profilabruf');
  return data.data;
}

export async function fetchPersonById(config, accessToken, personId) {
  const url = new URL(`/api/persons/${personId}`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseOrThrow(response, 'Personenabruf');
  return data.data;
}

export async function fetchGroupMemberIds(config, accessToken, groupId) {
  const url = new URL(`/api/groups/${groupId}/members`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseOrThrow(response, 'Gruppenabfrage');
  return data.data.map((member) => String(member.personId));
}

export async function resolveMemberGroupIds(config, accessToken, personId, candidateGroupIds) {
  const memberships = await Promise.all(
    candidateGroupIds.map(async (groupId) => {
      const memberIds = await fetchGroupMemberIds(config, accessToken, groupId);
      return memberIds.includes(String(personId)) ? String(groupId) : null;
    })
  );
  return memberships.filter(Boolean);
}
