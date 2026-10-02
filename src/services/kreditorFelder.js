// Kompatibilitaet fuer die Umbenennung Debitor -> Kreditor (docs/kreditoren-statt-debitoren.md).
//
// Neue Daten werden ausschliesslich unter kreditor_id/kreditorId gefuehrt. Alte Namen werden nur
// noch gelesen: in historischen Datensaetzen (Freigabe-Snapshots, Audit vorher/nachher,
// Exportmanifeste) und in Formularen, die vor dem Deployment geladen wurden. Liegen alter und neuer
// Wert gleichzeitig und widerspruechlich vor, wird abgelehnt statt geraten.

export class KreditorFeldKonflikt extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function normalisiert(wert) {
  if (wert === undefined || wert === null || wert === '') return null;
  return String(wert);
}

function waehle(neu, alt, bezeichnung) {
  const n = normalisiert(neu);
  const a = normalisiert(alt);
  if (n !== null && a !== null && n !== a) throw new KreditorFeldKonflikt(`Widerspruechliche Angaben fuer ${bezeichnung} (neues und altes Feld).`);
  return n ?? a;
}

// Formular-/API-Eingabe: kreditorId, uebergangsweise auch debitorId.
export function kreditorIdAusEingabe(body = {}) {
  return waehle(body.kreditorId, body.debitorId, 'den Kreditor');
}

// Gespeicherter Datensatz (z.B. snapshot.job, Audit-nachher). Versionsunabhaengig: Datensaetze vor
// der Umbenennung tragen debitor_id, danach kreditor_id. Liefert die ID als Zahl oder null.
export function kreditorIdAusDatensatz(datensatz = {}) {
  const wert = waehle(datensatz.kreditor_id, datensatz.debitor_id, 'den Kreditor im Datensatz');
  return wert === null ? null : Number(wert);
}

// Mail-Vorlagen: bereits gespeicherte, vom Admin angepasste Vorlagen koennen noch %debitorName%
// enthalten. Beide Platzhalter werden deshalb mit demselben Wert befuellt.
export function kreditorNameVariablen(name) {
  return { kreditorName: name, debitorName: name };
}
