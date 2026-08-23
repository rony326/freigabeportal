import { MockAgent, setGlobalDispatcher } from 'undici';

// Mirrors mockChurchTools.js's mechanism: undici's MockAgent intercepts Node's global fetch
// (which pdf-rfc3161's sendTimestampRequest uses directly, exactly like churchtools.js does for
// ChurchTools), so tests never make a real network call to a TSA. Returns the MockPool for url's
// origin so callers chain their own `.intercept({ path, method }).reply(...)` per expected
// request, exactly like setupMockChurchTools.
export function setupMockTsa(url) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent.get(new URL(url).origin);
}
