import { statSync } from 'node:fs';
import { getConfigValues } from '../db/adminConfigRepo.js';

// Logo-URL mit Versionsparameter aus der Änderungszeit der Datei: der Browser darf das Logo lange
// cachen (siehe routes/branding.js) und holt nach einem neuen Upload trotzdem sofort das neue.
// Fehlt die Datei, bleibt die URL unversioniert (die Route antwortet dann 404).
function logoUrl(basis, pfad) {
  if (!pfad) return basis;
  try {
    return `${basis}?v=${Math.floor(statSync(pfad).mtimeMs).toString(36)}`;
  } catch {
    return basis;
  }
}

function parseThemeCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('theme='));
  if (!entry) return null;
  const value = decodeURIComponent(entry.slice('theme='.length));
  return value === 'hell' || value === 'dunkel' || value === 'system' ? value : null;
}

// Eine Abfrage pro Anfrage statt elf. Bewusst kein Zwischenspeicher: admin_config wird auch
// direkt per SQL (Testmodus-Trigger, Wiederherstellung) geändert.
const BRANDING_SCHLUESSEL = [
  'branding_farbe_primaer', 'branding_farbe_sekundaer', 'branding_theme_default',
  'branding_logo_pfad', 'branding_logo_mimetype', 'branding_logo_ausrichtung',
  'branding_logo_dunkel_pfad', 'branding_logo_dunkel_mimetype',
  'footer_text', 'seiten_titel', 'modul_spesen_aktiv',
];

export function loadBranding(db) {
  return (req, res, next) => {
    const c = getConfigValues(db, BRANDING_SCHLUESSEL);
    const primaryColor = c.branding_farbe_primaer;
    const secondaryColor = c.branding_farbe_sekundaer;
    const themeDefault = c.branding_theme_default || 'system';
    const logoPfad = c.branding_logo_pfad;
    const logoMimetype = c.branding_logo_mimetype;
    const logoAusrichtung = c.branding_logo_ausrichtung || 'links';
    const logoDunkelPfad = c.branding_logo_dunkel_pfad;
    const logoDunkelMimetype = c.branding_logo_dunkel_mimetype;
    const footerText = c.footer_text ?? 'Freigabeportal';
    const seitenTitel = c.seiten_titel || 'Freigabeportal';

    const userTheme = parseThemeCookie(req.headers.cookie);
    let themeAttr;
    if (userTheme === 'system') {
      themeAttr = null;
    } else if (userTheme) {
      themeAttr = userTheme;
    } else if (themeDefault === 'hell' || themeDefault === 'dunkel') {
      themeAttr = themeDefault;
    } else {
      themeAttr = null;
    }

    const farbmodusWahl = userTheme
      || (themeDefault === 'hell' || themeDefault === 'dunkel' ? themeDefault : 'system');

    res.locals.branding = {
      primaryColor,
      secondaryColor,
      hasLogo: Boolean(logoPfad) && Boolean(logoMimetype),
      hasLogoDunkel: Boolean(logoDunkelPfad) && Boolean(logoDunkelMimetype),
      logoUrl: logoUrl('/branding/logo', logoPfad),
      logoDunkelUrl: logoUrl('/branding/logo-dunkel', logoDunkelPfad),
      logoAusrichtung,
      themeAttr,
      farbmodusWahl,
      footerText,
      seitenTitel,
      // Bootstrap 5.3's native dark-mode attribute is a separate value from this app's own
      // data-theme="dunkel"/"hell" — computed here once so every view's <html> tag can set both
      // from the same toggle without duplicating the dunkel/dark mapping in 17 places.
      bsThemeAttr: themeAttr === 'dunkel' ? 'dark' : themeAttr === 'hell' ? 'light' : null,
    };
    res.locals.spesenModulAktiv = c.modul_spesen_aktiv !== '0';
    next();
  };
}
