// Budgets pro Konto und Kalenderjahr für die Auswertung.

export function getBudget(db, kontoId, jahr) {
  const row = db.prepare('SELECT betrag FROM konto_budgets WHERE konto_id = ? AND jahr = ?').get(kontoId, jahr);
  return row ? row.betrag : null;
}

export function listBudgetsFuerJahr(db, jahr) {
  const rows = db.prepare('SELECT konto_id, betrag FROM konto_budgets WHERE jahr = ?').all(jahr);
  return new Map(rows.map((row) => [row.konto_id, row.betrag]));
}

export function setzeBudget(db, { kontoId, jahr, betrag, personId }) {
  if (!Number.isFinite(betrag) || betrag < 0) throw new Error('Budget muss eine Zahl ≥ 0 sein');
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) throw new Error('Ungültiges Budget-Jahr');
  db.prepare(`INSERT INTO konto_budgets (konto_id, jahr, betrag, geaendert_von, geaendert_am) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(konto_id, jahr) DO UPDATE SET betrag = excluded.betrag, geaendert_von = excluded.geaendert_von, geaendert_am = excluded.geaendert_am`)
    .run(kontoId, jahr, betrag, personId ?? null, new Date().toISOString());
}

export function entferneBudget(db, kontoId, jahr) {
  db.prepare('DELETE FROM konto_budgets WHERE konto_id = ? AND jahr = ?').run(kontoId, jahr);
}
