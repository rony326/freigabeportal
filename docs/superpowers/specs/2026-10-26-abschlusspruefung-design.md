# Abschlussprüfung vor dem Launch — Design

Stand: 2026-10-26. Status: Entwurf, zur Freigabe.

## Absicht und Warum

Vor dem Launch soll das **ganze** Portal einmal gesamthaft geprüft werden — bisher wurde jedes
Feature einzeln geprüft, das Gesamtbild nie. Die zwei schlimmsten Fälle für den Nutzer:
**unbefugter Zugriff** und **Ausfall**. Das Portal läuft auf dem **Node.js-Hosting von
Infomaniak** und ist offen im Internet erreichbar; die vorletzte Version läuft unter
der Live-Adresse (nur lokal beim Nutzer bekannt, steht in keinem Dokument).

## Ziele

1. **Schwachstellen finden und beheben**, geprüft nach dem CIA-Prinzip und verwandten Zielen:
   - **Vertraulichkeit:** nur Berechtigte sehen Rechnungen, PDFs, Personen, Kommentare,
     Protokolle, Sicherungen, Einstellungen.
   - **Integrität:** niemand ändert Daten, PDFs, Freigaben, Stempel, Zeitstempel oder das
     Audit-Log unbemerkt oder unberechtigt.
   - **Verfügbarkeit:** kein Absturz oder Stillstand durch Fehler, grosse/kaputte Dateien,
     viele Anfragen, volle Platte, Neustart, Ausfall von ChurchTools/TSA/SMTP; Sicherungen sind
     im Ernstfall wiederherstellbar; Uptime Kuma meldet Ausfälle rechtzeitig.
   - **Echtheit (Authentizität):** wer handelt, ist wirklich diese Person (ChurchTools-Anmeldung,
     Sitzung, Maschinenschlüssel).
   - **Nachvollziehbarkeit / Nichtabstreitbarkeit:** jede relevante Handlung steht unveränderlich
     im Audit-Log.
2. **CVE-Abgleich:** alle direkten und indirekten Abhängigkeiten (`package-lock.json`), die
   Node.js-Version (Infomaniak und lokal), Playwright/Chromium (nur Entwicklung). Bekannte CVEs
   über `npm audit` und die GitHub-Advisory-Datenbank **und** aktive Suche nach neuen Meldungen
   der letzten Wochen (z. B. Express, body-parser, path-to-regexp, cookie, multer/Upload,
   pdf-lib, nodemailer, undici, ejs, csrf-csrf, Node.js-Security-Releases).
3. **Prüfung von aussen** gegen der Live-Adresse (nur lokal beim Nutzer bekannt, steht in keinem Dokument) (siehe Entscheidungen 1):
   TLS/HTTPS, Sicherheitsheader (CSP, HSTS, Referrer-Policy, X-Content-Type-Options, Frame-
   Schutz), Cookie-Attribute, erreichbare Pfade ohne Anmeldung, Fehlerseiten ohne interne Details,
   `/healthz` ohne Schlüssel, öffentliche Prüfseiten (`/audit-pruefen`, `/zeitstempel-pruefen`),
   Anmelde-Rückkehr (offene Weiterleitung), Verhalten der Ratenbegrenzung (wenige Anfragen).
4. **Prüfung von innen** am aktuellen Code (`master`) und an einer lokalen Kopie: jede Route mit
   ihrer Rechteprüfung (inkl. ID-Raten/IDOR), Uploads (Typ, Grösse, Pfade, PDF-Parser),
   Maschinen-Routen (n8n, Cron, Backup), Testmodus-Weiche, CSRF, Sitzungen, Geheimnisse und
   Konfiguration, Logging ohne Geheimnisse, Datei- und Datenbankzugriffe, Sicherung/Wiederherstellung,
   Last- und Fehlerszenarien.
5. **Betrieb auf Infomaniak:** passt die Konfiguration (Proxy/`trust proxy`, sichere Cookies,
   Dateipfade/Persistenz, Neustarts, Umgebungsvariablen, Ports, Logrotation, Zeitzone)?
6. **Ergebnis:** ein Prüfbericht `docs/pruefbericht-2026-10.md` mit allen Funden (Schwere,
   CIA-Ziel, Ort, Nachweis, Behebung, Status) plus einer Liste, was geprüft wurde und was offen
   bleibt (z. B. was nur Infomaniak absichern kann). **Kritische, hohe und mittlere Funde werden
   behoben** (mit Test), **niedrige** dem Nutzer vorgelegt.

## Nicht-Ziele

- Barrierefreiheit (bewusst weggelassen; Nutzer kann sie nachträglich wünschen).
- Neue Funktionen.
- Prüfung der Infomaniak-Plattform selbst oder von ChurchTools/n8n/Paperless/Bexio.

## Anti-Ziele

- Die Prüfung legt das Live-Portal lahm, verändert dort Daten oder verschickt Mails.
- Infomaniak wertet die Prüfung als Angriff (Sperre der IP oder des Hostings).
- Funde werden „behoben“, indem Prüfungen abgeschwächt oder Tests gelockert werden.
- Geheimnisse (Schlüssel, Tokens, Passwörter) landen im Bericht, in Logs oder im Repository.

## Vom Nutzer entschieden

1. Prüfung umfasst Sicherheit **und** Ausfallsicherheit; grösste Sorgen: unbefugter Zugriff, Ausfall.
2. Gegen bekannte **und neue CVEs** sowie nach dem **CIA-Prinzip und verwandten Zielen**.
3. Live-Ziel: der Live-Adresse (nur lokal beim Nutzer bekannt, steht in keinem Dokument) (vorletzte Version) darf geprüft werden; es ist die
   **spätere Produktivadresse**, der aktuelle Stand wird vor dem Launch dort aufgespielt.
4. **Keine Ankündigung** an Infomaniak. Live wird **bestimmt und echt** geprüft, aber ohne DDoS
   oder ähnliche Überlastung.

## Entscheidungen des Entwurfs (meine Calls)

1. **Live echt, aber ohne Überlastung:** aktive Angriffsversuche ohne gültige Anmeldung sind
   erlaubt — manipulierte Pfade, IDs, Header, Cookies und Parameter, Injection-Versuche, gefälschte
   oder fehlende Schlüssel und CSRF-Tokens, POSTs, die abgewiesen werden sollten, Anmelde-Rückkehr
   mit fremden Zielen, Prüfung der Ratenbegrenzung mit einem kurzen, kleinen Stoss. Grenzen:
   höchstens ~2 Anfragen pro Sekunde im Mittel, kurze Stösse bis ~20 Anfragen, insgesamt einige
   tausend; keine Last- oder Absturztests, keine grossen Uploads, keine Anmeldung mit echten
   Konten. Gelingt ein Angriff und legt dabei etwas an, wird das sofort gemeldet und dokumentiert
   (Bereinigung durch den Nutzer). Last-, Absturz- und angemeldete Rechte-Tests laufen an der
   **lokalen Kopie**.
2. **Versionsabgleich:** jeder Live-Fund wird gegen `master` geprüft und im Bericht als
   „live vorhanden / in master behoben / in master vorhanden“ markiert. Nach dem Aufspielen des
   neuen Stands auf Infomaniak wird die Prüfung von aussen kurz wiederholt (Nachprüfung).
3. **Schwere** nach CVSS-ähnlicher Einstufung (kritisch/hoch/mittel/niedrig/Hinweis) mit kurzer
   Begründung im Klartext.
4. **Behebung** auf einem eigenen Branch `feature/abschlusspruefung`, jede Behebung mit Test;
   Abhängigkeits-Updates nur Patch/Minor ohne Bruch, sonst Vorschlag im Bericht.
5. **Werkzeuge:** `npm audit`, Advisory-Recherche im Web, eigene kleine Prüfskripte (curl/Node),
   unabhängige Prüfer-Agents mit klaren Bereichen (Zugriff/Rechte, Eingaben/Uploads,
   Konfiguration/Betrieb, Verfügbarkeit, Integrität/Audit). Keine Installation fremder
   Scanner-Werkzeuge auf dem Live-System.
6. Der Bericht ist für den Nutzer geschrieben (Deutsch, verständlich), technische Details im Anhang.

7. **Angemeldete Tests lokal:** über die bestehende Testmodus-Test-Instanz mit Beispielpersonen
   (wie `test/responsive/server.js`) und über die echte App mit gemocktem ChurchTools
   (`test/helpers/mockChurchTools.js`); kein echtes ChurchTools nötig.
8. **Geheimnisse:** kein Zugriff auf echte `.env`- oder Live-Werte; geprüft werden Code-Pfade,
   Mindestlängen und Prüfungen beim Start. Was der Nutzer selbst prüfen oder erneuern soll
   (z. B. Schlüssel rotieren), kommt als Checkliste in den Bericht.
9. **Sicherungs-Probe** mit synthetischen Daten an einer lokalen Kopie (Sicherung erstellen,
   `backup:verify`, `backup:restore` in ein leeres Verzeichnis, Portal startet, Daten stimmen);
   keine echten Sicherungen.
10. **Mittlere Funde**, die eine Major-Aktualisierung oder eine Verhaltensänderung brauchen,
    werden nicht still umgebaut, sondern mit Vorschlag im Bericht dem Nutzer vorgelegt.
11. **Abschlusskriterium:** keine offenen kritischen oder hohen Funde; Merge nach `master` erst
    nach Freigabe durch den Nutzer.

## Einschränkungen

- Infomaniak Node.js-Hosting: kein Root, HTTPS durch Infomaniak, App hinter deren Proxy.
- Live-System ist die **vorletzte** Version; der aktuelle Stand ist `master` (lokal, nicht gepusht).
- Kein Zugang zu Live-Logs oder Live-Konfiguration ausser dem, was der Nutzer liefert.

## Dem Builder überlassen

- Aufteilung der Prüfbereiche, Reihenfolge, genaue Prüfskripte.
- Form des Berichts.
- Welche Infomaniak-Einstellungen der Nutzer selbst prüfen soll (als Checkliste im Bericht).

## Hinweis zur Adresse

Die Live-Adresse wird in **keinem** Dokument genannt, das ins Repository oder auf GitHub kommt
(Spec, Plan, Prüfbericht, Tests, Commit-Nachrichten). Im Bericht heisst sie „Live-Portal“.
Prüfskripte lesen sie aus einer Umgebungsvariable (`PRUEF_ZIEL_URL`), die nicht committet wird.
