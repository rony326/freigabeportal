import { withAuditOperation, currentAuditOperation, currentAuditActor } from './auditContext.js';

export function auditedJob(kind, action) {
  return function (...args) {
    return withAuditOperation(kind, () => {
      const db = args[0];
      const actor = currentAuditActor();
      const write = (phase, status = null) => db.prepare(`INSERT INTO audit_ereignisse
        (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
        VALUES (?, ?, ?, 'hintergrundlauf', ?, ?, ?)`).run(new Date().toISOString(), actor.id, actor.name,
        currentAuditOperation().id, phase, JSON.stringify({ kind, status }));
      write('lauf_gestartet');
      const success = (result) => {
        const status = ['erfolg', 'fehler', 'uebersprungen'].includes(result?.status) ? result.status : 'beendet';
        write('lauf_beendet', status);
        return result;
      };
      const failure = (err) => { write('lauf_abgebrochen', 'fehler'); throw err; };
      let result;
      try { result = action(...args); } catch (err) { return failure(err); }
      return result && typeof result.then === 'function' ? result.then(success, failure) : success(result);
    });
  };
}
