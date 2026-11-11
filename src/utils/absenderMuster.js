// Validierung von Absender-Mustern (E-Mail oder Domain) – siehe Kommentar unten.

// Gültiges Absender-Muster: entweder eine E-Mail-Adresse ("rechnung@lieferant.ch", Treffer "exakt")
// oder eine Domain mit mindestens einem Punkt ("lieferant.ch", Treffer "Domain"). Gemeinsam genutzt
// von den Zuweisungsregeln (admin/kreditoren.js) und der Kartenerkennung (admin/kreditkarten.js).
const EMAIL_MUSTER_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_MUSTER_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Länge begrenzen, bevor ein Muster läuft (Schutz vor sehr langer Eingabe).
const MUSTER_MAX_LAENGE = 320;

// Einheitliche Fehlermeldung für ungültige Muster (in beiden Admin-Formularen identisch).
export const ABSENDER_MUSTER_FEHLER = 'Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").';

/**
 * @param {unknown} muster Eingabe aus dem Formular
 * @returns {boolean} true bei gültiger E-Mail-Adresse oder Domain (max. 320 Zeichen)
 */
export function isValidAbsenderMuster(muster) {
  if (typeof muster !== 'string' || muster.length > MUSTER_MAX_LAENGE) return false;
  return muster.includes('@') ? EMAIL_MUSTER_PATTERN.test(muster) : DOMAIN_MUSTER_PATTERN.test(muster);
}
