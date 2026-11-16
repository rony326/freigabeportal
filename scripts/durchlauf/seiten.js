// Durchlauf-Test (docs/durchlauf-test.md): liest Angaben aus den HTML-Seiten des Portals.
// Reine Logik (Text rein, Daten raus), damit die Erkennung ohne Browser unter test/unit/ prüfbar ist.
// Grundlage sind stabile id-Attribute der Views (views/_job_table.ejs, _job_kacheln.ejs,
// _abgeschlossen_table.ejs, _abgeschlossen_kacheln.ejs) und die Kopfzeile (views/_seite_anfang.ejs).

const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#34': '"', '#x27': "'", nbsp: ' ' };

// Macht die von EJS (`<%= %>`) maskierten Zeichen wieder lesbar.
export function entschluesseln(text) {
  return String(text ?? '')
    .replace(/&(amp|lt|gt|quot|#39|#34|#x27|nbsp);/g, (_, e) => ENTITAETEN[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

const ohneTags = (html) => entschluesseln(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Name aus «Angemeldet als Vorname Nachname» in der Kopfzeile; null ohne Anmeldung.
export function angemeldetAls(html) {
  const m = /Angemeldet als ([^<]+)<\/span>/.exec(String(html ?? ''));
  return m ? entschluesseln(m[1]).replace(/\s+/g, ' ').trim() || null : null;
}

// Versionsangabe aus der Fusszeile (views/_footer.ejs, nur sichtbar, wenn das Portal ein Git-Repo kennt).
export function versionAusFusszeile(html) {
  const fuss = /<footer[\s\S]*?<\/footer>/.exec(String(html ?? ''));
  if (!fuss) return null;
  const links = [...fuss[0].matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)].map((m) => entschluesseln(m[1]).trim());
  const version = links.filter((t) => t && t !== 'GitHub').pop();
  return version || null;
}

// Alle Belege, die eine Aufgabenseite (/pool) zeigt, als [{ id, bereich }] in der Reihenfolge der Seite.
// bereich = Präfix der Zeilen-/Kachel-ID: pool, ruecklaeufer, kontierung, freigabe2, abgelehnt, rapport, ...
// Im Ansichtsmodus «auto» erscheint jeder Beleg als Zeile und als Kachel; doppelte werden zusammengefasst.
export function belegeAufDashboard(html) {
  const gesehen = new Set();
  const liste = [];
  for (const m of String(html ?? '').matchAll(/\bid="([a-z0-9-]+?)-(?:row|kachel)-(\d+)"/g)) {
    const schluessel = `${m[1]}:${m[2]}`;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    liste.push({ id: Number(m[2]), bereich: m[1] });
  }
  return liste;
}

// Bereiche, in denen ein neu eingegangener Beleg bei Person A auftaucht: im Pool (Buchhaltung) oder,
// per Zuweisungsregel, direkt unter «Meine offenen Kontierungen».
export const EINGANGS_BEREICHE = ['pool', 'kontierung'];

// Momentaufnahme vor dem Lauf: alle IDs, die A schon sieht, und die grösste davon.
export function stand(eintraege) {
  const ids = new Set(eintraege.map((e) => e.id));
  return { ids, maxId: ids.size ? Math.max(...ids) : 0 };
}

// Neue Belege seit der Momentaufnahme: in einem Eingangsbereich, vorher nicht sichtbar und jünger
// (grössere ID) als alles, was vorher sichtbar war. So zählt ein älterer Beleg, der zufällig in den
// Pool zurückgelegt wird, nicht als neuer Eingang. Aufsteigend nach ID.
// @returns {{ id:number, bereich:string }[]}
export function neueBelege(vorher, eintraege) {
  const neu = new Map();
  for (const e of eintraege) {
    if (!EINGANGS_BEREICHE.includes(e.bereich)) continue;
    if (vorher.ids.has(e.id) || e.id <= vorher.maxId) continue;
    if (!neu.has(e.id)) neu.set(e.id, e);
  }
  return [...neu.values()].sort((a, b) => a.id - b.id);
}

// Fehlermeldungen einer Formularseite (views/_fehler_liste.ejs) oder der Fehlerseite (views/error.ejs).
export function fehlerMeldungen(html) {
  const text = String(html ?? '');
  const meldungen = [];
  const liste = /<div class="alert alert-danger" role="alert">\s*<strong>Bitte korrigieren:<\/strong>([\s\S]*?)<\/ul>/.exec(text);
  if (liste) {
    for (const li of liste[1].matchAll(/<li>([\s\S]*?)<\/li>/g)) meldungen.push(ohneTags(li[1]));
  }
  for (const p of text.matchAll(/<p class="alert alert-(?:danger|warning)">([\s\S]*?)<\/p>/g)) meldungen.push(ohneTags(p[1]));
  return meldungen.filter(Boolean);
}

// Titel der Befunde im Prüf-Popup (views/_auffaelligkeiten_modal.ejs); leer ohne Popup.
export function auffaelligkeitenTitel(html) {
  const modal = /id="auffaelligkeiten-modal"[\s\S]*?<ul class="list-unstyled">([\s\S]*?)<\/ul>/.exec(String(html ?? ''));
  if (!modal) return [];
  return [...modal[1].matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) => ohneTags(m[1])).filter(Boolean);
}

// Status je Beleg auf «Abgeschlossene Rechnungen» (/meine-abgeschlossenen), aus Tabelle oder Kacheln.
// @returns {Map<number,string>} z. B. 12 → 'abgeschlossen' | 'abgeholt' | 'archiviert'
export function abgeschlossenStatus(html) {
  const text = String(html ?? '');
  const status = new Map();
  for (const m of text.matchAll(/<tr id="abgeschlossen-row-(\d+)">\s*<td>[\s\S]*?<\/td>\s*<td>([^<]*)<\/td>/g)) {
    status.set(Number(m[1]), entschluesseln(m[2]).trim());
  }
  for (const m of text.matchAll(/id="abgeschlossen-kachel-(\d+)">[\s\S]*?<dt>Status<\/dt><dd><span[^>]*>([^<]*)<\/span>/g)) {
    if (!status.has(Number(m[1]))) status.set(Number(m[1]), entschluesseln(m[2]).trim());
  }
  return status;
}

// Anzahl Seiten der Liste «Abgeschlossene Rechnungen» (Blätterleiste), mindestens 1.
export function seitenAnzahl(html) {
  const m = /Seite \d+ von (\d+)/.exec(String(html ?? ''));
  return m ? Math.max(1, Number(m[1])) : 1;
}

// Exportstand eines freigegebenen Belegs.
// - abgeholt: der Status ist nicht mehr «abgeschlossen» (n8n hat die Abholung oder die Archivierung bestätigt,
//   src/routes/n8n/jobs.js setzt dann «abgeholt»). Ein blosser Abholversuch (GET /abholbereit) ist von aussen
//   nicht sichtbar.
// - archivBestaetigt: abgeholt und nicht mehr in GET /api/n8n/jobs/archivierung-ausstehend (null = nicht abgefragt).
// @param {string|undefined} status Status aus «Abgeschlossene Rechnungen»
// @param {Set<number>|null} ausstehend IDs ohne Archivquittung, null ohne API-Abfrage
export function exportStufe(id, status, ausstehend = null) {
  const abgeholt = status === 'abgeholt' || status === 'archiviert';
  const archivBestaetigt = ausstehend === null ? null : abgeholt && !ausstehend.has(id);
  return { abgeholt, archivBestaetigt };
}

// Versandquittung(en) für Bexio auf der Belegseite /zeitstempel-pruefen?jobId= (views/zeitstempel-pruefen.ejs, Block #bexio-versand).
// @returns {null|{zeitpunkt:string, empfaenger:string, messageId:string}[]}
//   null = kein Bexio-Block (Rapport, nicht abgeschlossen, keine Seite); [] = «noch nicht gemeldet»; sonst je Quittung ein Eintrag.
export function bexioVersandAusSeite(html) {
  const block = /<div id="bexio-versand"[^>]*>([\s\S]*?)<\/div>/.exec(String(html ?? ''));
  if (!block) return null;
  const eintraege = [];
  for (const m of block[1].matchAll(/<p class="mb-0">An Bexio gesendet: ([\s\S]*?), an ([\s\S]*?), Message-ID <span[^>]*>([\s\S]*?)<\/span><\/p>/g)) {
    eintraege.push({ zeitpunkt: ohneTags(m[1]), empfaenger: ohneTags(m[2]), messageId: ohneTags(m[3]) });
  }
  return eintraege;
}
