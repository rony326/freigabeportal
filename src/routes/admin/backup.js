import { Router } from 'express';
import multer from 'multer';
import { readdirSync, statSync, unlinkSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { listBackupWiederherstellungen } from '../../db/backupWiederherstellungenRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { runDatenbankSicherungJob } from '../../services/cronJobs.js';
import { BACKUP_DATEINAME_PATTERN, restoreBackupArchive, BackupValidationError } from '../../services/backup.js';

const SICHERUNG_LOG_LIMIT = 10;
const MAX_RESTORE_UPLOAD_SIZE = 500 * 1024 * 1024;
const BESTAETIGUNGSTEXT = 'WIEDERHERSTELLEN';
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESTORE_UPLOAD_SIZE } });

export function createBackupRouter({ db, config }) {
  const router = Router();

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

  function listeWiederherstellungen() {
    return listBackupWiederherstellungen(db).map((w) => {
      const person = getPersonById(db, w.wiederhergestellt_von);
      return { ...w, personName: person ? `${person.vorname} ${person.nachname}` : w.wiederhergestellt_von };
    });
  }

  function ladeState({ getriggert = null, wiederhergestellt = false } = {}) {
    return {
      cronStunde: getConfigValue(db, 'backup_cron_stunde'),
      cronMinute: getConfigValue(db, 'backup_cron_minute'),
      aufbewahrungAnzahl: getConfigValue(db, 'backup_aufbewahrung_anzahl'),
      backups: listeLokalerBackups(),
      sicherungLog: listRecentCronLog(db, 'datenbank-sicherung', SICHERUNG_LOG_LIMIT),
      wiederherstellungen: listeWiederherstellungen(),
      getriggert,
      wiederhergestellt,
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/backup', {
      ...ladeState({ getriggert: req.query.getriggert || null }),
      errors: [],
      restoreErrors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', (req, res) => {
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

  router.post('/jetzt-ausfuehren', (req, res, next) => {
    try {
      runDatenbankSicherungJob(db, config);
      res.redirect('/admin/backup?getriggert=1');
    } catch (err) {
      next(err);
    }
  });

  router.get('/dateien/:name', (req, res) => {
    const { name } = req.params;
    if (!BACKUP_DATEINAME_PATTERN.test(name)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    const pfad = join(config.backupDir, name);
    if (!existsSync(pfad)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.type('application/zip');
    res.setHeader('Content-Length', statSync(pfad).size);
    createReadStream(pfad).pipe(res);
  });

  router.post('/dateien/:name/loeschen', (req, res) => {
    const { name } = req.params;
    if (!BACKUP_DATEINAME_PATTERN.test(name)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    const pfad = join(config.backupDir, name);
    if (existsSync(pfad)) unlinkSync(pfad);
    res.redirect('/admin/backup');
  });

  router.post('/wiederherstellen', (req, res, next) => {
    uploadBackup.single('backup')(req, res, (uploadErr) => {
      try {
        if (uploadErr) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: [uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Backup-Datei ist zu gross.' : 'Fehler beim Datei-Upload.'],
            gespeichert: false,
          });
        }
        if (!req.file) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: ['Backup-Datei fehlt.'],
            gespeichert: false,
          });
        }
        if (req.body.bestaetigung !== BESTAETIGUNGSTEXT) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: [`Zur Bestätigung muss exakt "${BESTAETIGUNGSTEXT}" eingetippt werden.`],
            gespeichert: false,
          });
        }

        restoreBackupArchive(req.file.buffer, db, config, {
          wiederhergestelltVon: req.currentPerson.churchtools_person_id,
          quellDateiname: req.file.originalname,
        });
        res.render('admin/backup', { ...ladeState(), errors: [], restoreErrors: [], gespeichert: false, wiederhergestellt: true });
      } catch (err) {
        if (err instanceof BackupValidationError) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: [err.message],
            gespeichert: false,
          });
        }
        next(err);
      }
    });
  });

  return router;
}
