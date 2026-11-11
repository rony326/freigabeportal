// Admin → Datenbank-Backup (`/admin/backup`, Recht `backup_verwalten`, docs/backup-verschluesselung.md): Zeitplan und Aufbewahrung der Sicherung, Liste und Download der Sicherungsdateien (`.fpbak`), manuelles Auslösen,
// Löschen mit Audit, Prüfung ungeklärter Löschabsichten und Übersicht der Wiederherstellungen. Eine Wiederherstellung im laufenden Betrieb gibt es bewusst nicht (nur offline per CLI, docs/offline-restore.md).

import { Router } from 'express';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { listBackupWiederherstellungen } from '../../db/backupWiederherstellungenRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { runDatenbankSicherungJob } from '../../services/cronJobs.js';
import { BACKUP_DATEINAME_PATTERN } from '../../services/backup.js';
import { openBackupDownload } from '../../services/backupDownload.js';
import { deleteBackupWithAudit, listUnresolvedBackupDeletions, reviewBackupDeletion, BackupReviewError } from '../../services/backupAudit.js';

const SICHERUNG_LOG_LIMIT = 10;

export function createBackupRouter({ db, config, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  // Sicherungsdateien im Backup-Verzeichnis (neueste zuerst).
  function listeLokalerBackups() {
    if (!existsSync(config.backupDir)) return [];
    return readdirSync(config.backupDir)
      .filter((name) => BACKUP_DATEINAME_PATTERN.test(name))
      .map((dateiname) => {
        const stat = statSync(join(config.backupDir, dateiname));
        return { dateiname, groesseBytes: stat.size, erstelltAm: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.dateiname < b.dateiname ? 1 : -1));
  }

  // Protokoll der Offline-Wiederherstellungen mit Namen der Person.
  function listeWiederherstellungen() {
    return listBackupWiederherstellungen(db).map((w) => {
      const person = getPersonById(db, w.wiederhergestellt_von);
      return { ...w, personName: person ? `${person.vorname} ${person.nachname}` : w.wiederhergestellt_von };
    });
  }

  // Alle Daten der Seite (Zeitplan, Dateien, Läufe, Wiederherstellungen, offene Löschabsichten).
  function ladeState({ getriggert = null, wiederhergestellt = false, loeschungenVor = Number.MAX_SAFE_INTEGER } = {}) {
    const offeneLoeschungen = listUnresolvedBackupDeletions(db, { before: loeschungenVor, limit: 51 });
    return {
      cronStunde: getConfigValue(db, 'backup_cron_stunde'),
      cronMinute: getConfigValue(db, 'backup_cron_minute'),
      aufbewahrungAnzahl: getConfigValue(db, 'backup_aufbewahrung_anzahl'),
      backups: listeLokalerBackups(),
      sicherungLog: listRecentCronLog(db, 'datenbank-sicherung', SICHERUNG_LOG_LIMIT),
      wiederherstellungen: listeWiederherstellungen(),
      offeneLoeschungen: offeneLoeschungen.slice(0, 50),
      weitereOffeneLoeschungen: offeneLoeschungen.length > 50,
      getriggert,
      wiederhergestellt,
    };
  }

  // GET /admin/backup – die Seite.
  router.get('/', (req, res) => {
    const loeschungenVor = req.query.loeschungenVor === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.loeschungenVor);
    if (!Number.isSafeInteger(loeschungenVor) || loeschungenVor < 1) return res.status(400).render('error', { message: 'Ungueltige Seitengrenze.' });
    res.render('admin/backup', {
      ...ladeState({ getriggert: req.query.getriggert || null, loeschungenVor }),
      errors: [],
      restoreErrors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  // POST /admin/backup – speichert Zeitplan (Stunde, Minute) und Aufbewahrung (Anzahl).
  router.post('/', csrfProtection, (req, res) => {
    const { cronStunde, cronMinute, aufbewahrungAnzahl } = req.body;
    const errors = [];

    function ganzzahlImBereich(wert, min, max, label) {
      const num = Number(wert);
      if (!Number.isInteger(num) || num < min || num > max) {
        errors.push(`${label} muss eine Ganzzahl zwischen ${min} und ${max} sein.`);
      }
      return num;
    }

    const stundeNum = ganzzahlImBereich(cronStunde, 0, 23, 'Stunde');
    const minuteNum = ganzzahlImBereich(cronMinute, 0, 59, 'Minute');
    const aufbewahrungNum = Number(aufbewahrungAnzahl);
    if (!Number.isInteger(aufbewahrungNum) || aufbewahrungNum < 1) {
      errors.push('Aufbewahrung muss eine positive Ganzzahl sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/backup', {
        ...ladeState(),
        cronStunde,
        cronMinute,
        aufbewahrungAnzahl,
        errors,
        restoreErrors: [],
        gespeichert: false,
      });
    }

    setConfigValue(db, 'backup_cron_stunde', String(stundeNum));
    setConfigValue(db, 'backup_cron_minute', String(minuteNum));
    setConfigValue(db, 'backup_aufbewahrung_anzahl', String(aufbewahrungNum));
    res.redirect('/admin/backup?gespeichert=1');
  });

  // POST /admin/backup/jetzt-ausfuehren – löst die Sicherung sofort aus.
  router.post('/jetzt-ausfuehren', csrfProtection, (req, res, next) => {
    try {
      runDatenbankSicherungJob(db, config);
      res.redirect('/admin/backup?getriggert=1');
    } catch (err) {
      next(err);
    }
  });

  // GET /admin/backup/dateien/:name – lädt eine Sicherungsdatei herunter (nur gültige Dateinamen, ohne Symlink-Folge).
  router.get('/dateien/:name', (req, res) => {
    const { name } = req.params;
    if (!BACKUP_DATEINAME_PATTERN.test(name)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    const pfad = join(config.backupDir, name);
    if (!existsSync(pfad)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    let download;
    try { download = openBackupDownload(pfad); }
    catch { return res.status(404).render('error', { message: 'Backup nicht gefunden.' }); }
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.type(name.endsWith('.fpbak') ? 'application/octet-stream' : 'application/zip');
    res.setHeader('Content-Length', download.size);
    download.stream.on('error', () => res.destroy());
    res.on('close', () => download.stream.destroy());
    download.stream.pipe(res);
  });

  // POST /admin/backup/dateien/:name/loeschen – löscht eine Sicherung mit Audit (Absicht → Ergebnis).
  router.post('/dateien/:name/loeschen', csrfProtection, (req, res) => {
    const { name } = req.params;
    if (!BACKUP_DATEINAME_PATTERN.test(name)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    const pfad = join(config.backupDir, name);
    if (existsSync(pfad)) deleteBackupWithAudit(db, pfad, 'Manuelle Backup-Loeschung durch Administrator');
    res.redirect('/admin/backup');
  });

  // POST /admin/backup/loeschungen/:id/pruefen – manuelle Prüfung einer ungeklärten Löschabsicht (schliesst den Sicherheitsalarm).
  router.post('/loeschungen/:id/pruefen', csrfProtection, (req, res, next) => {
    try {
      reviewBackupDeletion(db, Number(req.params.id), req.body?.beobachtung, req.body?.begruendung);
      res.redirect('/admin/backup');
    } catch (err) {
      if (err instanceof BackupReviewError) return res.status(err.status).render('error', { message: err.message });
      next(err);
    }
  });

  // POST /admin/backup/wiederherstellen – gesperrt (423): nur offline über `npm run backup:restore`.
  router.post('/wiederherstellen', (req, res) => {
    res.status(423).render('error', {
      message: 'Wiederherstellung im laufenden Betrieb ist gesperrt. Bitte den Wartungsprozess verwenden.',
    });
  });

  return router;
}
