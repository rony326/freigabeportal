import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

export function createModuleRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function werte() {
    return {
      spesenAktiv: getConfigValue(db, 'modul_spesen_aktiv') !== '0',
      kreditkartenAktiv: getConfigValue(db, 'modul_kreditkarten_aktiv') === '1',
      rapporteAktiv: getConfigValue(db, 'modul_rapporte_aktiv') === '1',
      strikteFreigeber1Pruefung: getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') === '1',
      auditLogLokaleZeit: getConfigValue(db, 'audit_log_lokale_zeit') === '1',
      auswertungOffenSchwelleTage: getConfigValue(db, 'auswertung_offen_schwelle_tage') ?? '14',
      fehler: null,
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/module-form', { ...werte(), gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/', csrfProtection, (req, res) => {
    // Fehlt das Feld (ältere Formulare), bleibt der gespeicherte Wert unverändert.
    const schwelle = req.body.auswertungOffenSchwelleTage;
    const schwelleGueltig = schwelle === undefined || (/^\d{1,3}$/.test(String(schwelle).trim()) && Number(schwelle) >= 1 && Number(schwelle) <= 365);
    if (!schwelleGueltig) {
      return res.status(400).render('admin/module-form', {
        ...werte(),
        auswertungOffenSchwelleTage: String(schwelle ?? ''),
        fehler: 'Die Schwelle «länger offen» muss eine ganze Zahl zwischen 1 und 365 Tagen sein.',
        gespeichert: false,
      });
    }
    // An unchecked HTML checkbox submits no field at all, so its absence means "off" here —
    // same convention as this app's other on/off admin_config flags (e.g. audit_log_lokale_zeit).
    setConfigValue(db, 'modul_spesen_aktiv', req.body.spesenAktiv ? '1' : '0');
    setConfigValue(db, 'modul_kreditkarten_aktiv', req.body.kreditkartenAktiv ? '1' : '0');
    setConfigValue(db, 'modul_rapporte_aktiv', req.body.rapporteAktiv ? '1' : '0');
    setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', req.body.strikteFreigeber1Pruefung ? '1' : '0');
    setConfigValue(db, 'audit_log_lokale_zeit', req.body.auditLogLokaleZeit ? '1' : '0');
    if (schwelle !== undefined) setConfigValue(db, 'auswertung_offen_schwelle_tage', String(Number(schwelle)));
    res.redirect('/admin/module?gespeichert=1');
  });

  return router;
}
