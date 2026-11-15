// Bestätigung nach einer Aktion: Nach "Freigeben", "Ablehnen", "Kontieren" usw. leitet das Portal zur
// Aufgabenliste (/pool) weiter. Damit die Person weiss, dass es geklappt hat, setzt diese Middleware beim
// Weiterleiten ein kurzlebiges Cookie `erledigt` und zeigt beim nächsten Seitenaufruf einmal einen grünen Hinweis.
// Nur feste Texte aus einer Tabelle, nie Benutzereingaben.

const TEXTE = {
  freigeben: { titel: 'Freigegeben.', text: 'Der Beleg ist erledigt und aus deiner Liste verschwunden.' },
  ablehnen: { titel: 'Abgelehnt.', text: 'Die Rückmeldung ist unterwegs. Der Beleg ist aus deiner Liste verschwunden.' },
  kontieren: { titel: 'Kontiert.', text: 'Der Beleg geht jetzt weiter zur Freigabe und ist aus deiner Liste verschwunden.' },
  konflikt: { titel: 'Weitergegeben.', text: 'Weil du befangen bist, übernimmt jemand anderes. Der Beleg ist aus deiner Liste verschwunden.' },
  rapport: { titel: 'Weitergegeben.', text: 'Der Beleg ist aus deiner Liste verschwunden.' },
};
const COOKIE = 'erledigt';

// Gehört zu Aktionen auf Belegen; andere POSTs (Einstellungen usw.) bekommen keinen Hinweis.
const AKTIONS_PFADE = /^\/(freigabe2|kontierung|spesen-freigabe1)\/\d+\/?$/;

export function erledigtHinweis() {
  return (req, res, next) => {
    // Hinweis aus dem Cookie lesen und sofort wieder löschen (einmalige Anzeige, nur auf HTML-Seiten).
    const wert = req.cookies?.[COOKIE];
    if (wert && req.method === 'GET' && req.path === '/pool') {
      res.clearCookie(COOKIE, { path: '/' });
      if (Object.hasOwn(TEXTE, wert)) res.locals.erledigtHinweis = TEXTE[wert];
    }
    // Beim Weiterleiten nach erfolgreicher Aktion das Cookie setzen.
    if (req.method === 'POST' && AKTIONS_PFADE.test(req.path)) {
      const original = res.redirect.bind(res);
      res.redirect = (...args) => {
        const ziel = args.find((a) => typeof a === 'string');
        if (ziel === '/pool') {
          const body = req.body || {};
          let aktion = typeof body.aktion === 'string' ? body.aktion : null;
          // Freigabe 2 und Spesen-Freigabe 1 senden beim Freigeben keine `aktion` mit; die Kontierung immer.
          if (!aktion && !req.path.startsWith('/kontierung')) aktion = 'freigeben';
          if (body.interessenskonflikt) aktion = 'konflikt';
          if (aktion && Object.hasOwn(TEXTE, aktion)) {
            res.cookie(COOKIE, aktion, { path: '/', maxAge: 60 * 1000, sameSite: 'lax', httpOnly: true });
          }
        }
        return original(...args);
      };
    }
    next();
  };
}
