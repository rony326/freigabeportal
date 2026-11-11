// Budgets pro Konto und Kalenderjahr für die Auswertung.

// @returns {number|null} Budget des Kontos im Jahr (CHF) oder null, wenn keines erfasst ist
export function getBudget(db, kontoId, jahr) {
  const row = db.prepare('SELECT betrag FROM konto_budgets WHERE konto_id = ? AND jahr = ?').get(kontoId, jahr);
  return row ? row.betrag : null;
}

// @returns {Map<number, number>} Konto-id → Budget für das Jahr
export function listBudgetsFuerJahr(db, jahr) {
  const rows = db.prepare('SELECT konto_id, betrag FROM konto_budgets WHERE jahr = ?').all(jahr);
  return new Map(rows.map((row) => [row.konto_id, row.betrag]));
}

// Legt ein Jahresbudget an oder überschreibt es. Wirft bei negativem Betrag oder unplausiblem Jahr.
export function setzeBudget(db, { kontoId, jahr, betrag, personId }) {
  if (!Number.isFinite(betrag) || betrag < 0) throw new Error('Budget muss eine Zahl ≥ 0 sein');
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) throw new Error('Ungültiges Budget-Jahr');
  db.prepare(`INSERT INTO konto_budgets (konto_id, jahr, betrag, geaendert_von, geaendert_am) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(konto_id, jahr) DO UPDATE SET betrag = excluded.betrag, geaendert_von = excluded.geaendert_von, geaendert_am = excluded.geaendert_am`)
    .run(kontoId, jahr, betrag, personId ?? null, new Date().toISOString());
}

// Löscht das Budget eines Kontos für ein Jahr (kein Budget = keine Budgetanzeige in der Auswertung).
export function entferneBudget(db, kontoId, jahr) {
  db.prepare('DELETE FROM konto_budgets WHERE konto_id = ? AND jahr = ?').run(kontoId, jahr);
}
