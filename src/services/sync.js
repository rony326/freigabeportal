import { fetchGroupMemberIds, fetchPersonById } from './churchtools.js';
import { upsertPerson, listActivePersonsMitGruppen, deactivatePerson, markUnresolved, personExists, setPersonGruppen } from '../db/personenRepo.js';
import { listKontoReferencedPersonIds } from '../db/kontenRepo.js';
import { startSyncLog, finishSyncLog } from '../db/syncLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

// Zugangsmodell (siehe docs/rollen-und-berechtigungen.md, Abschnitt Personen-Sync):
//
// Anmelden darf jede Person, die sich über ChurchTools-OAuth anmelden kann (AUTH-WIDEN-1) --
// Verwaltungsgruppen (Buchhaltung/Admin/Manager) steuern nur Rollen, nicht den Portalzugang.
// Reine Spesen-Nutzer, Kartenverantwortliche, Ferienvertretungen, Konto-Freigeber und Personen
// mit Einzelrechten brauchen deshalb keine Gruppenmitgliedschaft. Der Sync unterscheidet drei
// Fälle für jede aktive Person:
//
// 1. Fehlende Gruppenzugehörigkeit: die (erfolgreich geladenen) Gruppenlisten enthalten die
//    Person nicht. Folge: gespeicherte Gruppen werden geleert (Rollenrechte entfallen sofort),
//    die Person bleibt aktiv, solange ChurchTools sie weiterhin kennt.
// 2. Tatsächlich entzogener Zugang: ChurchTools meldet die Person als nicht (mehr) vorhanden
//    (HTTP 404/410) oder ausdrücklich archiviert. Folge: Deaktivierung mit Grund.
// 3. Vorübergehender Ausfall: Netzwerkfehler, 5xx, 401/403, 429 usw. beim Einzelabruf. Folge:
//    nichts wird deaktiviert, die Person wird als "nicht auflösbar" markiert. Scheitert bereits
//    ein Gruppenabruf, bricht der ganze Lauf ohne Änderungen ab (Fehler im sync_log).
//
// Eine in ChurchTools nur gesperrte, aber weiterhin abrufbare Person kann der Sync nicht als
// gesperrt erkennen (die REST-API liefert dafür kein verlässliches Merkmal); sie kann sich über
// OAuth aber auch nicht mehr neu anmelden. Siehe Restrisiko in der Dokumentation.
const ZUGANG_ENTZOGEN_HTTP = new Set([404, 410]);

function entzugsgrund(profile) {
  // Nur ein ausdrücklich gesetztes true zählt; fehlt das Feld (ältere ChurchTools-Versionen),
  // gilt die Person als nicht archiviert.
  if (profile && profile.isArchived === true) return 'churchtools_archiviert';
  return null;
}

async function ladeProfil(config, accessToken, personId) {
  try {
    const profile = await fetchPersonById(config, accessToken, personId);
    const grund = entzugsgrund(profile);
    return grund ? { art: 'entzogen', grund } : { art: 'ok', profile };
  } catch (err) {
    if (ZUGANG_ENTZOGEN_HTTP.has(err.status)) return { art: 'entzogen', grund: 'churchtools_geloescht' };
    return { art: 'nicht_aufloesbar', fehler: err.message };
  }
}

function gleicheGruppen(a, b) {
  return a.length === b.length && a.every((g) => b.includes(g));
}

export async function runPersonenSync(db, config, accessToken) {
  const syncLogId = startSyncLog(db);
  try {
    const candidateGroupIds = [config.groupIdBuchhaltung, config.groupIdAdmin, config.groupIdManager].filter(Boolean);
    const personIdToGroups = new Map();
    for (const groupId of candidateGroupIds) {
      const memberIds = await fetchGroupMemberIds(config, accessToken, groupId);
      for (const personId of memberIds) {
        const groups = personIdToGroups.get(personId) ?? [];
        groups.push(String(groupId));
        personIdToGroups.set(personId, groups);
      }
    }
    const gruppenmitglieder = new Set(personIdToGroups.keys());

    // SYNC-WIDEN-1: Konto-Freigeber/-Stellvertreter werden auch dann angelegt bzw. aktualisiert,
    // wenn sie noch nie angemeldet waren (Konten können auf solche Personen verweisen). Alle
    // bereits aktiven Personen kommen ebenfalls dazu -- ihr Zugang wird einzeln geprüft statt
    // aus fehlender Gruppenmitgliedschaft abgeleitet.
    const aktiveVorher = listActivePersonsMitGruppen(db);
    const zuPruefen = new Map(personIdToGroups);
    for (const personId of [...listKontoReferencedPersonIds(db), ...aktiveVorher.map((p) => p.id)]) {
      if (personId && !zuPruefen.has(personId)) zuPruefen.set(personId, []);
    }

    const resolvedProfiles = [];
    const zugangEntzogen = new Map();
    const nichtAufloesbar = [];
    for (const [personId, gruppen] of zuPruefen) {
      const ergebnis = await ladeProfil(config, accessToken, personId);
      if (ergebnis.art === 'ok') {
        resolvedProfiles.push({ personId, gruppen, profile: ergebnis.profile });
      } else if (ergebnis.art === 'entzogen' && !gruppenmitglieder.has(personId)) {
        zugangEntzogen.set(personId, ergebnis.grund);
      } else {
        // Auch ein Gruppenmitglied mit 404 wird nie deaktiviert: widersprüchliche Antworten von
        // ChurchTools werden wie ein Ausfall behandelt.
        nichtAufloesbar.push({ personId, gruppen });
      }
    }
    const unresolved = nichtAufloesbar.length;

    const aktivVorherIds = new Set(aktiveVorher.map((p) => p.id));
    const toDeactivate = [...zugangEntzogen.keys()].filter((id) => aktivVorherIds.has(id));
    // Rollenentzug durch geleerte/gekürzte Gruppenlisten zählt für die Massenänderungs-Sperre
    // genauso wie eine Deaktivierung: eine leere Gruppenantwort (Fehlkonfiguration, Ausfall) darf
    // nicht still allen Administratoren die Rolle nehmen.
    const rollenentzug = aktiveVorher
      .filter((p) => !zugangEntzogen.has(p.id) && p.gruppen.some((g) => !(personIdToGroups.get(p.id) ?? []).includes(g)))
      .map((p) => p.id);
    const betroffen = toDeactivate.length + rollenentzug.length;

    // SYNC-1: refuse to commit a sync run that would change an abnormally large share of the
    // active roster in one shot (a ChurchTools-side outage or misconfiguration returning an
    // empty/near-empty group membership list is exactly this shape). The percent threshold only
    // applies once the active population is at least as large as the absolute-count threshold —
    // below that, a single person's completely normal departure would otherwise be 100% of a tiny
    // population. Two dedicated arms catch what both miss at small scale: this run would touch
    // every active person, or would strip every current group-role holder of all roles. A
    // population of exactly one is exempted, since a lone person's departure is a normal event.
    const anzahlAktiv = aktiveVorher.length;
    const maxProzent = Number(getConfigValue(db, 'sync_max_deaktivierung_prozent') || '50');
    const maxAnzahl = Number(getConfigValue(db, 'sync_max_deaktivierung_anzahl') || '10');
    const prozentBetroffen = anzahlAktiv > 0 ? (betroffen / anzahlAktiv) * 100 : 0;
    const prozentSchwelleAktiv = anzahlAktiv >= maxAnzahl;
    const totalWipe = anzahlAktiv >= 2 && betroffen === anzahlAktiv;
    const rolleninhaber = aktiveVorher.filter((p) => p.gruppen.length > 0);
    const rollenWipe = rolleninhaber.length >= 2 && rolleninhaber.every((p) => zugangEntzogen.has(p.id) || !personIdToGroups.has(p.id));
    const abbrechen =
      betroffen > 0 &&
      ((prozentSchwelleAktiv && prozentBetroffen > maxProzent) || betroffen > maxAnzahl || totalWipe || rollenWipe);

    if (abbrechen) {
      const meldung = `Sync abgebrochen: ${betroffen} von ${anzahlAktiv} aktiven Personen (${Math.round(prozentBetroffen)}%) würden deaktiviert (${toDeactivate.length}) oder verlören Gruppenrollen (${rollenentzug.length}) — Schwelle ${maxProzent}%/${maxAnzahl}`;
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
      const vorherGruppen = new Map(aktiveVorher.map((p) => [p.id, p.gruppen]));
      for (const { personId, gruppen } of nichtAufloesbar) {
        if (!personExists(db, personId)) continue;
        markUnresolved(db, personId);
        // Die Gruppenlisten selbst wurden erfolgreich geladen: eine dort fehlende Mitgliedschaft
        // steht fest, auch wenn das Profil gerade nicht abrufbar ist.
        const alt = vorherGruppen.get(personId);
        if (alt && !gleicheGruppen(alt, gruppen)) setPersonGruppen(db, personId, gruppen);
      }
      for (const personId of toDeactivate) {
        deactivatePerson(db, personId, zugangEntzogen.get(personId));
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
      fehlerDetails: unresolved > 0 ? `${unresolved} Person(en) nicht auflösbar (vorübergehend beibehalten)` : null,
    });
    return { upserted, deactivated, unresolved, rollenentzug: rollenentzug.length, abgebrochen: false };
  } catch (err) {
    finishSyncLog(db, syncLogId, { status: 'fehler', fehlerDetails: err.message });
    throw err;
  }
}
