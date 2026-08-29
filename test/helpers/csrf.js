// The real createApp() now guards every session-authenticated POST route with CSRF protection
// (src/middleware/csrf.js) — full end-to-end tests that submit a form must first GET a page that
// rendered the hidden _csrf field and carry that value (plus the csrf-token cookie the same
// supertest agent already holds) into the POST.
export async function fetchCsrfToken(agent, path) {
  const res = await agent.get(path);
  const match = res.text.match(/name="_csrf" value="([^"]+)"/);
  if (!match) {
    throw new Error(`No _csrf hidden field found on GET ${path} (status ${res.status})`);
  }
  return match[1];
}

// set-cookie header order is not guaranteed once more than one cookie is set on a response (the
// CSRF middleware now also sets its own cookie on most GETs) — find a named cookie by regex
// across every entry instead of assuming a fixed index.
export function extractCookieValue(headers, name) {
  const setCookie = [].concat(headers['set-cookie'] || []);
  for (const entry of setCookie) {
    const match = entry.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}
