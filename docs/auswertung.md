# Auswertung Rechnungen und Budgets

Die Seite **Auswertung** (`/auswertung`) zeigt Kassier, Vorstand und Budgetverantwortlichen,
wohin das Geld geht, ob die Konten im Budget bleiben und wo Rechnungen hängen bleiben. Sie ist
für den Desktop gebaut; auf dem Handy funktioniert sie über das normale Seitenlayout.

Code: `src/services/auswertung.js` (Berechnungen), `src/routes/auswertung.js` (Seite und
Export), `src/routes/admin/budgets.js` + `src/services/budgetImport.js` (Budgets pflegen und
importieren), `src/db/budgetRepo.js` (Tabelle `konto_budgets`).

## Wer sieht was

| Person | Zugang |
|---|---|
| Recht `auswertung_einsehen` («Auswertung einsehen (alle Konten)»), `superadmin`, `manager` | alle aktiven Konten, alle Abschnitte inkl. «Wo Rechnungen liegen» |
| Freigeber 1 oder Stellvertreter 1 mindestens eines aktiven Kontos | nur diese Konten; ohne «Wo Rechnungen liegen»; Lieferanten nur aus den eigenen Konten |
| alle anderen | kein Zugang (403), kein Menüpunkt |

Der Konto-Filter (`?konto=<Kontonummer>`) wird mit den erlaubten Konten geschnitten. Ein fremdes
Konto ergibt 403 «Für dieses Konto hast du keine Auswertung.» und wird als
Zugriffsverweigerung (`objekt_verweigert`) protokolliert. Dasselbe gilt für den CSV-Export.

In «Wo Rechnungen liegen» ist der Name nur für Personen mit `vorgaenge_einsehen` ein Link auf
**Admin → Laufende Vorgänge** (`/admin/vorgaenge?person=<id>`).

## Abschnitte

1. **Kennzahlen:** freigegeben (Betrag, Anzahl), zurzeit in Freigabe (Betrag, Anzahl),
   Durchlaufzeit Median (Eingang bis Freigabe 2), Anzahl länger als N Tage offen (+ älteste).
   N stellt der Superadmin unter **Admin → Module** ein (`auswertung_offen_schwelle_tage`,
   Standard 14, erlaubt 1–365).
2. **Budget pro Konto:** Budget, freigegeben, in Freigabe, Ausschöpfung als Balken,
   Markierung «über Budget», budgetverantwortliche Person (Freigeber 1).
3. **Durchlaufzeit pro Stufe:** Pool, Kontierung & Freigabe 1, Freigabe 2 — Median und
   «langsamste 10 %» (90. Perzentil).
4. **Wo Rechnungen liegen:** offene Rechnungen pro zuständiger Person und Stufe (inkl. «Pool»
   und «Admin-Gruppe»), älteste zuerst.
5. **Lieferanten:** Anzahl, Betrag, Anteil und die zwei Konten mit dem grössten Betrag, nach
   Betrag sortiert.

## Zählregeln

Die Regeln stehen auch unten auf der Seite.

- **Zeitraum:** «Laufendes Jahr bis heute» (Standard), «Letzte 12 Monate» (heute − 365 Tage),
  «Vorjahr» oder «Eigener Zeitraum» (Von ≤ Bis, höchstens 5 Jahre). Massgebend ist das
  **Zürcher Datum** von `abgeschlossen_am` (Freigabe 2). Ungültige Angaben zeigen eine Meldung
  und den Standard-Zeitraum. Wer ein Datum ändert, stellt die Auswahl automatisch auf «Eigener
  Zeitraum»; eine Voreinstellung zu wählen füllt Von/Bis passend aus.
- **Freigegeben** = Status `abgeschlossen`, `abgeholt` oder `archiviert`.
- **In Freigabe** = aktueller Stand `zugewiesen` oder `freigabe2`; in der Kennzahl und bei
  «länger offen» zählen auch Belege im Pool (`unzugewiesen`, Konto noch unbekannt), in der
  Budget-Tabelle nicht. «Länger offen» misst ab `eingang_am`, «länger als N» heisst > N ganze
  Tage.
- **Gutschriften** (`typ = 'gutschrift'`) werden abgezogen.
- **Zählen nie:** `abgelehnt`, `geloescht`, aufgesplittete Eltern (`aufgesplittet`, auch
  Kreditkarten-Abrechnungen) und **Rapporte** (`typ = 'rapport'`). Die Teile einer Splitgruppe
  bzw. einer Kreditkarten-Abrechnung zählen je auf ihrem Konto. Spesen zählen mit.
- **Beträge:** `jobs.betrag` als Zahl; ohne Betrag zählt 0 (Hinweis «N Rechnungen ohne
  Betrag»). Rechnungen mit QR-Währung EUR werden nicht umgerechnet (Hinweis).
- **Budget-Jahr** = Kalenderjahr des Zeitraum-Endes. Die Budget-Tabelle zählt «freigegeben» nur
  innerhalb dieses Jahres (Schnitt mit dem Zeitraum), damit die Ausschöpfung zum Jahresbudget
  passt. Geht der Zeitraum über mehrere Jahre, sagt die Seite das.
- **Ausschöpfung** = (freigegeben + in Freigabe) / Budget; «über Budget», sobald diese Summe
  das Budget übersteigt. Ohne Budget steht «kein Budget» (keine Division). Eine Warnung beim
  Kontieren gibt es bewusst nicht.

## Durchlaufzeit

Nur Rechnungen, die im Zeitraum freigegeben wurden; Kalendertage mit einer Nachkommastelle.

- **Pool:** `eingang_am` bis zum ersten Verlassen von `unzugewiesen` — frühester Zeitpunkt aus
  dem Audit-Log (`jobs`-UPDATE von `unzugewiesen` auf etwas anderes) und dem
  `freigaben`-Eintrag `pool_zuweisung`. Direkt zugewiesene Rechnungen haben 0.
- **Kontierung & Freigabe 1:** Pool-Ende bis zum letzten `freigaben`-Eintrag `freigeber1`.
- **Freigabe 2:** dieser Zeitpunkt bis `abgeschlossen_am`. Fehlt ein `freigeber1`-Eintrag
  (Altfälle), entfällt die Stufe Freigabe 1 und Freigabe 2 misst ab Pool-Ende.
- **Median:** bei gerader Anzahl Mittelwert der beiden mittleren Werte. **Langsamste 10 %:**
  90. Perzentil nach Nearest-Rank (das ⌈0.9·n⌉-te Element).

«Wo Rechnungen liegen» nimmt die Zuständigkeit aus `ermittleZustaendigkeit`
(`src/services/vorgangZustaendigkeit.js`), also dieselbe Person wie **Laufende Vorgänge**.
Stufen: Pool, Kontierung & Freigabe 1, Spesen-Freigabe 1, Freigabe 2, Überarbeitung
(abgelehnt). Das Alter zählt seit Eintritt in die aktuelle Stufe: bei Freigabe 2
`freigabe2_seit`, sonst der letzte Audit-Eintrag, mit dem Status oder zuständige Person auf den
heutigen Wert wechselten; ohne solchen Eintrag `eingang_am`.

## Export

Jeder Abschnitt hat einen Link «CSV exportieren»:
`GET /auswertung/export/<abschnitt>.csv` mit `abschnitt` ∈ `budget`, `durchlauf`,
`engpaesse`, `lieferanten` und denselben Filtern wie die Seite. Format: Semikolon, UTF-8 mit
BOM (öffnet direkt in Excel), Dezimalpunkt, Dateiname
`auswertung-<abschnitt>-<von>-<bis>.csv`. Zellen, die mit `=`, `+`, `-` oder `@` beginnen
(ausser Zahlen), bekommen ein führendes Apostroph, damit Excel sie nicht als Formel ausführt.
`engpaesse` gibt es nur für Personen, die den Abschnitt auch sehen.

## Budgets pflegen

**Admin → Stammdaten → Budgets** (`/admin/budgets`, Recht `budgets_verwalten`, «Budgets
verwalten»; `superadmin`/`manager` über ihr Bundle). Ein Betrag pro aktivem Konto und
Kalenderjahr; als Hinweis steht das Vorjahresbudget darunter. Leeres Feld = kein Budget.
Beträge dürfen Schweizer Schreibweise haben (`12'000.–`, `12 000,50`, `CHF 1500`). Ist ein
Feld ungültig, wird nichts gespeichert (400, Feld markiert). Jede Änderung landet über den
Audit-Trigger im Audit-Log (`objekt = 'konto_budgets'`).

### Import aus Excel oder CSV

Unten auf der Budgets-Seite: Jahr wählen, Datei hochladen (`.xlsx` erstes Blatt, oder `.csv`
mit `;` oder `,`, UTF-8 mit oder ohne BOM; höchstens 2 MB und 2000 Zeilen).

1. `POST /admin/budgets/import` liest die Datei und zeigt eine **Vorschau**. Die Tabelle liegt
   15 Minuten in der Session, nicht im Formular.
2. In der Vorschau lassen sich Spalte Kontonummer, Spalte Betrag und «erste Zeile ist eine
   Kopfzeile» umstellen (`GET /admin/budgets/import/vorschau`). Standard: erste Spalte Konto,
   zweite Betrag, Kopfzeile, wenn die Betragszelle der ersten Zeile keine Zahl ist.
3. Die Vorschau zeigt bisherigen und neuen Betrag sowie alle Zeilen, die nicht übernommen
   werden (leer, unbekannte oder inaktive Kontonummer, ungültiger Betrag, Konto mehrfach — die
   erste Zeile zählt).
4. Erst `POST /admin/budgets/import/bestaetigen` speichert die gültigen Zeilen für das gewählte
   Jahr (eine Transaktion) und leert die Vorschau. Eine abgelaufene Vorschau speichert nichts.

Für `.xlsx` nutzt das Portal die Bibliothek `read-excel-file` (exakte Version in
`package.json`).
