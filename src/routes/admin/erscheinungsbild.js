import { Router } from 'express';
import multer from 'multer';
import { mitAuditKontext } from '../../services/auditContext.js';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigValue, setConfigValue, deleteConfigValue } from '../../db/adminConfigRepo.js';

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const VALID_THEME_DEFAULTS = new Set(['hell', 'dunkel', 'system']);
const VALID_LOGO_AUSRICHTUNGEN = new Set(['links', 'mitte', 'rechts']);
const ALLOWED_MIMETYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Zwei Logos: hell (Standard, auch Druck) und optional dunkel für den Dunkelmodus.
const LOGOS = [
  { feld: 'logo', label: 'Logo hell', datei: 'logo', pfadKey: 'branding_logo_pfad', mimetypeKey: 'branding_logo_mimetype' },
  { feld: 'logoDunkel', label: 'Logo dunkel', datei: 'logo-dunkel', pfadKey: 'branding_logo_dunkel_pfad', mimetypeKey: 'branding_logo_dunkel_mimetype' },
];

// Sniffs the actual file-signature bytes so a mislabeled upload (e.g. an SVG
// renamed to logo.png with a spoofed `Content-Type: image/png`) is caught
// even though multer's `file.mimetype` is just the client-declared header.
function detectImageMimetype(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export function createErscheinungsbildRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function currentState() {
    return {
      primaryColor: getConfigValue(db, 'branding_farbe_primaer'),
      secondaryColor: getConfigValue(db, 'branding_farbe_sekundaer'),
      themeDefault: getConfigValue(db, 'branding_theme_default'),
      logoAusrichtung: getConfigValue(db, 'branding_logo_ausrichtung') || 'links',
      footerText: getConfigValue(db, 'footer_text') ?? '',
      seitenTitel: getConfigValue(db, 'seiten_titel') ?? '',
      hasLogo: Boolean(getConfigValue(db, 'branding_logo_pfad')),
      hasLogoDunkel: Boolean(getConfigValue(db, 'branding_logo_dunkel_pfad')),
    };
  }

  function loescheLogoDatei({ pfadKey }) {
    const pfad = getConfigValue(db, pfadKey);
    if (pfad && existsSync(pfad)) unlinkSync(pfad);
  }

  function entferneLogo(logo) {
    loescheLogoDatei(logo);
    deleteConfigValue(db, logo.pfadKey);
    deleteConfigValue(db, logo.mimetypeKey);
  }

  function speichereLogo(logo, datei) {
    loescheLogoDatei(logo);
    mkdirSync(config.brandingDir, { recursive: true });
    const neuerPfad = join(config.brandingDir, `${logo.datei}.${ALLOWED_MIMETYPES[datei.mimetype]}`);
    writeFileSync(neuerPfad, datei.buffer);
    setConfigValue(db, logo.pfadKey, neuerPfad);
    setConfigValue(db, logo.mimetypeKey, datei.mimetype);
  }

  router.get('/', (req, res) => {
    res.render('admin/erscheinungsbild-form', { ...currentState(), errors: [], gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/', (req, res, next) => {
    mitAuditKontext(upload.fields(LOGOS.map(({ feld }) => ({ name: feld, maxCount: 1 }))))(req, res, (uploadErr) => {
      // csrfProtection runs after multer parses the multipart body (including the _csrf field) —
      // any earlier and req.body would still be empty, rejecting every legitimate submission.
      csrfProtection(req, res, (csrfErr) => {
      if (csrfErr) return next(csrfErr);
      if (uploadErr) {
        const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Logo-Datei darf höchstens 2 MB gross sein.' : 'Fehler beim Datei-Upload.';
        return res.status(400).render('admin/erscheinungsbild-form', {
          primaryColor: req.body.primaryColor,
          secondaryColor: req.body.secondaryColor,
          themeDefault: req.body.themeDefault,
          logoAusrichtung: req.body.logoAusrichtung || 'links',
          footerText: req.body.footerText || '',
          seitenTitel: req.body.seitenTitel || '',
          hasLogo: currentState().hasLogo,
          hasLogoDunkel: currentState().hasLogoDunkel,
          errors: [message],
          gespeichert: false,
        });
      }

      const { primaryColor, secondaryColor, themeDefault, logoAusrichtung } = req.body;
      const footerText = (req.body.footerText || '').trim();
      const seitenTitel = (req.body.seitenTitel || '').trim();
      const errors = [];
      if (!HEX_COLOR_PATTERN.test(primaryColor || '')) errors.push('Primärfarbe muss ein gültiger Hex-Farbwert sein (z.B. #2f4858).');
      if (!HEX_COLOR_PATTERN.test(secondaryColor || '')) errors.push('Sekundärfarbe muss ein gültiger Hex-Farbwert sein (z.B. #4d7ea8).');
      if (!VALID_THEME_DEFAULTS.has(themeDefault)) errors.push('Ungültiger Standard-Farbmodus.');
      if (!VALID_LOGO_AUSRICHTUNGEN.has(logoAusrichtung)) errors.push('Ungültige Logo-Ausrichtung.');
      if (footerText.length > 200) errors.push('Footer-Text darf höchstens 200 Zeichen lang sein.');
      if (seitenTitel.length > 60) errors.push('Seitentitel darf höchstens 60 Zeichen lang sein.');
      const dateien = Object.fromEntries(LOGOS.map(({ feld }) => [feld, req.files?.[feld]?.[0]]));
      for (const { feld, label } of LOGOS) {
        const datei = dateien[feld];
        if (!datei) continue;
        const detectedMimetype = detectImageMimetype(datei.buffer);
        if (!ALLOWED_MIMETYPES[datei.mimetype] || !detectedMimetype || detectedMimetype !== datei.mimetype) {
          errors.push(`${label} muss eine PNG- oder JPEG-Datei sein.`);
        }
      }

      if (errors.length > 0) {
        return res.status(400).render('admin/erscheinungsbild-form', {
          primaryColor,
          secondaryColor,
          themeDefault,
          logoAusrichtung,
          footerText,
          seitenTitel,
          hasLogo: currentState().hasLogo,
          hasLogoDunkel: currentState().hasLogoDunkel,
          errors,
          gespeichert: false,
        });
      }

      setConfigValue(db, 'branding_farbe_primaer', primaryColor);
      setConfigValue(db, 'branding_farbe_sekundaer', secondaryColor);
      setConfigValue(db, 'branding_theme_default', themeDefault);
      setConfigValue(db, 'branding_logo_ausrichtung', logoAusrichtung);
      setConfigValue(db, 'footer_text', footerText);
      setConfigValue(db, 'seiten_titel', seitenTitel || 'Freigabeportal');

      for (const logo of LOGOS) {
        const datei = dateien[logo.feld];
        if (datei) speichereLogo(logo, datei);
      }
      // Ein gleichzeitig hochgeladenes dunkles Logo hat Vorrang vor dem Entfernen-Häkchen.
      if (req.body.logoDunkelEntfernen === '1' && !dateien.logoDunkel) entferneLogo(LOGOS[1]);

      res.redirect('/admin/erscheinungsbild?gespeichert=1');
      });
    });
  });

  return router;
}
