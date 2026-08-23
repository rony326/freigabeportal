# Mehrstufige Rechteverwaltung — Design

## Kontext

Das heutige Rollenmodell ist binär und rein aus ChurchTools-Gruppen-
mitgliedschaft abgeleitet (`src/middleware/roles.js`): eine Person ist
`buchhaltung` und/oder `portal-admin`, je nachdem ob ihre `personen.gruppen`-
Spalte die konfigurierte ChurchTools-Gruppen-ID enthält
(`CT_GROUP_ID_BUCHHALTUNG`/`CT_GROUP_ID_ADMIN`, `src/config/env.js:39-40`). Es
gibt keine Rollen-Spalte, keine In-App-Rollenverwaltung — die Mitgliedschaft
wird bei jedem Request live nachgeschlagen (`personHasRole`,
`src/middleware/roles.js:27-31`). Der komplette `/admin`-Bereich hängt an
einem einzigen Mount-Level-Gate (`src/app.js:92`):
`app.use('/admin', sessionLimiter, requireRole(config, 'portal-admin'))`.

Ziel dieses Designs: eine dritte Stufe **Manager** zwischen normalem Benutzer
und Admin einziehen, den heutigen Admin zu **Superadmin** machen (reine
Umbenennung, keine Funktionsänderung), und Managern Zugriff auf die
meisten, aber nicht alle Admin-Bereiche geben. Zusätzlich soll es möglich
sein, einzelnen Personen (unabhängig von ihrer Rolle) gezielt einzelne
Admin-Rechte zu geben, ohne sie zum vollen Manager zu machen.

## Rollenmodell

Drei Stufen plus additive Einzelrechte:

- **`superadmin`** — die heutige `portal-admin`-ChurchTools-Gruppe, nur
  umbenannt. Die zugrundeliegende Env-Var bleibt bewusst
  `CT_GROUP_ID_ADMIN` (siehe „Nicht Teil von diesem Design"), nur der
  interne Rollen-Bezeichner wechselt von `'portal-admin'` zu
  `'superadmin'`.
- **`manager`** — neue ChurchTools-Gruppe, neue Env-Var
  `CT_GROUP_ID_MANAGER`. Mitgliedschaft wird exakt nach demselben Muster
  wie heute live aus `personen.gruppen` abgeleitet — keine
  In-App-Rollenzuweisung, keine Abweichung vom bestehenden Modell.
  Manager bekommen automatisch ein festes Bundle an Rechten (siehe
  Berechtigungs-Katalog), aber **nicht** die drei hart gesperrten
  Basis-Bereiche.
- **Einzelrechte** — zusätzlich, unabhängig von der Rolle: eine Person
  (egal ob `benutzer`, `buchhaltung` oder `manager`) kann gezielt
  einzelne der vergebbaren Rechte bekommen, z. B. um einer
  Buchhaltungs-Person nur „Debitoren verwalten" zu geben, ohne sie zum
  vollen Manager zu machen. Diese Rechte sind **additiv** — sie können
  nur zusätzliche Rechte geben, nie ein Manager-Bundle-Recht wieder
  entziehen. Vergabe ist ausschliesslich Superadmin vorbehalten (siehe
  Berechtigungs-Katalog, hart gesperrte Bereiche).

Die bestehende `buchhaltung`-Rolle bleibt komplett unverändert — sie ist
eine orthogonale Achse (Freigabe-Workflow), keine Admin-Stufe, und wird von
diesem Design nicht berührt.

## Berechtigungs-Katalog

**Vergebbar** (Standard-Bundle für `manager`, oder einzeln zuweisbar über
`person_berechtigungen`):

| Berechtigung | Admin-Bereich |
|---|---|
| `konten_verwalten` | `/admin/konten` |
| `debitoren_verwalten` | `/admin/debitoren` |
| `geplante_jobs_verwalten` | `/admin/geplante-jobs` |
| `abgelehnt_verwalten` | `/admin/abgelehnt` |
| `mails_einsehen` | `/admin/mails` |
| `sync_einsehen` | `/admin/sync` |

**Hart gesperrt** (nur `superadmin`, im Code fest verdrahtet — kein Flag,
keine Ausnahme, nicht in `person_berechtigungen` einfügbar):

- `/admin/eskalation` (Eskalationszeiten, Empfänger, IBAN-Abweichungs-
  Empfänger)
- `/admin/erscheinungsbild` (Branding, Farben, Logo, Theme-Standard)
- `/admin/zeitstempel` (RFC3161-TSA-Konfiguration)
- Bearbeiten der Einzelrechte auf `/admin/personen` (siehe UI-Änderungen)

`/admin/personen` selbst (die Liste) bleibt für `superadmin` **und**
`manager` sichtbar (niedrige Sensitivität, reine Übersicht) — ist aber
kein eigenes vergebbares Recht, sondern an die Rolle gekoppelt, analog zu
den drei hart gesperrten Bereichen. Eine Person mit nur einem Einzelrecht
(aber ohne Manager-Rolle) sieht `/admin/personen` nicht.

`/admin` (Dashboard mit Zeitstempel-Überfällig-Banner) ist für jeden
erreichbar, der überhaupt Zugriff auf den Admin-Bereich hat (Superadmin,
Manager, oder Inhaber mindestens eines Einzelrechts) — keine eigene
Berechtigung nötig, die Banner-Information ist nicht sensitiv.

## Datenmodell

Neue Tabelle, additiv, keine Änderung an bestehenden Spalten:

```sql
CREATE TABLE IF NOT EXISTS person_berechtigungen (
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  berechtigung TEXT NOT NULL CHECK (berechtigung IN (
    'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
    'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen'
  )),
  PRIMARY KEY (person_id, berechtigung)
);
```

Der `CHECK`-Constraint listet ausschliesslich die sechs vergebbaren Rechte
— die drei hart gesperrten Bereiche und die Rechtevergabe selbst können
strukturell gar nicht in diese Tabelle eingefügt werden, unabhängig von
der Anwendungslogik. Da es eine neue Tabelle ist, reicht ein normales
`CREATE TABLE IF NOT EXISTS` in `schema.sql` — die aufwendigere
Rename-Rebuild-Migration (wie bei `jobs`/`freigaben`/`mail_log`/
`cron_log` in `src/db/index.js`) ist hier nicht nötig, da nichts
Bestehendes verändert wird.

`src/db/personBerechtigungenRepo.js` (neu):

```javascript
export function listBerechtigungenForPerson(db, personId) { /* -> string[] */ }
export function setBerechtigungenForPerson(db, personId, berechtigungen) {
  // ersetzt die komplette Menge in einer Transaktion (DELETE + INSERT),
  // analog zu anderen "ganze Menge ersetzen"-Stellen im Repo-Layer
}
export function personHasBerechtigung(db, personId, berechtigung) { /* -> boolean */ }
```

`src/config/env.js` bekommt `groupIdManager`. Anders als
`groupIdBuchhaltung`/`groupIdAdmin` ist sie **nicht** über `required()`
erzwungen, sondern optional (`env.CT_GROUP_ID_MANAGER || null`) — bestehende
Deployments ohne konfigurierte Manager-Gruppe sollen weiterlaufen, ohne
sofort eine neue ChurchTools-Gruppe anlegen zu müssen. `personHasRole`
(`src/middleware/roles.js`) bekommt dafür einen Guard: `if (!groupId)
return false;`, bevor der `includes`-Check läuft — verhindert einen
Vergleich gegen den String `"null"`.

## Middleware

`src/middleware/roles.js`:

```javascript
const GROUP_ID_KEY_BY_ROLE = {
  buchhaltung: 'groupIdBuchhaltung',
  superadmin: 'groupIdAdmin',   // umbenannt von 'portal-admin'
  manager: 'groupIdManager',    // neu
};
```

Alle bestehenden Aufrufstellen mit dem String `'portal-admin'` wechseln
mechanisch auf `'superadmin'` (sechs Fundstellen: `src/app.js:92`,
`src/routes/poolPage.js:34-35`, `src/middleware/nav.js:6`,
`src/services/jobAuthorization.js:10`, plus die Definition selbst). Aus
Konsistenzgründen werden im selben Zug die drei route-lokalen
`isPortalAdmin(person)`-Hilfsfunktionen (`kontierung.js:73`,
`freigabe2.js:18`, `ablehnung.js:10` — inhaltlich identisch,
`config.churchtools.groupIdAdmin`-Check für die Eskalations-Autorisierung)
zu `isSuperadmin(person)` umbenannt, und `poolPage.js`s lokale Variable
`istPortalAdmin` zu `istSuperadmin`. Rein kosmetisch, keine
Verhaltensänderung — dient nur dazu, nicht zwei Generationen von
Terminologie nebeneinander stehen zu lassen, sobald „Manager" als Begriff
dazukommt.

Neue Datei `src/middleware/permissions.js`:

```javascript
export function personHasPermission(db, config, person, permission) {
  if (!person) return false;
  if (personHasRole(person, config, 'superadmin')) return true;
  if (personHasRole(person, config, 'manager')) return true; // volles Bundle
  return personHasBerechtigung(db, person.churchtools_person_id, permission);
}

export function requirePermission(db, config, permission) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!personHasPermission(db, config, person, permission)) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

export function requireAdminAreaAccess(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    const hatZugriff =
      personHasRole(person, config, 'superadmin') ||
      personHasRole(person, config, 'manager') ||
      listBerechtigungenForPerson(db, person.churchtools_person_id).length > 0;
    if (!hatZugriff) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}
```

`src/middleware/nav.js`s `loadNavFlags` erweitert sich um `isSuperadmin`
(umbenannt von `isPortalAdmin`), `isManager`, und ein `adminNav`-Objekt mit
einem Boolean pro Admin-Nav-Eintrag (`konten`, `debitoren`, `eskalation`,
`erscheinungsbild`, `zeitstempel`, `personen`, `mails`, `sync`,
`geplanteJobs`, `abgelehnt`), berechnet über `personHasPermission`/
`personHasRole` — dient der Nav-Filterung (siehe UI-Änderungen).

## Routing (`src/app.js`)

Mount-Level-Gate wechselt von `requireRole(config, 'portal-admin')` auf
`requireAdminAreaAccess(db, config)`. Jeder einzelne Admin-Router bekommt
sein eigenes Gate direkt davor:

```javascript
app.use('/admin', sessionLimiter, requireAdminAreaAccess(db, config));
app.get('/admin', ...); // unverändert, keine zusätzliche Permission nötig

app.use('/admin/konten', requirePermission(db, config, 'konten_verwalten'), createKontenRouter({ db }));
app.use('/admin/debitoren', requirePermission(db, config, 'debitoren_verwalten'), createDebitorenRouter({ db }));
app.use('/admin/eskalation', requireRole(config, 'superadmin'), createEskalationRouter({ db }));
app.use('/admin/erscheinungsbild', requireRole(config, 'superadmin'), createErscheinungsbildRouter({ db, config }));
app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db }));
app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config }));
app.use('/admin/mails', requirePermission(db, config, 'mails_einsehen'), createMailsRouter({ db, mailer }));
app.use('/admin/sync', requirePermission(db, config, 'sync_einsehen'), createSyncRouter({ db }));
app.use('/admin/abgelehnt', requirePermission(db, config, 'abgelehnt_verwalten'), createAdminAbgelehntRouter({ db }));
app.use('/admin/geplante-jobs', requirePermission(db, config, 'geplante_jobs_verwalten'), createGeplanteJobsRouter({ db, config, mailer }));
```

Die einzelnen Router-Dateien selbst (`admin/konten.js`,
`admin/debitoren.js`, usw.) bleiben unangetastet — das Gate sitzt
ausschliesslich am Mount-Punkt, exakt wie heute.

## UI-Änderungen

**`/admin/personen`** (`src/routes/admin/personen.js`,
`views/admin/personen-liste.ejs`): Router bekommt zusätzlich `config` und
eine neue `POST /:id/berechtigungen`-Route, hart gesperrt auf
`requireRole(config, 'superadmin')` — unabhängig vom übergeordneten
`requireAnyRole(['superadmin','manager'])`-Gate des Mounts, damit ein
Manager die Seite zwar sehen, aber nicht bearbeiten kann. Die Liste zeigt
pro Person zusätzlich:

- ein Rollen-Badge (`Superadmin`/`Manager`/`Benutzer`, rein lesend,
  berechnet aus `personHasRole`),
- sechs Checkboxen (eine pro vergebbarem Recht aus dem Katalog), die den
  Stand aus `person_berechtigungen` zeigen. Für Superadmin editierbar
  (POST beim Speichern), für Manager nur als reine Anzeige (kein
  `<form>`, `disabled`-Attribut).

Bei einer Person mit Rolle `manager` oder `superadmin` sind die
Checkboxen zusätzlich mit einem Hinweistext versehen
(„bereits über Rolle X enthalten"), da Einzelrechte bei diesen beiden
Rollen wirkungslos sind (das Bundle deckt bereits alles ab bzw.
Superadmin hat ohnehin alles) — verhindert Verwirrung, warum ein
gesetztes Häkchen keinen sichtbaren Unterschied macht.

**`views/admin/_nav.ejs`**: jeder `<li>` wird in ein
`<% if (adminNav.<key>) { %>`-Bedingung gewickelt, gespeist aus dem neuen
`res.locals.adminNav` (siehe Middleware-Abschnitt) — ein Manager oder
Einzelrechte-Inhaber sieht nur die Links, die er tatsächlich nutzen kann.

**`views/_header.ejs:46`** und **`views/pool.ejs:14,19`**:
`isPortalAdmin` → `isSuperadmin` (reine Umbenennung, siehe
Middleware-Abschnitt — Verhalten unverändert: die Pool-Zusatzsektion
bleibt Superadmin-exklusiv, Manager sind hier bewusst nicht
eingeschlossen, da diese Sektion mit dem Freigabe-Workflow zusammenhängt,
nicht mit dem `/admin`-Bereich).

## Konfiguration & Rollout

- `.env.example` bekommt eine neue, **auskommentierte** Zeile
  `# CT_GROUP_ID_MANAGER=` (optional, siehe Datenmodell-Abschnitt) direkt
  unter `CT_GROUP_ID_ADMIN`.
- `README.md`s Variablen-Tabelle (Zeile 70) und der
  „Portal-Admin-Bootstrap"-Abschnitt (Zeile 74-81) werden um einen Hinweis
  ergänzt: `CT_GROUP_ID_MANAGER` ist optional, ohne sie existiert die
  Manager-Stufe schlicht nicht (niemand ist Mitglied), alles verhält sich
  wie vor diesem Design. Der Bootstrap-Hinweis („Vor dem ersten Login
  muss die erste Person bereits in der Portal-Admin-Gruppe sein") bleibt
  inhaltlich unverändert, nur „Portal-Admin" → „Superadmin".
- `CT_GROUP_ID_ADMIN` selbst wird **nicht** umbenannt (siehe „Nicht Teil
  von diesem Design") — bestehende Deployments brauchen keine
  `.env`-Änderung, um weiterzulaufen.

## Tests

- **Unit** (`permissions.test.js`, neu): `personHasPermission` — Superadmin
  bekommt jedes vergebbare Recht ohne Eintrag in `person_berechtigungen`;
  Manager ebenso; eine Person ohne Rolle mit genau einem Eintrag bekommt
  nur dieses eine Recht, alle anderen bleiben `false`; ein hart gesperrter
  Bereich (`requireRole(config,'superadmin')`) lässt sich durch keinen
  Eintrag in `person_berechtigungen` umgehen, weil der `CHECK`-Constraint
  das Einfügen bereits verhindert (Migrationstest: `INSERT INTO
  person_berechtigungen (..., 'basis_einstellungen')` schlägt fehl).
  `requireAdminAreaAccess` lässt eine Person mit genau einem Einzelrecht
  durch, blockiert eine Person ganz ohne Rolle/Rechte mit 403.
- **Unit**: `personHasRole` mit `groupIdManager = null` (unkonfigurierte
  Env-Var) gibt für jede Person `false` zurück, statt gegen den String
  `"null"` zu vergleichen.
- **Integration**: `/admin/eskalation`, `/admin/erscheinungsbild`,
  `/admin/zeitstempel` liefern für einen Manager 403, für Superadmin 200.
  `/admin/konten`, `/admin/debitoren`, `/admin/mails`, `/admin/sync`,
  `/admin/abgelehnt`, `/admin/geplante-jobs` liefern für Manager 200 (Bundle),
  für eine rechtelose Person 403. Eine Buchhaltungs-Person mit nur dem
  Einzelrecht `debitoren_verwalten` erreicht `/admin/debitoren` (200), aber
  nicht `/admin/konten` (403).
- **Integration**: `POST /admin/personen/:id/berechtigungen` liefert für
  Manager 403, für Superadmin 200 und persistiert die neue Rechte-Menge
  (inkl. Entzug — ein zuvor gesetztes Recht abwählen löscht die Zeile).
  `GET /admin/personen` liefert für Manager 200 (mit deaktivierten
  Checkboxen im HTML), für eine Person mit nur einem Einzelrecht (ohne
  Manager-Rolle) 403.
- **Nav**: `views/admin/_nav.ejs` rendert für einen Manager keine Links zu
  den drei hart gesperrten Bereichen; für eine Person mit nur
  `mails_einsehen` erscheint ausschliesslich der Mail-Protokoll-Link.

## Nicht Teil von diesem Design

- **Kein Entzug von Manager-Bundle-Rechten pro Person.** Einzelrechte sind
  rein additiv (explizite Entscheidung, siehe Rollenmodell) — ein Manager
  hat immer das volle Bundle, es gibt keine Möglichkeit, ihm gezielt ein
  einzelnes Bundle-Recht wieder wegzunehmen, ohne ihn komplett aus der
  ChurchTools-Gruppe zu entfernen.
- **Keine In-App-Zuweisung von Manager/Superadmin.** Beide bleiben reine
  ChurchTools-Gruppenmitgliedschaft, exakt wie das heutige Modell — konsistent
  mit der expliziten Anforderung, das auf Gruppenebene zu konfigurieren.
  Nur die sechs granularen Einzelrechte werden in-app verwaltet.
- **Keine konsolidierte „Basis-Einstellungen"-Seite.** Die drei hart
  gesperrten Bereiche (Eskalationszeiten, Erscheinungsbild, Zeitstempel)
  bleiben als separate Seiten bestehen, bekommen nur identisches Gating —
  kein Zusammenlegen in eine gemeinsame Ansicht.
- **`CT_GROUP_ID_ADMIN` wird nicht umbenannt.** Reine Aufwand/Nutzen-
  Abwägung, um bestehende Deployments nicht zu einer `.env`-Änderung zu
  zwingen; kann bei Bedarf in einem späteren, eigenständigen Schritt
  nachgezogen werden.
- **Keine Erweiterung von `/api/pool`, `/pool`, `/kontierung`,
  `/freigabe2`, `/abgelehnt`, `/zeitstempel-pruefen` um die
  Manager-Rolle.** Diese Routen sind an `buchhaltung`/joblokale Prüfungen
  gekoppelt (AUTHZ-3, siehe
  `2026-08-16-e2-batch4-authz-modell-design.md`) und bleiben davon
  unberührt — dieses Design betrifft ausschliesslich den `/admin`-Bereich.
