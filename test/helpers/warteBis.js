// Wartet, bis bedingung() wahr ist (für Mails, die im Hintergrund versandt werden).
export async function warteBis(bedingung, { timeoutMs = 2000, schrittMs = 5 } = {}) {
  const ende = Date.now() + timeoutMs;
  while (!bedingung()) {
    if (Date.now() > ende) throw new Error('warteBis: Zeitüberschreitung');
    await new Promise((resolve) => setTimeout(resolve, schrittMs));
  }
}
