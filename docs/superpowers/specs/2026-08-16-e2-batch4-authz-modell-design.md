# Sub-Phase E2, Batch 4 – Autorisierungsmodell-Entscheidung — Design

## Kontext & Phasenplan

Dies ist der vierte und letzte Teil der Sub-Phase E2 (Security-Review-Pass),
nach Batch 1 (gebündelte Einzelfixes, gemerged), Batch 2 (PDF-Bereinigung,
gemerged) und Batch 3 (ChurchTools-Sync-Robustheit, gemerged). Nach diesem
Batch geht Phase E in E3 über (Infomaniak-Deployment).

- **AUTHZ-3** (Audit-Finding, Important): `/kontierung`, `/freigabe2` und
  `/abgelehnt` sind alle an ChurchTools-Gruppenmitgliedschaft
  ("Buchhaltung", inzwischen für die ersten beiden auch "Portal-Admin")
  gekoppelt. Freigeber 1/2 und ihre Stellvertreter sind aber
  account-basierte Rollen — das Konto-Formular im Admin-Bereich befüllt die
  vier Personen-Dropdowns aus jeder aktiven Person, unabhängig von deren
  Gruppenzugehörigkeit. Ein Admin kann gültig eine Person zuweisen, die
  nicht in Buchhaltung ist; diese Person bekommt dann einen dauerhaften 403
  und wird vom nächtlichen Sync irgendwann sogar ganz deaktiviert (da sie in
  keiner der beiden relevanten Gruppen steckt). Die Rechnung wird
  dauerhaft nicht freigebbar, ohne Admin-Weg, das zu beheben.
- Während der Analyse dieses Batches wurde ein direkt verwandter, bisher
  unentdeckter Bug in `/abgelehnt` gefunden: SYNC-8s Eskalations-Flag
  (`freigabe1_eskaliert_an_admin`, aus Batch 3) wurde in `kontierung.js` und
  `freigabe2.js` berücksichtigt, aber nie in `ablehnung.js` — dem dritten der
  drei in AUTHZ-3 genannten Routen. Dieser Batch schliesst beide Lücken in
  einem Zug, weil sie dieselben drei Routen betreffen und derselbe
  Autorisierungs-Umbau beide Fixes trägt.

## AUTHZ-3 — Gruppen-Gate entfernen

Die Entscheidung (siehe Audit-Text): entweder das Gruppen-Gate auf diesen
drei Mounts fallen lassen und sich auf die bereits vorhandenen joblokalen
Zuweisungsprüfungen verlassen, oder beim Konto-Speichern hart validieren,
dass alle vier zugewiesenen Personen Buchhaltungsmitglieder sind. Dieser
Batch wählt die erste Option — sie passt zum Lastenheft-Modell
account-basierter Freigeber (Abschnitt 3: `freigeber1_id`, `freigeber2_id`,
`stellvertreter1_id`, `stellvertreter2_id` sind Personen-IDs, keine
Gruppenmitgliedschaften) und ist die vom Audit selbst empfohlene Richtung.

`src/middleware/roles.js` erhält eine neue Funktion `requireLogin()`: prüft
ausschliesslich "Session vorhanden und Person aktiv" (identischer erster
Block wie in `requireRole`/`requireAnyRole`, aber ohne den anschliessenden
Gruppen-Check). `src/app.js`s Mounts für `/kontierung`, `/freigabe2` und
`/abgelehnt` wechseln von `requireAnyRole(config, [...])` bzw.
`requireRole(config, 'buchhaltung')` auf `requireLogin()`.

Die joblokalen Prüfungen (`loadAuthorizedJob` in `kontierung.js`/
`ablehnung.js`, `loadAuthorized` in `freigabe2.js`) ändern sich inhaltlich
nicht — sie haben nie auf das Gruppen-Gate zurückgegriffen, sondern immer
exakt auf `job.zugewiesen_an`/die effektive Freigeber-2-ID (bzw. das
Admin-Eskalations-Flag) verglichen. Das Entfernen des Mount-Gates ändert
nur, wer überhaupt bis zu dieser Prüfung vordringt — nicht, was sie
entscheidet.

`/pool` und `/api/pool` bleiben unverändert bei
`requireAnyRole(config, ['buchhaltung', 'portal-admin'])` bzw.
`requireRole(config, 'buchhaltung')` — das Lastenheft verlangt explizit
(Abschnitt 4, Schritt 4), dass der offene Pool nur für
Buchhaltungsmitglieder sichtbar ist. Das ist ein Browse-viele-Zugriff auf
eine geteilte Warteschlange, kein Handle-einen-zugewiesenen-Job-Zugriff —
strukturell ein anderer Fall, den AUTHZ-3 nicht meint.

## Zweiter Fund während Task 2 — Login und Sync gaten ebenfalls auf Buchhaltung/Admin

Task 2s eigener neuer Integrationstest deckte auf, dass das Entfernen des
Routen-Gates allein AUTHZ-3s Deadlock nicht auflöst: `src/routes/auth.js`s
`/callback` verweigert die Session-Erstellung komplett (`403`, kein
`upsertPerson`-Aufruf), wenn `resolveMemberGroupIds` für die Person keine
Mitgliedschaft in `groupIdBuchhaltung`/`groupIdAdmin` findet.
`src/services/sync.js`s `runPersonenSync` zieht Personen über exakt dieselben
zwei Kandidaten-Gruppen. Da FK-Constraints eine existierende
`personen`-Zeile voraussetzen und `admin/konten.js`s Freigeber-Dropdown aus
`listActivePersons(db)` gespeist wird, kann eine Person ausserhalb dieser
beiden Gruppen heute weder sich einloggen noch je in einem
Konto-Formular auswählbar werden — der von AUTHZ-3 beschriebene Deadlock
tritt bereits eine Ebene früher ein, nicht erst am Routen-Gate.

**AUTH-WIDEN-1 — Login gated nicht mehr auf Gruppenmitgliedschaft.**
`src/routes/auth.js`s `/callback`: der Block
`if (gruppen.length === 0) { return res.status(403)... }` entfällt ersatzlos.
Jede erfolgreich authentifizierte ChurchTools-Identität bekommt eine lokale
Session und eine `personen`-Zeile. `gruppen` wird weiterhin exakt wie bisher
berechnet (Mitgliedschaft in `groupIdBuchhaltung`/`groupIdAdmin` — dieser
Wert bleibt die Grundlage für `requireRole`/`requireAnyRole` an anderer
Stelle), nur die Ablehnung bei leerem Array entfällt.

**SYNC-WIDEN-1 — Der nächtliche Sync hält auch Konto-referenzierte Personen
aktiv.** Ohne diese zweite Änderung würde AUTH-WIDEN-1 nichts dauerhaft
bewirken: eine Person, die sich einmalig einloggt, aber in keiner der beiden
Gruppen ist, würde vom nächsten nächtlichen Sync-Lauf sofort wieder
deaktiviert (`runPersonenSync`s `relevantIds` kennt bisher nur
Gruppenmitglieder). `src/services/sync.js`s `personIdToGroups`-Aufbau
erweitert sich um jede Person, die auf einem **aktiven** Konto als
`freigeber1_id`/`stellvertreter1_id`/`freigeber2_id`/`stellvertreter2_id`
eingetragen ist — über eine neue Funktion `listKontoReferencedPersonIds(db)`
in `kontenRepo.js`. Ihre tatsächliche Gruppenmitgliedschaft (falls vorhanden)
wird weiterhin normal aufgelöst und gespeichert; sie werden nur nicht mehr
allein deswegen deaktiviert, weil sie keiner der beiden Gruppen angehören.

**Veränderte Widerrufs-Semantik (aus dem finalen Review):** da `upsertPerson`
`aktiv` bedingungslos auf `1` setzt, hält SYNC-WIDEN-1 eine Konto-referenzierte
Person nicht nur vor Deaktivierung geschützt, sondern reaktiviert sie sogar
aktiv bei jedem Lauf. Zwei praktische Folgen, beide kein Sicherheitsproblem
(Login verlangt weiterhin ein erfolgreiches ChurchTools-OAuth, und es gibt
keine manuelle Deaktivierungs-UI, die dadurch stillschweigend überschrieben
würde — `admin/personen.js` ist rein lesend), aber ein verändertes
Betriebsverhalten: (1) eine Person aus Buchhaltung/Admin in ChurchTools zu
entfernen deaktiviert sie nicht mehr automatisch, solange sie noch auf einem
aktiven Konto referenziert ist — ein Admin muss zusätzlich das Konto
anpassen; (2) eine in ChurchTools gelöschte Person, die noch auf einem
aktiven Konto steht, bleibt jetzt dauerhaft `aktiv = 1` (mit
`ct_person_unresolved = 1`), statt wie bisher innerhalb eines Tages
deaktiviert zu werden.

**Bewusst nicht gelöst:** eine Person, die **noch nie** eingeloggt war und
**nicht** in Buchhaltung/Admin ist, kann heute (und auch nach diesem Fix)
nicht direkt in einem neuen Konto als Freigeber ausgewählt werden — das
Konto-Formular befüllt sein Dropdown aus `listActivePersons(db)`, und die
FK-Constraint verlangt eine bereits existierende `personen`-Zeile. Diese
Person muss sich einmalig einloggen (wodurch AUTH-WIDEN-1 ihre Zeile
anlegt), bevor ein Admin sie zuweisen kann. Das ist ein einmaliger
operativer Schritt, kein Deadlock mehr — und bewusst ausserhalb des Scopes
dieses Batches, eine Selbstauskunft/Vorab-Erfassung neuer Personen ohne
Login würde eine eigene Design-Entscheidung erfordern.

## Verwandter Fund — `/abgelehnt` kennt das Eskalations-Flag nicht

**Korrektur gegenüber der ursprünglichen Analyse:** die erste Fassung dieses
Abschnitts ging davon aus, `freigabe1_eskaliert_an_admin` bliebe bis
`/abgelehnt` gesetzt. Tatsächlich löscht `abschliessenFreigabe1`
(`jobsRepo.js`, aus Batch 3) das Flag bereits, sobald Freigabe 1
abgeschlossen wird — auch wenn ein Admin sie über die Eskalations-Verzweigung
abgeschlossen hat. Der Job erreicht `/abgelehnt` danach also bereits mit
Flag `0`: eine reine Flag-Prüfung in `ablehnung.js` würde nie greifen. Das
eigentliche Problem liegt tiefer — siehe Fix 0.

Vier koordinierte Fixes, drei davon nach bereits in Batch 3 etablierten
Mustern:

**0. `jobsRepo.js`s `abschliessenFreigabe1` löscht
`freigabe1_eskaliert_an_admin` nicht mehr.** Aktuell:

```javascript
export function abschliessenFreigabe1(db, jobId) {
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0 WHERE id = ?"
  ).run(jobId);
}
```

Der erklärte Interessenskonflikt von Stellvertreter 1 betrifft die konkrete
Rechnung, nicht den einzelnen Kontierungs-Versuch — er ist mit einer
erfolgreichen Freigabe 1 nicht automatisch erledigt. Lehnt Freigabe 2 die
Rechnung später aus einem völlig anderen Grund ab (z. B. falsches Konto) und
wird sie über `wiederOeffnenJob` erneut geöffnet, muss der Ausschluss
bestehen bleiben — exakt das gleiche Prinzip, das Batch 3 bereits für
`freigabe2_eskaliert_von` anwendet ("die Eskalation bleibt bestehen, weil der
Konflikt real bleibt"). Die Zeile wird zu:

```javascript
export function abschliessenFreigabe1(db, jobId) {
  // freigabe1_eskaliert_an_admin wird hier bewusst NICHT zurückgesetzt: der
  // erklärte Interessenskonflikt gilt für die Rechnung, nicht für den
  // einzelnen Kontierungsversuch, und muss eine spätere Ablehnung + erneutes
  // Öffnen überleben (gleiches Prinzip wie freigabe2_eskaliert_von). Wird nur
  // bei einem echten Voll-Reset in den Pool gelöscht (releaseJob,
  // forceReleaseJob) — dort beginnt der Job faktisch neu, ggf. sogar mit
  // einem anderen Konto.
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL WHERE id = ?"
  ).run(jobId);
}
```

`releaseJob`/`forceReleaseJob` bleiben unverändert — sie löschen das Flag
weiterhin bei einem vollständigen Reset in den Pool, was korrekt bleibt: dort
beginnt der Job faktisch neu, ggf. sogar mit einem komplett anderen Konto,
für das der ursprüngliche Konflikt gar nicht mehr gilt.

**1. `ablehnung.js`s `loadAuthorizedJob` wird flag-bewusst.** Bekommt
dieselbe `isPortalAdmin(person)`-Hilfsfunktion wie `kontierung.js` und
`freigabe2.js` (Konstruktion identisch: prüft
`config.churchtools.groupIdAdmin`-Mitgliedschaft). Die Autorisierung wird zur
selben Ternary-Form:

```javascript
const authorized = job.freigabe1_eskaliert_an_admin
  ? isPortalAdmin(req.currentPerson)
  : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
```

`createAblehnungRouter` nimmt neu `{ db, config }` statt nur `{ db }` entgegen
(analog zu `createKontierungRouter`); der Aufruf in `app.js` wird entsprechend
angepasst.

Nur `freigabe1_eskaliert_an_admin` ist hier relevant, nicht
`freigabe2_eskaliert_an_admin` — wer die Rechnung kontiert/überarbeitet, wird
beim Eintritt in Kontierung/Freigabe 1 festgelegt, nicht bei Freigabe 2.

**2. `ablehnung.js`s `POST /:id/ueberarbeiten` behebt denselben Bug wie
Batch 3s Task 7.** Der bestehende Aufruf
`wiederOeffnenJob(db, job.id, req.currentPerson.churchtools_person_id)`
würde für einen über das Flag autorisierten Admin niemals treffen — dessen
eigene ID stimmt nie mit `job.zugewiesen_an` überein (das bleibt die ID der
ursprünglich zugewiesenen, jetzt ausgeschlossenen Person).
`wiederOeffnenJob`s WHERE-Klausel (`WHERE id = ? AND zugewiesen_an = ? AND
status = 'abgelehnt'`) würde daher für den Admin still ins Leere laufen und
den bestehenden 409-Pfad ("wurde inzwischen bereits von einem anderen
Vorgang bearbeitet") fälschlich auslösen. Fix: `job.zugewiesen_an` statt
`req.currentPerson.churchtools_person_id` übergeben — identisch zur bereits
gemergten Korrektur in `kontierung.js`s `zurueck-in-pool`-Route, aus
demselben Grund.

**3. Die Ablehnungs-Benachrichtigung und die eigene Jobliste route(t)n
korrekt.** `freigabe2.js`s Ablehnungs-Mailversand (aktuell: E-Mail immer an
`getPersonById(db, job.zugewiesen_an)`) verzweigt:

```javascript
if (job.freigabe1_eskaliert_an_admin) {
  const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
  for (const email of empfaenger) {
    await sendNotification(db, mailer, {
      to: email,
      subject: 'Freigabeportal: Rechnung abgelehnt (an Portal-Admin eskaliert)',
      text: `Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
      typ: 'ablehnung',
      jobId: job.id,
    });
  }
} else {
  const besitzer = getPersonById(db, job.zugewiesen_an);
  if (besitzer) {
    await sendNotification(db, mailer, { /* unverändert */ });
  }
}
```

Direkter Link zu `/abgelehnt/<id>` statt generischem `/pool` — gleiches
Muster wie Batch 3s Critical-Fix für die anderen beiden Eskalations-Mails.

`jobsRepo.js`s `listAbgelehntJobsForPerson` bekommt den Filter
`AND freigabe1_eskaliert_an_admin = 0` (gleiches Muster wie
`listZugewiesenJobsForPerson`/`listFreigabe2JobsForPerson` aus Batch 3s
Fix-Welle) — die ausgeschlossene Person sieht den Job dann auch auf der
eigenen Pool-Seite nicht mehr unter "meine abgelehnten Rechnungen".

Wie in Batch 3 bleibt volle `/pool`-Listen-Integration für Admins (ein
Admin entdeckt einen eskalierten, abgelehnten Job nur über die E-Mail, nicht
über eine eigene Liste im Portal) bewusst ausserhalb des Scopes — konsistent
mit der dort bereits getroffenen Abgrenzung.

## Datenmodell

Keine Schemaänderungen. Keine neuen `admin_config`-Schlüssel. Rein
strukturelle Änderungen an Middleware-Verkabelung und Routen-Logik.

## Tests

- **Unit**: `requireLogin()` (lässt aktive Session durch, blockiert fehlende
  Session und inaktive Person, unabhängig von Gruppenmitgliedschaft);
  `abschliessenFreigabe1` lässt `freigabe1_eskaliert_an_admin` unverändert
  gesetzt, wenn es vor dem Aufruf `1` war (Mutationstest: die alte Zeile
  `freigabe1_eskaliert_an_admin = 0` versehentlich wieder einzufügen muss
  genau diesen Test brechen); `listAbgelehntJobsForPerson`s neuer
  Flag-Filter; `listKontoReferencedPersonIds` (findet alle vier Rollen über
  mehrere Konten, ignoriert deaktivierte Konten, dedupliziert eine Person,
  die auf mehreren Konten/Rollen referenziert ist).
- **Integration (Login/Sync)**: `POST /auth/callback` erstellt eine Session
  auch für eine Person mit leerem `gruppen`-Array (kein 403 mehr); die
  bestehenden Tests, dass eine gruppenlose Person auf der Startseite keinen
  `/pool`-Link sieht, bleiben unverändert grün (Autorisierung ändert sich
  nicht, nur die Fähigkeit, sich überhaupt einzuloggen).
  `POST /internal/cron/sync-personen` deaktiviert eine zuvor aktive, auf
  einem aktiven Konto referenzierte Person **nicht**, obwohl ChurchTools sie
  in keiner der beiden Kandidaten-Gruppen zurückgibt; dieselbe Person auf
  einem **deaktivierten** Konto wird weiterhin ganz normal deaktiviert,
  wenn sie aus keiner Gruppe mehr kommt.
- **Integration**: `/kontierung`, `/freigabe2`, `/abgelehnt` bleiben für eine
  Person ohne jede Gruppenmitgliedschaft erreichbar, solange die joblokale
  Prüfung zutrifft (ersetzt/ergänzt die bisherigen rollenbasierten Zugriffs-
  Tests in `kontierung.test.js`/`freigabe2.test.js`/`ablehnung.test.js`);
  eine fremde Person (weder zugewiesen noch Portal-Admin) bleibt weiterhin
  mit 403 abgewiesen; `/abgelehnt` mit gesetztem
  `freigabe1_eskaliert_an_admin`-Flag: die ausgeschlossene Person bekommt
  403, ein Portal-Admin (unabhängig von Buchhaltungs-Mitgliedschaft) kann
  den Job sehen und über `/ueberarbeiten` erfolgreich wieder öffnen; die
  Ablehnungs-Mail geht bei gesetztem Flag an die Admin-Gruppe mit Link zu
  `/abgelehnt/<id>`, sonst unverändert an den Besitzer.
- **Ende-zu-Ende**: ein durchgängiges Szenario über echte Routen: Anlage →
  Zuweisung → Freigabe-1-Eskalation an Admin (Batch 3s Mechanismus) → Admin
  kontiert und gibt frei → Freigabe 2 lehnt ab → Admin (nicht die
  ursprünglich zugewiesene, ausgeschlossene Person) erhält die
  Ablehnungs-Mail, sieht den Job unter `/abgelehnt/<id>` und öffnet ihn
  erfolgreich zur Überarbeitung wieder.

## Nicht Teil von diesem Batch

Keine Validierung beim Konto-Speichern, dass zugewiesene Personen
Buchhaltungsmitglieder sind (das ist die verworfene Alternative zu AUTHZ-3s
gewählter Lösung). Keine volle `/pool`-Listen-Integration für admin-
eskalierte, abgelehnte Jobs (E-Mail-Link bleibt der einzige Entdeckungsweg,
wie in Batch 3 für die anderen beiden Eskalationsstufen entschieden). Keine
Änderung an `freigabe2_eskaliert_an_admin`s Verhalten — dieser Batch betrifft
ausschliesslich die Kontierungs-/Freigabe-1-Eskalation, weil nur diese die
"wer überarbeitet einen abgelehnten Job"-Frage berührt. AUTHZ-4 (Audit-Minor,
`wiederOeffnenJob`s Rückgabewert wurde verworfen) ist bereits vor diesem
Batch behoben (`ablehnung.js` prüft den Rückgabewert bereits und rendert bei
`false` einen 409) — keine weitere Arbeit nötig. Keine Selbstauskunft/
Vorab-Erfassung für eine Person, die noch nie eingeloggt war und nicht in
Buchhaltung/Admin ist — sie muss sich einmal einloggen, bevor ein Admin sie
einem Konto zuweisen kann (siehe "Bewusst nicht gelöst" oben). Kein
Sync-Pull über die ganze ChurchTools-Personendatenbank hinweg —
`listKontoReferencedPersonIds` bleibt auf tatsächlich referenzierte
Personen beschränkt, keine offene Erweiterung der Kandidaten-Gruppen.
