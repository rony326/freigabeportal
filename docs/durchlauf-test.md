# Durchlauf-Test (automatischer End-to-End-Test gegen eine Testinstanz)

> **Nie gegen das Live-Portal.** Der Durchlauf kontiert und gibt Belege wirklich frei; n8n exportiert sie danach
> nach Paperless und Bexio. Er ist nur für eine **Testinstanz** des Portals mit eigenem n8n-Test-Workflow gedacht.

Der Durchlauf spielt den ganzen Rechnungsweg einmal durch, ohne dass sich jemand mehrmals anmelden und von Hand
klicken muss:

```
Mail (von Hand) → n8n → Portal-Eingang → Kontierung (Person A) → Freigabe 2 (Person B) → Abholung durch n8n → (Archivquittung) → (Versand an Bexio)
```

Das Werkzeug liegt in `scripts/durchlauf/` und gehört nicht zu `npm test`. Die reine Logik
(Konfiguration, Sicherheitsprüfungen, Erkennung neuer Belege, Bericht) ist in `test/unit/durchlauf.test.js` geprüft.

## Voraussetzungen auf der Testinstanz

- **Zwei ChurchTools-Testkonten**, Person A und Person B (Vier-Augen-Prinzip: zwei verschiedene Personen).
- **Testkonto** im Portal (Admin → Konten): Freigeber 1 = A, Freigeber 2 = B, beide aktiv. Stellvertretungen
  sind Pflichtfelder, spielen für den Durchlauf aber keine Rolle.
- **A sieht neue Belege**: entweder ist A in der Buchhaltungsgruppe (dann landen Eingänge im Pool und A
  beansprucht sie), oder eine Zuweisungsregel für den Absender der Testmail weist sie direkt A zu.
- **Lieferant** «Testlieferant AG» mit der IBAN der Testbelege (wie im Testdrehbuch, Vorbereitung), damit die
  QR-Erkennung Lieferant und Betrag vorbelegt.
- **n8n-Test-Workflow**: holt Mails im Test-Postfach ab, reicht sie per `POST /api/n8n/jobs` beim
  Testportal ein und holt fertige Belege ab (`GET /api/n8n/jobs/abholbereit`, siehe
  [n8n-schnittstelle.md](n8n-schnittstelle.md)). Paperless und Bexio ebenfalls als Testumgebung.
- Auf dem Rechner, der den Durchlauf startet: `npm install` im Repo (Playwright mit Chromium,
  `npx playwright install chromium` falls nötig) und ein Bildschirm für die Anmeldung.

## Schritt für Schritt

### 1. Konfiguration

```bash
cp .env.durchlauf.example .env.durchlauf
```

In `.env.durchlauf` (git-ignoriert) mindestens eintragen:

| Variable | Bedeutung |
|---|---|
| `DURCHLAUF_ZIEL_URL` | Adresse der Testinstanz, z. B. `https://test-portal.example.org`. **Pflicht, kein Standardwert.** Nur `https://` (http nur für `localhost`). |
| `DURCHLAUF_KONTO` | Kontonummer des Testkontos. Pflicht. |
| `DURCHLAUF_ANZAHL` | Anzahl Belege, die du schickst (Standard 1). |
| `DURCHLAUF_ENDE` | `abgeholt` (Standard), `archiv_bestaetigt` oder `bexio_gemeldet`, siehe «Was am Ende geprüft wird». |
| `DURCHLAUF_N8N_API_KEY` | n8n-Schlüssel **der Testinstanz**, nur für den lesenden Abruf der offenen Archivquittungen. Pflicht bei `archiv_bestaetigt`. |
| `DURCHLAUF_LIEFERANT`, `DURCHLAUF_BETRAG`, `DURCHLAUF_IBAN_ENDUNG` | nur für Belege ohne QR-Code (die Testbelege R4…: Testlieferant AG, IBAN-Endung `3456`). |

Weitere Werte (Zeitlimits, Abfrageintervall, Zahlungsziel, Rechnungsnummer-Präfix, Verhalten beim Prüf-Popup)
sind in der Vorlage beschrieben. Steht in der Umgebung `PRUEF_ZIEL_URL` (Live-Adresse der Abschlussprüfung),
bricht das Werkzeug ab, wenn `DURCHLAUF_ZIEL_URL` auf denselben Host zeigt.

### 2. Anmelden (einmal je Person, gilt 8 Stunden)

```bash
npm run durchlauf:anmelden -- a     # Person A (Kontierung)
npm run durchlauf:anmelden -- b     # Person B (Freigabe 2)
```

Es öffnet sich ein Chromium-Fenster auf `<Ziel>/auth/login`. Mit dem jeweiligen ChurchTools-Testkonto anmelden;
sobald die Aufgabenseite des Portals erscheint, schliesst sich das Fenster. Das Werkzeug zeigt, als wer man
angemeldet ist, und speichert die Sitzung in `.durchlauf/person-a.json` bzw. `person-b.json` (nur für den eigenen
Benutzer lesbar, git-ignoriert). Gespeichert werden nur die Cookies des Portals, nicht die ChurchTools-Anmeldung.
Die Sitzung gilt 8 Stunden; eine Sitzung mit weniger als 30 Minuten Restzeit gilt als abgelaufen.

Für B in einem Browser ohne die ChurchTools-Anmeldung von A anmelden: das Werkzeug startet jedes Mal einen frischen
Browser, ChurchTools fragt also neu nach dem Konto.

### 3. Starten

```bash
npm run durchlauf                 # mit Sicherheitsabfrage
npm run durchlauf -- --ja         # ohne Rückfrage (z. B. in einem Skript)
npm run durchlauf -- --nur-portal # nur Eingang, Kontierung und Freigabe 2, ohne auf n8n zu warten
```

Weitere Angaben: `--konfig <datei>` (andere Konfigurationsdatei), `--sichtbar` (Browser beim Kontieren und
Freigeben sichtbar, zur Fehlersuche).

Vor dem Start zeigt das Werkzeug Zieladresse, `/healthz`-Status, Version (aus der Fusszeile), die Namen von A und B
(samt Ablauf der Sitzung), Testkonto, Anzahl Belege und das Ende des Laufs, und verlangt die Eingabe «ja». Es bricht ab,
wenn eine Sitzung fehlt oder abgelaufen ist («zuerst npm run durchlauf:anmelden -- a») oder A und B dieselbe Person sind.

### 4. Mail schicken

Nach der Bestätigung merkt sich das Werkzeug, welche Belege A schon sieht, und meldet
«Jetzt die Testmail(s) an das Eingangs-Postfach schicken». Es nennt passende Testbelege aus
`docs/testdrehbuch/belege/out/1_Rechnungen/` (erzeugen mit `cd docs/testdrehbuch/belege && npm ci && npm run erzeugen`):

| Beleg | Eignung |
|---|---|
| `R1_…_QR.pdf` | Standardfall: QR-Rechnung der Testlieferant AG mit hinterlegter IBAN. Lieferant und Betrag werden vorbelegt. |
| `R4_…`, `R4b_…`, `R4c_…` (ohne QR) | Für mehrere Belege je Lauf. Braucht `DURCHLAUF_LIEFERANT=Testlieferant AG`, `DURCHLAUF_BETRAG`, `DURCHLAUF_IBAN_ENDUNG=3456`. |

Nicht als Standard: R2/R2b (Dubletten), R3 (falsche IBAN), R5 (Sammelrechnung), R6 (Gutschrift), R7a/R7b (Lieferant
ohne hinterlegte IBAN). Diese prüfen Sonderfälle und gehören ins Testdrehbuch.

Das Portal nimmt dieselbe Datei nur einmal an (gleiche Bytes = Duplikat, es entsteht kein neuer Vorgang). Für einen
weiteren Lauf die Belege neu erzeugen; die Dateien bekommen dabei neue Bytes.

### 5. Was der Durchlauf tut

1. **Eingang**: fragt als A alle `DURCHLAUF_ABFRAGE_S` Sekunden die Aufgabenseite ab, bis die erwartete Anzahl
   **neuer** Belege im Pool oder unter «Meine offenen Kontierungen» steht (nur Belege, die vorher nicht sichtbar waren
   und eine höhere Nummer haben als alles Bisherige). Zeitlimit `DURCHLAUF_ZEITLIMIT_EINGANG_MIN`.
2. **Kontierung als A**: beansprucht den Beleg (Pool), wählt Typ Rechnung und das Testkonto, übernimmt vorbelegte Werte
   (Lieferant und Betrag aus dem QR-Code, Absender aus dem Eingang), ergänzt Fehlendes aus der Konfiguration
   (Rechnungsnummer `DT-<Zeit>-<Beleg-ID>`, Zahlungsziel heute + 30 Tage, IBAN-Endung bei Belegen ohne QR),
   beantwortet die Befangenheits-Frage mit «Nein» und kontiert. Erscheint das Prüf-Popup (z. B. Dubletten-Verdacht),
   wird es mit der Bemerkung «Automatischer Durchlauf-Test (Testinstanz)» bestätigt
   (`DURCHLAUF_AUFFAELLIGKEITEN=abbrechen` meldet es stattdessen als Fehler).
3. **Freigabe 2 als B**: prüft, dass der Beleg bei B unter «Meine Freigaben» steht, bestätigt die Zahlungsdaten (und
   allfällige Zahlungshinweise), «Nein» bei der Befangenheit, Freigeben.
4. **Export** (ohne `--nur-portal`): fragt als B «Abgeschlossene Rechnungen» und die Belegseite ab, bis n8n die Belege
   abgeholt hat (und je nach Einstellung die Archiv- oder die Bexio-Versandquittung vorliegt). Zeitlimit
   `DURCHLAUF_ZEITLIMIT_EXPORT_MIN`.

Belege werden nacheinander bearbeitet; ein Fehler bei einem Beleg hält die anderen nicht auf.

### 6. Ergebnis lesen

Am Ende steht eine Tabelle je Beleg und Schritt mit Status, Dauer und Ursache:

| Zeichen | Bedeutung |
|---|---|
| ✓ | erledigt |
| ✗ | fehlgeschlagen oder Zeitlimit (Ursache in der letzten Spalte) |
| · | wegen eines früheren Fehlers nicht ausgeführt |
| – | übersprungen (`--nur-portal`) |
| ? | Archiv bzw. Bexio-Versand nicht gemeldet, aber nicht verlangt: in Paperless bzw. bei Bexio von Hand prüfen |

Darunter folgt die **Handprüfung**: je freigegebenem Beleg Portal-ID, Dateiname, Betrag, Lieferant und
Rechnungsnummer, damit du das Dokument in Paperless und die Mail an Bexio findest. Hat n8n den Versand an Bexio
gemeldet, steht dort zusätzlich Zeitpunkt, Empfänger und Message-ID der Mail (damit findest du sie im Postausgang
und bei Bexio).

Bei einem Fehler in Kontierung oder Freigabe 2 liegen ein Bildschirmfoto und das HTML der Seite in
`.durchlauf/fehler/` (Dateinamen stehen in der Ursache). Exit-Code: `0` nur, wenn alle Schritte ✓ (oder – bzw. ?) sind;
`1` bei einem fehlgeschlagenen Schritt; `2` bei Abbruch vor dem Lauf (Konfiguration, Sitzung, keine Bestätigung).

## Was am Ende geprüft wird (Abholung, Archiv, Bexio)

Für normale Personen zeigt das Portal den Exportstand nur als Status auf **«Abgeschlossene Rechnungen»**:
`abgeschlossen` (freigegeben, wartet auf n8n) bzw. `abgeholt`. Den Status `abgeholt` setzt das Portal, sobald n8n
`POST /api/n8n/jobs/:id/abholung-bestaetigen` oder `POST /api/n8n/jobs/:id/archivierung-bestaetigen` aufruft.
Ein blosser Abholversuch (`GET /abholbereit`) ist von aussen nicht sichtbar, und der Durchlauf ruft diese Route
**nie** auf: sie markiert Belege als «gerade abgeholt» und würde den echten n8n-Ablauf stören.

- **`DURCHLAUF_ENDE=abgeholt`** (Standard): gewartet wird, bis der Status `abgeholt` ist. Die Spalte «Archiv bestätigt»
  zeigt «nicht gemeldet – in Paperless von Hand prüfen» (kein Fehler, Exit-Code bleibt 0). Ist zusätzlich
  `DURCHLAUF_N8N_API_KEY` gesetzt und hat n8n die Archivierung doch bestätigt, steht dort ✓.
- **`DURCHLAUF_ENDE=archiv_bestaetigt`**: gewartet wird zusätzlich auf die Archivquittung. Die Quittung ist in der
  Oberfläche nicht sichtbar; das Werkzeug fragt deshalb mit `DURCHLAUF_N8N_API_KEY` die nur lesende Route
  `GET /api/n8n/jobs/archivierung-ausstehend` ab. Ein Beleg mit Status `abgeholt`, der dort nicht mehr steht, hat
  seine Quittung.

**Volle Nachweiskette:** Wer den Paperless-Nachweis automatisch will, ergänzt im n8n-Workflow nach dem
Paperless-Upload (und dem Hash-Vergleich mit dem Paperless-Original) den Aufruf `archivierung-bestaetigen`
(siehe [n8n-schnittstelle.md](n8n-schnittstelle.md), «Abholung fertiger Rechnungen», und
[n8n-paperless-archivierung.md](n8n-paperless-archivierung.md)) und setzt dann `DURCHLAUF_ENDE=archiv_bestaetigt`.

**Bexio:** n8n meldet nach dem Mailversand an das Bexio-Eingangspostfach `POST /api/n8n/jobs/:id/bexio-versand-bestaetigen`
(siehe [n8n-schnittstelle.md](n8n-schnittstelle.md), «Versand an Bexio bestätigen»). Die Quittung zeigt das Portal auf der
Belegseite `/zeitstempel-pruefen?jobId=<id>` («An Bexio gesendet: ‹Zeitpunkt›, an ‹Empfänger›, Message-ID ‹…›» bzw.
«Versand an Bexio: noch nicht gemeldet»). Der Durchlauf liest diese Zeile über die Oberfläche: als B (Freigeber 2 darf die
Seite öffnen), bei «Kein Zugriff» als A (zugewiesene Person). Den API-Abruf `bexio-versand-ausstehend` braucht er dafür nicht.

- **`DURCHLAUF_ENDE=bexio_gemeldet`**: gewartet wird, bis der Beleg abgeholt ist **und** die Versandquittung vorliegt.
  Fehlt sie nach dem Zeitlimit, ist die Stufe ✗. Die Archiv-Spalte verhält sich wie bei `abgeholt`.
- Bei `abgeholt` und `archiv_bestaetigt` ist die Spalte «An Bexio gemeldet» nur zur Info: ✓ mit Zeitpunkt, Empfänger
  und Message-ID, wenn die Quittung schon da ist, sonst «? nicht gemeldet – bei Bexio von Hand prüfen». Sie ändert den
  Exit-Code nicht.

Die Quittung belegt nur, dass der eigene Mailserver die Mail angenommen hat, nicht die Zustellung oder Verbuchung bei
Bexio. Die Ankunft bei Bexio bleibt eine Handprüfung (Liste am Ende des Laufs).

Bleibt der Status `abgeschlossen`, meldet der Durchlauf nach dem Zeitlimit ✗ mit dem Hinweis, dass n8n weder
`abholung-bestaetigen` noch `archivierung-bestaetigen` gemeldet hat. Mögliche Gründe: Workflow inaktiv, der Workflow
ruft keine der beiden Bestätigungen auf, oder der Zeitstempel steht noch aus (mit konfiguriertem Zeitstempeldienst
liefert `/abholbereit` einen Beleg erst nach gesetztem Zeitstempel). Ruft der Workflow keine Bestätigung auf, ist die
Abholung von aussen nicht feststellbar: dann `--nur-portal` verwenden und Paperless/Bexio von Hand prüfen.

## Grenzen

- Die Mail schickt der Betreiber von Hand; das Werkzeug liest kein Postfach.
- Paperless und Bexio werden nicht direkt abgefragt; das Werkzeug sieht nur, was n8n dem Portal meldet (siehe oben).
- Nur der Standardweg einer Rechnung: keine Gutschriften, kein Aufsplitten, keine Spesen, keine Kreditkarten-Belege,
  keine Ablehnung, keine Befangenheit. Diese Fälle stehen im Testdrehbuch.
- Neue Belege erkennt das Werkzeug über die Aufgabenseite von A. Kommen gleichzeitig andere Belege an (andere Tester),
  können sie mitgezählt werden; überzählige Belege werden nicht bearbeitet und im Bericht erwähnt.
- Die Sitzungen gelten 8 Stunden; danach neu anmelden.
- Abfragen zählen zum Anfrage-Limit je Person (300 je 15 Minuten). Das Abfrageintervall (Standard 20 s) bleibt
  weit darunter; nicht unter 5 s einstellen.

## Aufräumen

`.durchlauf/` enthält die Sitzungs-Cookies der Testkonten. Nach dem Testen löschen (`rm -r .durchlauf`) oder sich im
Portal abmelden. Die erzeugten Testvorgänge bleiben auf der Testinstanz; in Paperless und Bexio die Testbelege nach
der Handprüfung entfernen.
