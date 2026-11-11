# Gruppenrechte, Konten-Klassifizierung und Wartungsmodus – Design

Stand: 2026-11-11. Gehört zum Release nach v1.0.1 (zusammen mit
`2026-11-10-betrugserkennung-und-benachrichtigungen-design.md`). Drei unabhängige
Teilprojekte in einem Dokument; sie können einzeln geplant, umgesetzt und gemergt werden.
Empfohlene Reihenfolge: A (Gruppenrechte) → C (Wartungsmodus, braucht ein neues Recht aus A) →
B (Konten-Klassifizierung, unabhängig, klein).

## Hintergrund

Das Portal vergibt Rechte heute aus zwei Quellen: ChurchTools-Gruppen (Rollen `buchhaltung`,
`superadmin`, `manager`, über Gruppen-IDs aus der Config) und additive Einzelrechte pro Person
(`person_berechtigungen`). Was eine Rolle darf, steht fest im Code
(`src/middleware/permissions.js`: Superadmin darf alles, Manager alles ausser drei Rechten) und in
vielen harten `requireRole(config, 'superadmin')`-Gattern in `src/app.js`. Das ist zu starr.

---

## A. Rechte pro Gruppe

### Ziel
Der Superadmin stellt im Portal pro Gruppe ein, auf welche Punkte des Admin-Bereichs sie Zugriff
hat. Die festen Rollen-Bündel im Code entfallen. Beim User ist sichtbar, woher jedes Recht kommt.

### Anlass (Originalton)
Als IT-Admin (in Superadmin und Buchhaltung) soll der Auftraggeber Kreditoren bearbeiten können,
aber keine Vorgänge umhängen. Manager sollen Kreditoren und Konten anlegen, später evtl. das
Audit-Log sehen, aber weder Sync-Übersicht noch Mail-Protokoll.

### Entscheidungen
- **Einstellbare Gruppen:** genau drei ChurchTools-Gruppen: `superadmin`, `manager`, `buchhaltung`
  (bestätigt vom Auftraggeber; es gibt keine separate „Admin"-Gruppe). Die Gruppen-IDs bleiben in der
  Config (`CT_GROUP_ID_ADMIN` = Rolle `superadmin`); nur die Rechte pro Gruppe liegen in der DB.
- **Neue Tabelle** `gruppen_berechtigungen (gruppe TEXT, berechtigung TEXT, PRIMARY KEY(gruppe,
  berechtigung))`. Das bestehende CHECK-Constraint auf `person_berechtigungen.berechtigung` ist
  veraltet (kennt nicht alle 15 Rechte) und wird beim Anfassen bereinigt: Rechte-Liste nur noch an
  einer Stelle (`GRANTABLE_BERECHTIGUNGEN`), kein Doppelpflegen im Schema.
- **Effektives Recht** einer Person = Vereinigung aus (Rechte aller ihrer Gruppen) ∪
  (Einzelrechte der Person). Rein additiv, kein „Verbieten" über Einzelrechte.
- **Kein Auto-Allmacht mehr:** Superadmin hat nur, was eingeschaltet ist.
  Ausnahme: das Recht **`gruppenrechte_verwalten`** ist für Superadmin fest gesetzt, im UI
  sichtbar, aber nicht abschaltbar (Schutz vor Aussperren). Dieses Recht ist nicht für andere
  Gruppen und nicht als Einzelrecht vergebbar.
- **Alle harten Rollengatter werden zu Rechten.** Heute sind u. a. superadmin-exklusiv:
  Benachrichtigungen, Erscheinungsbild, Ersteinrichtung, Zeitstempel, Backup, Module,
  Dateiquarantäne, Personen (superadmin+manager), Testmodus (superadmin+manager). Jedes bekommt ein
  eigenes Recht und wird in `GRANTABLE_BERECHTIGUNGEN` + `BERECHTIGUNG_LABELS` aufgenommen, die
  Routen wechseln von `requireRole`/`requireAnyRole` auf `requirePermission`. Die genaue
  Zerlegung (ein Recht pro Seite) legt der Builder fest; Ziel: jede Admin-Seite hat genau ein
  Recht.
- **Admin-Zugang:** `requireAdminAreaAccess` = Person hat mindestens ein Admin-Recht (aus Gruppe
  oder Einzelrecht). Buchhaltungs-Mitglieder sehen den Admin-Bereich also nur, wenn die Gruppe
  mindestens ein Recht hat.
- **Rollenfunktionen ausserhalb der Rechte bleiben an die Gruppe gebunden:** Pool sehen/
  beanspruchen (Buchhaltung), Fallback-Empfänger für Admin-Eskalationen (Superadmin),
  Freigeber/Stellvertreter (kontobasiert). Nicht Teil dieses Projekts.
- **Startwerte (Migration):** Verhalten wie heute. Superadmin = alle Rechte; Manager = sein
  heutiges Bündel (alle ausser `sync_verwalten`, `workflow_eingreifen`, `betrieb_einsehen`;
  inkl. der bisher an `manager` hängenden Seiten Personen und Testmodus); Buchhaltung = keine.
  Neue Rechte aus diesem Release (z. B. `wartungsmodus_schalten`) sind zunächst nur für
  Superadmin eingeschaltet. Das Seeden passiert einmalig in der Migration und überschreibt später
  nie Änderungen des Admins.
- **Neue Admin-Seite „Gruppenrechte"** (Recht `gruppenrechte_verwalten`): Matrix Rechte × Gruppen
  mit Schaltern, gruppiert nach Bereich, mit Speichern-Button und CSRF-Schutz.
- **Herkunft beim User:** In der Personen-Detailansicht (`/admin/personen`) steht pro Recht, woher
  es kommt: „direkt vergeben", „über Gruppe Manager" (mehrere Quellen nebeneinander möglich).
  Nur Rechte, die die Person effektiv hat, werden gelistet. Das Einzelrechte-Formular zeigt
  gruppenvergebene Rechte als „bereits durch Gruppe X" (deaktiviert/informativ), damit niemand
  doppelt pflegt.
- **Navigation** (`middleware/nav.js`, `services/navigation.js`) und der Prüfer
  `erstellePermissionPruefer` nutzen dieselbe neue Logik. Die Gruppenrechte werden pro Request nur
  einmal geladen (kleine Tabelle; Cache pro Request genügt).
- **Audit-Log:** Jede Änderung an Gruppenrechten wird im globalen Audit-Log protokolliert: wer,
  welche Gruppe, welches Recht, alt → neu (ein Eintrag pro geändertem Recht). Neue
  Aktionsart(en) in `auditLog.js`, im Audit-Log-Filter auswählbar. Ebenso werden Änderungen an
  Einzelrechten nach demselben Muster protokolliert, falls das heute noch nicht der Fall ist.
- **Verweigerungs-Audit** (`zugriffsAudit`) bleibt wie er ist (Grund `fehlendes_recht` + Recht).

### Ziele / Nicht-Ziele / Anti-Ziele
- Ziel: Superadmin kann Gruppen-Rechte ohne Code-Änderung anpassen; Herkunft ist nachvollziehbar.
- Nicht-Ziel: Verbotsrechte, eigene neue Gruppen im Portal anlegen, Rechte für Pool-/
  Freigabefunktionen.
- Anti-Ziel: Aussperren (kein Superadmin kann mehr Gruppenrechte ändern); stille Verhaltens-
  änderung beim Update (Startwerte = Ist-Zustand).

### Tests (Mindestumfang)
Effektive Rechte (Gruppe, Einzel, Summe), Herkunftsanzeige, nicht abschaltbares
`gruppenrechte_verwalten`, Migration seedet Ist-Zustand und überschreibt nichts, jede umgestellte
Route verweigert ohne Recht und erlaubt mit Recht (Erweiterung der bestehenden
Rechte-/Route-Tests), Audit-Einträge, CSRF auf der neuen Seite.

---

## B. Konten-Klassifizierung (Rechnung / Gutschrift)

### Ziel
Jedes Konto sagt, was darauf gebucht werden darf; die Kontierung bietet nur passende Konten an.

### Entscheidungen
- **Neue Spalte** `konten.buchungsart TEXT NOT NULL DEFAULT 'beides' CHECK (… IN ('rechnung',
  'gutschrift', 'beides'))`. Bestehende Konten bekommen `beides` → keine Verhaltensänderung.
- **Admin Konten:** Auswahl der Buchungsart beim Anlegen und Bearbeiten, Anzeige in der Liste.
  Änderung wird im Audit-Log protokolliert (wie andere Konten-Änderungen).
- **Kontierung:** Wahl „Rechnung" → Konten `rechnung` und `beides`. Wahl „Gutschrift" → Konten
  `gutschrift` und `beides`. Der Filter hängt am Typ-Radio der Kontierung
  (`views/kontierung.ejs`, `public/js`).
- **Typwechsel:** Passt das gewählte Konto nicht mehr, wird die Auswahl geleert, mit kurzem
  Hinweis (Entscheidung des Entwurfs).
- **Aufsplitten:** Der Filter gilt pro Zeile nach dem Typ der Rechnung (Entscheidung des Entwurfs).
- **Serverseitig:** Der Server lehnt ein nicht passendes Konto in Kontierung und Aufsplitten ab
  (Entscheidung des Entwurfs; Filter im Browser allein genügt nicht).
- **Spesen und Kreditkarten-Belege** zählen als Rechnung: nur `rechnung`/`beides`
  (vom Auftraggeber bestätigt).
- **Bestehende Vorgänge** bleiben unberührt, auch wenn ein Konto später umgestellt wird.
  Kontenwechsel auf einem bereits kontierten Vorgang (z. B. Umhängen durch Admin) prüft die
  Buchungsart nicht rückwirkend; das ist Sache des Builders zu bestätigen, wo Konten sonst noch
  gewählt werden (z. B. Umhängen, Budgets) und ob dort gefiltert werden soll – im Zweifel nicht.
- **Konten-Import/Bexio-Bezug:** keine Änderung nötig; die Buchungsart ist rein portal-intern.

### Tests
Filterlogik pro Typ, Serverablehnung, Default `beides`, Aufsplitten pro Zeile, Spesen/KK nur
Rechnungs-Konten, Admin-Formular speichert und auditiert.

---

## C. Wartungsmodus

### Ziel
Der Admin schaltet das Portal für Updates in einen Wartungsmodus. Zweck: ein **konsistenter
Stand für ein Backup/Update**. Währenddessen verändern sich keine Daten durch Rechnungsverarbeitung
oder Mailversand. Kommt trotzdem etwas rein, entstünde ein Delta zum Backup – genau das soll
vermieden werden.

### Entscheidungen
- **Recht** `wartungsmodus_schalten` (additiv, pro Gruppe/Person vergebbar, siehe A).
  Standard: nur Superadmin. Schalter auf einer Admin-Seite (z. B. unter Betrieb/Module).
- **Zustand** in der DB (Einstellungstabelle wie beim Spesenmodul-Schalter), nicht in der Session;
  überlebt Neustart. Optional eine Hinweiszeile („Update bis ca. 14:00").
- **Normale User:** jede Seite ausser `/healthz`, `/auth/*` und den Maschinenrouten zeigt eine
  Wartungsseite („Wartungsarbeiten, bitte später wieder versuchen"), HTTP 503. Keine
  schreibenden Aktionen möglich.
- **Personen mit dem Recht** arbeiten weiter und sehen oben einen Banner „Wartungsmodus aktiv" mit
  Link zum Ausschalten. (Annahme des Entwurfs; Auftraggeber hat „wer darf rein" nicht explizit
  bestätigt. Alternative wäre nur die Schalt-Seite.)
- **Mails:** Es wird nichts versendet. Die Mail-Outbox hält zurück und behält alles; nach dem
  Ausschalten wird normal nachgeliefert (bestehender Retry-Mechanismus). Nichts wird verworfen.
- **Rechnungseingang (n8n):** `/api/n8n/*` (jobs, kk-belege, rapporte) antworten mit **503** und
  `Retry-After`. n8n versucht es später erneut (Entscheidung des Auftraggebers: kein
  Zwischenspeichern im Portal). Der Builder prüft, wie der n8n-Workflow auf 503 reagiert, und
  dokumentiert die nötige n8n-Anpassung (Retry konfigurieren), wie es bei früheren
  422-Änderungen schon gemacht wurde.
- **Backup-Route** (`/api/n8n/backup`) und Backup-Seite im Admin bleiben bedienbar – sonst wäre der
  Zweck verfehlt.
- **Geplante Jobs / Cron** (`/internal/cron`, `scheduler`): pausieren, antworten mit 503 bzw. tun
  nichts, solange der Modus aktiv ist (Sync, Erinnerungen, Audit-Paket u. a.). Verpasste Läufe
  holt der Scheduler nach dem Ausschalten nach dem bestehenden Muster nach bzw. sie laufen zur
  nächsten Fälligkeit; Builder prüft, ob Läufe still verfallen, und dokumentiert es.
- **Audit-Log:** Ein- und Ausschalten wird protokolliert (wer, wann, Hinweistext).
- **Statusseite / Monitoring:** `/healthz` meldet den Wartungsmodus als Info, nicht als Fehler,
  damit kein Fehlalarm entsteht.
- **Testmodus-Instanz:** nicht betroffen.

### Ziele / Nicht-Ziele
- Ziel: sauberer, nachvollziehbarer Stillstand für Backup + Update.
- Nicht-Ziel: automatisches Zeitfenster, Rechnungs-Puffer im Portal, Ankündigung per Mail.

### Tests
Schalter an/aus mit Recht, 503-Wartungsseite für normale User, Zugang mit Recht, n8n-Routen 503,
Backup-Route weiter erreichbar, Mailversand hält zurück und liefert nach dem Ausschalten, Cron
pausiert, Audit-Einträge, Zustand überlebt Neustart.

---

## Dokumentation
`docs/auth-und-rechte.md`, `docs/admin-bereich.md`, `docs/n8n-schnittstelle.md` (503/Retry),
`docs/betrieb-und-nutzung.md` (Wartungsmodus-Ablauf: Modus an → Backup → Update → Modus aus) und
`docs/datenmodell.md` nachziehen; Test-Runbook um die drei Funktionen ergänzen.

## Dem Builder überlassen
Exakte Rechte-Zerlegung pro Admin-Seite, UI-Gestaltung der Matrix (im Stil der bestehenden
Admin-Seiten, Du-Form), Namen der Audit-Aktionen, Ort des Wartungsmodus-Schalters, technische
Umsetzung der zentralen Sperre (eine Middleware plus Prüfung in Mailer und Scheduler).
