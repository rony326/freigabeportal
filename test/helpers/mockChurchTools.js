import { MockAgent, setGlobalDispatcher } from 'undici';

export function setupMockChurchTools(baseUrl) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent.get(baseUrl);
}
