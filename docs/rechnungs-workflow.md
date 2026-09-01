# Rechnungs-Workflow

Der zentrale fachliche Prozess des Portals: eine Rechnung durchläuft
Zuweisung, Kontierung, eine zweistufige, unabhängige Freigabe
(Vier-Augen-Prinzip) und wird danach von n8n abgeholt und archiviert.
Jede Rechnung ist eine Zeile in der `jobs`-Tabelle
(siehe [datenmodell.md](datenmodell.md)); ihr Zustand steckt fast
vollständig in der Spalte `status`.

> Spesen-Einreichungen (Auslagen von Personen selbst erfasst) durchlaufen
> dieselbe `jobs`/Freigabe-Maschinerie, aber mit eigenem Einstieg statt
> Kontierung durch Dritte — eigener Prozess, siehe
> [spesen-einreichung.md](spesen-einreichung.md).

## Status-Modell

| Status | Bedeutung |
|---|---|
| `unzugewiesen` | im Pool, noch niemandem zugewiesen |
| `zugewiesen` | einer Person zur Kontierung zugewiesen |
| `freigabe2` | Kontierung + Freigabe 1 erledigt, wartet auf die zweite, unabhängige Freigabe |
| `abgeschlossen` | beide Freigaben erteilt, PDF final gestempelt (und ggf. zeitgestempelt) |
| `abgeholt` | von n8n abgerufen, lokale PDF-Datei bereits gelöscht |
| `archiviert` | vom nächtlichen Bereinigungs-Job als endgültig archiviert markiert |
| `abgelehnt` | bei Kontierung oder Freigabe 2 zurückgewiesen, wartet auf Überarbeitung |
| `aufgesplittet` | in mehrere unabhängige Teil-Jobs aufgeteilt; bleibt als historische Referenz stehen |
| `geloescht` | endgültig durch einen Admin gelöscht (Soft-Delete, siehe unten) |

> Das Datenbankschema erlaubt per `CHECK`-Constraint zusätzlich die Werte
> `kontiert` und `freigabe1` — diese werden im aktuellen Code nirgends mehr
> gesetzt: Kontierung und Freigabe 1 werden in einem einzigen
> Formular-Submit erledigt und springen direkt von `zugewiesen` zu
> `freigabe2`. Die beiden Werte sind ein Überbleibsel eines früheren
> Entwurfs und aus Kompatibilitätsgründen weiterhin im Constraint erlaubt.

## Status-Diagramm

```mermaid
stateDiagram-v2
    [*] --> unzugewiesen: n8n-Upload, keine Zuweisungsregel
    [*] --> zugewiesen: n8n-Upload, Zuweisungsregel trifft

    unzugewiesen --> zugewiesen: Pool beanspruchen
    zugewiesen --> unzugewiesen: zurück in den Pool legen

    zugewiesen --> freigabe2: Kontierung ohne Konflikt\n(= Freigabe 1 erteilt)
    zugewiesen --> zugewiesen: Kontierung mit Interessenskonflikt\n(an Stellvertreter1 / Admin übergeben)
    zugewiesen --> abgelehnt: bei Kontierung ablehnen
    zugewiesen --> aufgesplittet: aufsplitten (erzeugt N Teil-Jobs)

    freigabe2 --> freigabe2: Interessenskonflikt bei Freigabe 2\n(an Stellvertreter2 / Admin übergeben)
    freigabe2 --> abgeschlossen: Freigabe 2 erteilt (PDF gestempelt)
    freigabe2 --> abgelehnt: bei Freigabe 2 ablehnen

    abgelehnt --> zugewiesen: überarbeiten (wiederOeffnenJob)
    abgelehnt --> geloescht: Admin löscht endgültig\n(nicht durch den eigenen Ablehner)

    abgeschlossen --> abgeholt: n8n bestätigt Abholung
    abgeholt --> archiviert: pdf-bereinigung-Job (Dateien bereits weg)

    aufgesplittet --> [*]: Teil-Jobs laufen unabhängig weiter
    geloescht --> [*]
    archiviert --> [*]
```

## 1. Rechnungseingang und automatische Zuweisung

n8n lädt jede eingehende Rechnung per `POST /api/n8n/jobs`
hoch (Details: [n8n-schnittstelle.md](n8n-schnittstelle.md)). Beim Anlegen
prüft `createJob` (`src/db/jobsRepo.js`), ob der Absender zu einer
hinterlegten Zuweisungsregel passt:

```mermaid
flowchart TD
    A["Neue Rechnung (n8n)"] --> B{"Absender per Regel<br/>(exakte Adresse oder Domain)<br/>einem Debitor zugeordnet?"}
    B -- nein --> P["Status: unzugewiesen<br/>(landet im Pool)"]
    B -- ja --> C{"Debitor hat<br/>ein Default-Konto?"}
    C -- nein --> P
    C -- ja --> D["Status: zugewiesen<br/>zugewiesen_an = Freigeber 1 des Kontos<br/>+ Zuweisungs-Mail an Freigeber 1"]
```

Zusätzlich wird beim Eingang automatisch nach einem Swiss-QR-Bill
gesucht (siehe [qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md))
und ein Thumbnail gerendert.

## 2. Kontierung (Status `zugewiesen`)

Nur die zugewiesene Person (bzw. bei SYNC-8-Eskalation an die
Admin-Gruppe: jede Person mit Rolle `superadmin`) darf
`GET/POST /kontierung/:id` aufrufen. Beim Absenden entscheidet das
Formular über drei mögliche Ausgänge:

```mermaid
flowchart TD
    A["POST /kontierung/:id"] --> B{"Aktion?"}
    B -- ablehnen --> R["Status: abgelehnt<br/>+ Ablehnungs-Mail (bei Admin-Eskalation an Admin-Gruppe)"]
    B -- kontieren --> C{"Interessenskonflikt<br/>erklärt?"}
    C -- nein --> D["Freigabe 1 erteilt (freigeber1)<br/>Status: freigabe2<br/>+ Mail an Freigeber 2"]
    C -- ja --> E{"bereits eskaliert ODER<br/>ich bin selbst Stellvertreter1<br/>des gewählten Kontos?"}
    E -- nein --> F["eskalierenFreigabe1<br/>zugewiesen_an = Stellvertreter1<br/>Status bleibt zugewiesen<br/>+ Mail an Stellvertreter1"]
    E -- ja --> G["eskalierenFreigabe1AnAdmin<br/>(SYNC-8)<br/>Status bleibt zugewiesen<br/>+ Mail an Admin-Gruppe"]
```

**Rechnung oder Gutschrift**: ein `typ`-Radio (Default `rechnung`) im
Kontierungsformular setzt `jobs.typ`. Der Betrag bleibt in der Datenbank in
beiden Fällen positiv — allein `typ` trägt die Bedeutung, es gibt keine
Vorzeichen-/Gegenbuchungslogik. Bei `gutschrift` ist das Zahlungsziel
optional (eine Gutschrift hat kein Fälligkeitsdatum), und das
Rechnungsnummer-Feld wird in der UI zu "Gutschriftnummer" umbeschriftet
(gleiche Spalte). Freigabe 1/2 laufen identisch zur normalen Rechnung, kein
Shortcut. **Bekannte Lücke**: Aufsplitten (Abschnitt 5) übernimmt `typ`
nicht an die Teil-Jobs — eine Gutschrift lässt sich aktuell effektiv nicht
aufsplitten, jeder Teil-Job wird implizit wieder zur Rechnung.

Zusätzlich, unabhängig vom Ausgang: ein optional mit hochgeladener
**Beleg** (PDF/PNG/JPEG, z. B. bei Kreditkartenabrechnungen) wird per
`mergeBelegInPdf` (`src/services/belegAnhaengen.js`) als zusätzliche
Seite(n) in die bestehende Rechnungs-PDF eingefügt — als PDF durch
Seiten-Kopie, als Bild durch eine neue, bildgrosse Seite. Beim Kontieren
mit hinterlegtem Debitor laufen ausserdem zwei unabhängige,
nicht-blockierende Prüfungen: der IBAN-Abgleich gegen den gescannten
QR-Code (siehe
[qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md)) sowie
ein Duplikat-Check auf **Debitor + Rechnungsnummer** — stimmt die
eingegebene Rechnungsnummer mit einem bereits vorhandenen Job desselben
Debitors überein (auch ein `abgelehnter`, aber kein `geloescht`-Job zählt
mit), wird ein `freigaben`-Eintrag `rechnungsnummer_duplikat` geschrieben
und Freigeber 1+2 des gewählten Kontos sowie die kontierende Person per
Mail informiert (`typ: 'rechnungsnummer-warnung'`, siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md)) —
die Kontierung wird dadurch nicht blockiert, gleiches Muster wie bei der
IBAN-Abweichung.

**Zurück in den Pool** (`POST /kontierung/:id/zurueck-in-pool`): setzt den
Job auf `unzugewiesen` zurück und löscht alle Konto-/Eskalations-Felder —
ein vollständiger Neustart. Optional kann ein "Hinweis-Konto" mitgegeben
werden, das den vermuteten richtigen Freigeber 1 per Mail informiert, ohne
den Job selbst zuzuweisen.

## 3. Freigabe 2 (Status `freigabe2`)

Autorisiert ist der **effektive Freigeber 2** des Kontos —
`stellvertreter2_id`, wenn der Job bereits einmal eskaliert wurde, sonst
`freigeber2_id` — bzw. bei SYNC-8-Eskalation jede `superadmin`-Person. Ein
harter Zusatz-Check verhindert, dass dieselbe Person, die Freigabe 1
erteilt hat, auch Freigabe 2 erteilen kann (Vier-Augen-Prinzip, siehe
[auth-und-rechte.md](auth-und-rechte.md)).

```mermaid
flowchart TD
    A["POST /freigabe2/:id"] --> B{"Aktion?"}
    B -- ablehnen --> R["Status: abgelehnt<br/>+ Ablehnungs-Mail"]
    B -- Interessenskonflikt --> C{"bereits eskaliert?<br/>(freigabe2_eskaliert_von gesetzt)"}
    C -- nein --> D["eskalierenFreigabe2<br/>an Stellvertreter2<br/>Status bleibt freigabe2"]
    C -- ja --> E["eskalierenFreigabe2AnAdmin (SYNC-8)<br/>Status bleibt freigabe2"]
    B -- freigeben --> F["stampAndFinalize:<br/>Stempel-Seite mit Freigabe 1+2<br/>und vollständigem Verlauf anhängen"]
    F --> G{"RFC3161-TSA<br/>konfiguriert?"}
    G -- ja --> H["setZeitstempel (best effort,<br/>blockiert Abschluss nicht)"]
    G -- nein --> I
    H --> I["Status: abgeschlossen<br/>abgeschlossen_am gesetzt<br/>+ Mail-Trigger für n8n-Abholung entfällt<br/>(n8n pollt selbst)"]
```

Details zur PDF-Stempelung und zum Zeitstempel:
[zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md).

## 4. Ablehnung, Überarbeitung, Löschung

- **Ablehnen** ist sowohl bei der Kontierung (`zugewiesen`) als auch bei
  Freigabe 2 (`freigabe2`) möglich — eine Rechnung muss nicht erst beide
  Stufen durchlaufen, um als ungültig/doppelt erkannt zu werden.
- **Überarbeiten** (`POST /abgelehnt/:id/ueberarbeiten`): nur die Person,
  der die Rechnung zum Zeitpunkt der Ablehnung zugewiesen war (bzw. bei
  Admin-Eskalation: `superadmin`), kann sie zurück auf `zugewiesen`
  setzen und erneut kontieren.
- **Endgültige Löschung** (`POST /admin/abgelehnt/:id/loeschen`,
  Recht `abgelehnt_verwalten`): nur für Rechnungen im Status `abgelehnt`,
  mit Pflicht-Begründung und Bestätigungs-Checkbox. **Selbstschutz**: wer
  die Rechnung selbst abgelehnt hat, darf sie nicht auch selbst löschen —
  das verhindert, dass eine einzelne Person eine Rechnung komplett aus dem
  System entfernen kann. Technisch ein **Soft-Delete**: die Zeile bleibt
  mit Status `geloescht` erhalten (PDF/Thumbnail ebenfalls), zusätzlich
  wird ein unveränderlicher Protokoll-Eintrag in `job_loeschungen`
  geschrieben (siehe [datenmodell.md](datenmodell.md)).

## 5. Aufsplitten (Status `zugewiesen` → `aufgesplittet`)

Für Sammelrechnungen/Kreditkartenabrechnungen, die auf mehrere Konten
verteilt werden müssen (`GET/POST /kontierung/:id/aufsplitten`):

1. Die Person gibt den Gesamtbetrag und mindestens zwei Teile
   (Konto + Betrag, optional eine Freitext-**Position auf der Rechnung**
   wie "Pos. 3", optional eigener Beleg pro Teil) ein; die Summe der Teile
   muss dem Gesamtbetrag entsprechen (Toleranz 0.005).
2. Der Ursprungs-Job wird auf `aufgesplittet` gesetzt und bleibt als
   historische Referenz stehen — er selbst gilt nie als freigegeben oder
   abgelehnt.
3. Für **jeden Teil** entsteht ein komplett unabhängiger neuer Job (eigene
   PDF-Kopie, eigener Freigabe-Verlauf), inkl. desselben IBAN-Abgleichs und
   Rechnungsnummer-Duplikat-Checks wie im normalen Kontierungsformular
   (Abschnitt 2):
   - Konto gehört der aufsplittenden Person selbst → sofort Freigabe 1
     erteilt, direkt Status `freigabe2` (analog zum Normalfall ohne
     Konflikt).
   - Konto gehört ihr, aber mit erklärtem Interessenskonflikt → wie beim
     Normalfall an Stellvertreter1 bzw. Admin eskaliert.
   - Konto gehört ihr **nicht** → landet als `unzugewiesen`-Teil-Job mit
     Hinweis-Konto zurück im Pool (Freigeber 1 des Ziel-Kontos bekommt
     eine Hinweis-Mail).

> **Bekannte Lücke**: `typ` (Rechnung/Gutschrift, siehe Abschnitt 2) wird
> nicht an die Teil-Jobs weitergegeben — siehe oben.

## 6. Splitgruppen — kombinierter Export statt N Einzel-Buchungen

Ohne weiteres Zutun würde jeder Teil-Job aus Abschnitt 5 einzeln über
Abschnitt 7 an n8n/Bexio geliefert — eine aufgesplittete Rechnung mit drei
Konten entstünde als drei unzusammenhängende Bexio-Buchungen. Stattdessen
führt `pruefeUndFinalisiereSplitGruppe`
(`src/services/splitGruppenExport.js`) eine **Splitgruppe** (alle
Teil-Jobs mit demselben `aufgesplittet_von`-Elternjob) zu einem einzigen
Dokument zusammen, sobald **alle** ihre Teile `abgeschlossen` sind (weder
offen noch abgelehnt/gelöscht):

- Die Original-Belegseiten jedes Teils werden 1:1 kopiert, dahinter **eine
  gemeinsame** Stempel-/Verlaufsseite (`stampGruppenDokument`,
  `src/services/pdfStamp.js`) mit allen Konten, Positionen (Freitext aus
  Abschnitt 5) und allen Freigabe-1/2-Einträgen jedes Teils.
- Das Ergebnis wird RFC3161-zeitgestempelt wie ein normaler Job (siehe
  [zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md))
  und in `jobs.gruppe_pdf_pfad`/`gruppe_zeitstempel_*` **auf dem
  Elternjob** abgelegt — der Elternjob (Status bleibt `aufgesplittet`)
  wird dadurch selbst zum Abholobjekt für n8n, nicht mehr seine Kinder
  einzeln (siehe [n8n-schnittstelle.md](n8n-schnittstelle.md)).
- Ausgelöst wird der Merge-Versuch direkt nach Abschluss des jeweils
  letzten offenen Geschwister-Teils und nach Auflösung einer blockierenden
  Ablehnung; der Hintergrund-Job `split-gruppen-nachholen` holt einen
  gescheiterten oder noch unvollständigen Merge alle 15 Minuten nach
  (siehe [geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md)).

## 7. Abholung und Archivierung

Nach `abgeschlossen` übernimmt n8n: `GET /api/n8n/jobs/abholbereit` liefert
die Liste, `POST /api/n8n/jobs/:id/abholung-bestaetigen` setzt den Job auf
`abgeholt` und löscht PDF/Thumbnail vom Portal-Server (die Ablage
übernimmt ab hier n8n). Der nächtliche `pdf-bereinigung`-Job setzt jeden
`abgeholt`-Job, dessen Dateien tatsächlich weg sind, endgültig auf
`archiviert` (siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md)).

## "Stalled Jobs" — blockierte Rechnungen

Ein Job "hängt", wenn die für den nächsten Schritt zuständige Person
deaktiviert wurde oder in ChurchTools nicht mehr auflösbar ist (erkannt
vom nächtlichen Personen-Sync). **Admin → Personen-Sync** listet solche
Jobs mit einer Force-Freigeben-Funktion — siehe
[personen-sync.md](personen-sync.md#stalled-jobs).
