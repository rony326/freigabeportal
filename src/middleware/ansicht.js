// Middleware "Ansichtswahl": merkt pro Liste, ob Tabelle oder Kacheln angezeigt werden soll.
// `?ansicht=tabelle|kacheln` setzt ein Cookie und leitet auf die URL ohne den Parameter zurück;
// danach stehen `res.locals.ansicht` ('tabelle' | 'kacheln' | 'auto'), `ansichtSchluessel` und
// `ansichtBasisQuery` den Views zur Verfügung (Umschalter: views/_ansicht_umschalter.ejs).

// Ansichtswahl Tabelle/Kacheln pro Liste, gemerkt in einem Cookie (siehe views/_ansicht_umschalter.ejs).
// Welche Pfade eine umschaltbare Liste haben, und unter welchem Cookie-Namensteil (`ansicht_<Schlüssel>`).
// Neue Liste mit Umschalter: hier eintragen.
export const ANSICHT_SCHLUESSEL = {
  '/pool': 'pool',
  '/meine-spesen': 'meine-spesen',
  '/meine-abgeschlossenen': 'meine-abgeschlossenen',
  '/kreditkarte': 'kreditkarte',
  '/admin/vorgaenge': 'admin-vorgaenge',
  '/admin/abgelehnt': 'admin-abgelehnt',
  '/admin/altfaelle': 'admin-altfaelle',
};

const GUELTIG = new Set(['tabelle', 'kacheln']);
const EIN_JAHR_MS = 365 * 24 * 60 * 60 * 1000;

// Erzeugt die Middleware. Pfade ausserhalb der Tabelle werden nie umgeleitet (kein Open Redirect).
export function ansichtWahl() {
  return (req, res, next) => {
    const pfad = req.path.length > 1 ? req.path.replace(/\/$/, '') : req.path;
    const schluessel = Object.hasOwn(ANSICHT_SCHLUESSEL, pfad) ? ANSICHT_SCHLUESSEL[pfad] : null;

    const queryTeile = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
    const gewuenscht = queryTeile.get('ansicht');

    if (schluessel && req.method === 'GET' && GUELTIG.has(gewuenscht)) {
      res.cookie(`ansicht_${schluessel}`, gewuenscht, {
        path: '/',
        maxAge: EIN_JAHR_MS,
        sameSite: 'lax',
      });
      queryTeile.delete('ansicht');
      const rest = queryTeile.toString();
      // Nur fester Pfad aus der Schlüsseltabelle + Rest-Query: kein Open Redirect.
      return res.redirect(302, rest ? `${pfad}?${rest}` : pfad);
    }

    queryTeile.delete('ansicht');
    const cookieWert = schluessel ? req.cookies?.[`ansicht_${schluessel}`] : null;
    res.locals.ansichtSchluessel = schluessel;
    res.locals.ansicht = GUELTIG.has(cookieWert) ? cookieWert : 'auto';
    res.locals.ansichtBasisQuery = queryTeile.toString();
    return next();
  };
}
