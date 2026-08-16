import { fetchGroupMemberIds, fetchPersonById } from './churchtools.js';
import { upsertPerson, getAllActivePersonIds, deactivatePerson, markUnresolved, personExists } from '../db/personenRepo.js';
import { startSyncLog, finishSyncLog } from '../db/syncLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

export async function runPersonenSync(db, config, accessToken) {
  const syncLogId = startSyncLog(db);
  try {
    const candidateGroupIds = [config.groupIdBuchhaltung, config.groupIdAdmin];
    const personIdToGroups = new Map();
    for (const groupId of candidateGroupIds) {
      const memberIds = await fetchGroupMemberIds(config, accessToken, groupId);
      for (const personId of memberIds) {
        const groups = personIdToGroups.get(personId) ?? [];
        groups.push(String(groupId));
        personIdToGroups.set(personId, groups);
      }
    }

    const resolvedProfiles = [];
    let unresolved = 0;
    for (const [personId, gruppen] of personIdToGroups) {
      try {
        const profile = await fetchPersonById(config, accessToken, personId);
        resolvedProfiles.push({ personId, gruppen, profile });
      } catch {
        if (personExists(db, personId)) {
          markUnresolved(db, personId);
        }
        unresolved += 1;
      }
    }

    const relevantIds = new Set(personIdToGroups.keys());
    const toDeactivate = getAllActivePersonIds(db).filter((id) => !relevantIds.has(id));

    // SYNC-1: refuse to commit a sync run that would deactivate an abnormally large share of
    // the active roster in one shot (a ChurchTools-side outage or misconfiguration returning
    // an empty/near-empty group membership list is exactly this shape). The percent threshold
    // only applies once the active population is at least as large as the absolute-count
    // threshold — below that, a single person's completely normal departure would otherwise be
    // 100% of a tiny population and trip a 50% guard on every ordinary sync in a small
    // congregation, which is the scale this app is built for.
    const aktiveVorher = getAllActivePersonIds(db).length;
    const maxProzent = Number(getConfigValue(db, 'sync_max_deaktivierung_prozent') || '50');
    const maxAnzahl = Number(getConfigValue(db, 'sync_max_deaktivierung_anzahl') || '10');
    const prozentDeaktiviert = aktiveVorher > 0 ? (toDeactivate.length / aktiveVorher) * 100 : 0;
    const prozentSchwelleAktiv = aktiveVorher >= maxAnzahl;
    const abbrechen =
      toDeactivate.length > 0 && ((prozentSchwelleAktiv && prozentDeaktiviert > maxProzent) || toDeactivate.length > maxAnzahl);

    if (abbrechen) {
      const meldung = `Sync abgebrochen: ${toDeactivate.length} von ${aktiveVorher} aktiven Personen (${Math.round(prozentDeaktiviert)}%) würden deaktiviert — Schwelle ${maxProzent}%/${maxAnzahl}`;
      finishSyncLog(db, syncLogId, { status: 'abgebrochen', fehlerDetails: meldung });
      return { upserted: 0, deactivated: 0, unresolved, abgebrochen: true, meldung };
    }

    let upserted = 0;
    let deactivated = 0;
    db.exec('BEGIN');
    try {
      for (const { personId, gruppen, profile } of resolvedProfiles) {
        upsertPerson(db, {
          id: String(personId),
          vorname: profile.firstName,
          nachname: profile.lastName,
          email: profile.email,
          gruppen,
          loggedInNow: false,
        });
        upserted += 1;
      }
      for (const activeId of toDeactivate) {
        deactivatePerson(db, activeId);
        deactivated += 1;
      }
      db.exec('COMMIT');
    } catch (writeErr) {
      db.exec('ROLLBACK');
      throw writeErr;
    }

    finishSyncLog(db, syncLogId, {
      status: 'erfolg',
      anzahlUpserted: upserted,
      anzahlDeaktiviert: deactivated,
      fehlerDetails: unresolved > 0 ? `${unresolved} Person(en) nicht auflösbar` : null,
    });
    return { upserted, deactivated, unresolved, abgebrochen: false };
  } catch (err) {
    finishSyncLog(db, syncLogId, { status: 'fehler', fehlerDetails: err.message });
    throw err;
  }
}
