import { fetchGroupMemberIds, fetchPersonById } from './churchtools.js';
import { upsertPerson, getAllActivePersonIds, deactivatePerson, markUnresolved, personExists } from '../db/personenRepo.js';
import { startSyncLog, finishSyncLog } from '../db/syncLogRepo.js';

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

    let upserted = 0;
    let unresolved = 0;
    for (const [personId, gruppen] of personIdToGroups) {
      try {
        const profile = await fetchPersonById(config, accessToken, personId);
        upsertPerson(db, {
          id: String(personId),
          vorname: profile.firstName,
          nachname: profile.lastName,
          email: profile.email,
          gruppen,
          loggedInNow: false,
        });
        upserted += 1;
      } catch {
        if (personExists(db, personId)) {
          markUnresolved(db, personId);
        }
        unresolved += 1;
      }
    }

    const relevantIds = new Set(personIdToGroups.keys());
    let deactivated = 0;
    for (const activeId of getAllActivePersonIds(db)) {
      if (!relevantIds.has(activeId)) {
        deactivatePerson(db, activeId);
        deactivated += 1;
      }
    }

    finishSyncLog(db, syncLogId, {
      status: 'erfolg',
      anzahlUpserted: upserted,
      anzahlDeaktiviert: deactivated,
      fehlerDetails: unresolved > 0 ? `${unresolved} Person(en) nicht auflösbar` : null,
    });
    return { upserted, deactivated, unresolved };
  } catch (err) {
    finishSyncLog(db, syncLogId, { status: 'fehler', fehlerDetails: err.message });
    throw err;
  }
}
