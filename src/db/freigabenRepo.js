export function createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon, vertretungFuer = null, vorherZustaendig = null, zielPersonId = null }) {
  const result = db
    .prepare(
      `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von, vertretung_fuer, vorher_zustaendig, ziel_person_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt ? 1 : 0, kommentar ?? null, eskaliertVon ?? null, vertretungFuer ?? null, vorherZustaendig ?? null, zielPersonId ?? null);
  return Number(result.lastInsertRowid);
}

export function listFreigabenByJob(db, jobId) {
  return db.prepare('SELECT * FROM freigaben WHERE job_id = ? ORDER BY id').all(jobId);
}

// Wer für diesen Vorgang auf Stufe 1 oder 2 einen Interessenskonflikt erklärt hat. Ein erklärter
// Konflikt gehört zur Rechnung, nicht zu einem Routing-Zustand: gelesen wird deshalb der Verlauf
// (freigaben), den weder Admin-Umhängen noch Ablehnung oder Überarbeitung zurücksetzen. Für
// Stufe 1 zählt zusätzlich jobs.freigabe1_eskaliert_von (Eskalation ohne eigenen Verlaufseintrag).
export function listKonfliktmelder(db, jobId, stufe) {
  if (stufe !== 1 && stufe !== 2) throw new Error(`Unbekannte Freigabe-Stufe: ${stufe}`);
  const rolle = stufe === 1 ? 'freigabe1_eskalation' : 'freigabe2_eskalation';
  const melder = new Set(db.prepare('SELECT person_id FROM freigaben WHERE job_id = ? AND rolle = ?').all(jobId, rolle).map((f) => f.person_id));
  if (stufe === 1) {
    const job = db.prepare('SELECT freigabe1_eskaliert_von FROM jobs WHERE id = ?').get(jobId);
    if (job?.freigabe1_eskaliert_von) melder.add(job.freigabe1_eskaliert_von);
  }
  return melder;
}

export function istKonfliktmelder(db, jobId, stufe, personId) {
  return Boolean(personId) && listKonfliktmelder(db, jobId, stufe).has(personId);
}
