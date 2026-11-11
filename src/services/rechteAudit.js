import { currentAuditActor } from './auditContext.js';

function auditiere(db, objekt, objektId, vorher, nachher) {
  const alt = new Set(vorher);
  const neu = new Set(nachher);
  const actor = currentAuditActor();
  const insert = db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let anzahl = 0;
  const schreibe = (aktion, recht) => {
    insert.run(new Date().toISOString(), actor.id, actor.name, objekt, String(objektId), aktion, JSON.stringify({ recht }));
    anzahl += 1;
  };
  for (const recht of alt) if (!neu.has(recht)) schreibe('recht_entzogen', recht);
  for (const recht of neu) if (!alt.has(recht)) schreibe('recht_erteilt', recht);
  return anzahl;
}

// Ein Audit-Eintrag pro geändertem Recht; gibt die Anzahl zurück.
export function auditiereGruppenrechte(db, gruppe, vorher, nachher) {
  return auditiere(db, 'gruppenrechte', gruppe, vorher, nachher);
}

export function auditiereEinzelrechte(db, personId, vorher, nachher) {
  return auditiere(db, 'person_berechtigungen', personId, vorher, nachher);
}
