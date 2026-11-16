import { MockAgent, setGlobalDispatcher } from 'undici';

// Mitglieder-Abfragen (/api/groups/{id}/members) hängen heute Statusfilter, limit und page an die Adresse und
// verlangen groupMemberStatus 'active' an jedem Eintrag. Die vielen Tests, die nur einfach `{ data: [{ personId: 7 }] }`
// für den blanken Pfad vorgeben, behalten ihre Schreibweise: Der Pfad wird als Präfix verstanden und fehlende Status
// werden als 'active' ergänzt. Tests, die Anfrage oder Status selbst prüfen, geben `query` an oder einen Funktions-Pfad
// (dann wird nichts umgeschrieben).
const MITGLIEDER_PFAD = /^\/api\/groups\/[^/?]+\/members$/;

function mitMitgliederKomfort(pool) {
  const intercept = pool.intercept.bind(pool);
  pool.intercept = (opts) => {
    if (typeof opts?.path !== 'string' || !MITGLIEDER_PFAD.test(opts.path) || opts.query) return intercept(opts);
    const basis = opts.path;
    const interceptor = intercept({ ...opts, path: (p) => p === basis || p.startsWith(`${basis}?`) });
    const reply = interceptor.reply.bind(interceptor);
    interceptor.reply = (code, body, ...rest) => {
      if (body && typeof body === 'object' && Array.isArray(body.data)) {
        body = { ...body, data: body.data.map((m) => ({ groupMemberStatus: 'active', ...m })) };
      }
      return reply(code, body, ...rest);
    };
    return interceptor;
  };
  return pool;
}

export function setupMockChurchTools(baseUrl) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mitMitgliederKomfort(mockAgent.get(baseUrl));
}
