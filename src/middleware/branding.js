// Stellt das Erscheinungsbild (Farben, Logo, Farbmodus, Fusszeile, Seitentitel) auf JEDER Antwort als
// `res.locals.branding` bereit – auch auf Fehlerseiten. Quelle: Tabelle `admin_config` (Admin-Seite
// "Erscheinungsbild", routes/admin/erscheinungsbild.js). Setzt ausserdem `res.locals.spesenModulAktiv`.

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

// Liest den persönlichen Farbmodus aus dem Cookie `theme` (hell | dunkel | system); alles andere → null.
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

// Middleware-Fabrik. Der persönliche Farbmodus (Cookie) geht vor dem Standard der Gemeinde (Admin-Config).
// `themeAttr` = Wert für `data-theme` (null = Browser/System entscheidet), `farbmodusWahl` = aktive Auswahl im Umschalter.
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
      // Bootstrap 5.3 hat sein eigenes Dark-Mode-Attribut, getrennt vom data-theme="dunkel"/"hell" dieser App. Es wird
      // hier einmal berechnet, damit das <html>-Tag jeder Ansicht beide aus demselben Umschalter setzen kann, ohne die
      // Zuordnung dunkel/dark an 17 Stellen zu wiederholen.
      bsThemeAttr: themeAttr === 'dunkel' ? 'dark' : themeAttr === 'hell' ? 'light' : null,
    };
    res.locals.spesenModulAktiv = c.modul_spesen_aktiv !== '0';
    next();
  };
}
