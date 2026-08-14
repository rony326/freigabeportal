import { getConfigValue } from '../db/adminConfigRepo.js';

function parseThemeCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('theme='));
  if (!entry) return null;
  const value = decodeURIComponent(entry.slice('theme='.length));
  return value === 'hell' || value === 'dunkel' ? value : null;
}

export function loadBranding(db) {
  return (req, res, next) => {
    const primaryColor = getConfigValue(db, 'branding_farbe_primaer');
    const secondaryColor = getConfigValue(db, 'branding_farbe_sekundaer');
    const themeDefault = getConfigValue(db, 'branding_theme_default') || 'system';
    const logoPfad = getConfigValue(db, 'branding_logo_pfad');

    const userTheme = parseThemeCookie(req.headers.cookie);
    let themeAttr;
    if (userTheme) {
      themeAttr = userTheme;
    } else if (themeDefault === 'hell' || themeDefault === 'dunkel') {
      themeAttr = themeDefault;
    } else {
      themeAttr = null;
    }

    res.locals.branding = {
      primaryColor,
      secondaryColor,
      hasLogo: Boolean(logoPfad),
      themeAttr,
    };
    next();
  };
}
