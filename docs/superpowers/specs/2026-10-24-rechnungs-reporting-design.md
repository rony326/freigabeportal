# Rechnungs-Reporting — Design

Stand: 2026-10-24. Status: Entwurf, zur Freigabe.
Visueller Entwurf (Desktop, Beispieldaten): https://claude.ai/artifact/Q7JeqZcXV8ZMwL7CF4Ri9U

Teil 1 von 2. Teil 2 (Nutzungsdaten für Wartung, Weiterentwicklung und Sicherheit) bekommt einen
eigenen Entwurf.

## Absicht und Warum

Kassier und Vorstand wollen regelmässig sehen, wohin das Geld geht, ob die Konten im Budget
bleiben und wo Rechnungen hängen bleiben — um gezielt auf die Person zuzugehen und nachzufragen.
Budgetverantwortliche (in der Regel Freigeber 1) wollen ihre eigenen Konten im Blick haben. Die
Budgets liegen heute in einer Excel-Liste beim Kassier.

## Ziele

- Eine Desktop-Seite "Auswertung" mit Zeitraum- und Konto-Filter und Export (Excel/CSV):
  1. Kennzahlen: freigegebener Betrag + Anzahl, zurzeit in Freigabe (Betrag + Anzahl),
     Durchlaufzeit Median (Eingang bis Freigabe 2), Anzahl länger als N Tage offen (+ älteste).
  2. Budget pro Konto: Budget, freigegeben, in Freigabe, Ausschöpfung als Balken, Markierung
     bei Überschreitung, budgetverantwortliche Person.
  3. Durchlaufzeit pro Stufe: Pool (Eingang bis Zuweisung), Kontierung & Freigabe 1,
     Freigabe 2 — Median und langsamste 10 % (90. Perzentil).
  4. Wo Rechnungen liegen: offene Rechnungen pro zuständiger Person (inkl. "Pool" und
     "Admin-Gruppe"), Stufe, Anzahl, älteste — älteste zuerst.
  5. Lieferanten: Anzahl Rechnungen, Betrag, Anteil, häufigste Konten — nach Betrag sortiert.
- Budget pflegen: ein Betrag pro Konto und Kalenderjahr, durch den Kassier.
- Optional: Budgets aus einer Excel/CSV-Datei importieren.

## Nicht-Ziele

- Keine Warnung oder Sperre beim Kontieren/Freigeben, wenn ein Budget überschritten wird (nur
  Markierung in der Auswertung).
- Keine Budgets feiner als Konto und Jahr (Monate, Projekte).
- Keine Buchhaltung/Abgleich mit Bexio; das Portal zeigt nur, was durch das Portal lief.
- Keine Mobil-Optimierung über das hinaus, was das Shell-Layout ohnehin leistet.

## Anti-Ziele

- Ein Freigeber 1 sieht Beträge oder Personen-Engpässe fremder Konten.
- Zahlen weichen ohne Erklärung von dem ab, was eine Person in der Rechnungsliste sieht
  (Zählregeln müssen auf der Seite erklärt sein).
- Gelöschte oder abgelehnte Rechnungen zählen als Ausgabe.

## Vom Nutzer entschieden

1. Inhalte: Lieferanten, Konten mit Budget, Durchlaufzeit Eingang bis Freigabe, Engpässe pro
   Person.
2. Nutzung regelmässig; Zielgruppen Kassier/Vorstand (alles) und Budgetverantwortliche = in
   der Regel Freigeber 1 (eigene Konten).
3. Engpässe mit Namen — Zweck: auf die Person zugehen.
4. Budgets pflegt der Kassier; heute Excel; Import als Option, nicht Pflicht.
5. Desktop-Seite (nicht fürs Handy gebaut).
6. Der Desktop-Entwurf passt.

## Entscheidungen des Entwurfs (meine Calls, vom Nutzer zu prüfen)

1. **Rechte:** neues additives Recht `auswertung_einsehen` ("Auswertung einsehen (alle Konten)")
   für Kassier/Vorstand; Superadmin/Manager haben es über ihr Bundle. **Budgets pflegen** über
   neues Recht `budgets_verwalten` (Kassier). Ohne Recht: wer Freigeber 1 **oder
   Stellvertreter 1** mindestens eines aktiven Kontos ist, sieht die Seite gefiltert auf diese
   Konten — ohne den Abschnitt "Wo Rechnungen liegen" und ohne Lieferanten fremder Konten
   (Lieferanten-Tabelle nur aus eigenen Konten berechnet).
2. **Zählregeln** (auf der Seite als Fussnote):
   - Zeitraum bezieht sich auf das **Freigabedatum** (`abgeschlossen_am`) für "freigegeben",
     Budget-Ausschöpfung und Lieferanten; "in Freigabe" ist immer der aktuelle Stand.
   - Gutschriften werden **abgezogen**. Status `abgelehnt` und `geloescht` zählen nicht.
     Spesen zählen mit (sie belasten das Konto); Kreditkarten-Abrechnungs-Elternjobs zählen
     nicht, ihre Teilbelege schon. Bei Splitgruppen zählen die Teile (je Konto), nicht der
     Elternjob.
   - Beträge in CHF; Rechnungen in anderer Währung (QR-Währung EUR) werden mit ihrem
     erfassten Betrag gezählt und in einer Fussnote als "enthält N Rechnungen in EUR, nicht
     umgerechnet" ausgewiesen.
3. **Budget-Jahr** = Kalenderjahr. Bei einem Zeitraum über mehrere Jahre zeigt der
   Budget-Abschnitt das Jahr des Zeitraum-Endes und sagt das.
4. **Durchlaufzeiten** aus vorhandenen Daten: Eingang = `eingang_am`; Zuweisung = erstes
   Verlassen des Pools (aus `audit_ereignisse` der `jobs`-Statusänderung bzw.
   `freigaben`-Eintrag `pool_zuweisung`); Freigabe 1 = Zeitpunkt des letzten `freigeber1`-
   Eintrags; Freigabe 2 = `abgeschlossen_am`. Kalendertage, auf eine Nachkommastelle. Nur im
   Zeitraum abgeschlossene Rechnungen.
5. **"Länger als N Tage offen"**: N über `auswertung_offen_schwelle_tage` (Default 14) unter
   Admin → Module einstellbar.
6. **Zuständige Person** für "Wo Rechnungen liegen" aus der bestehenden
   `ermittleZustaendigkeit` (`src/services/vorgangZustaendigkeit.js`), damit die Auswertung
   und Admin → Laufende Vorgänge dieselbe Person nennen. Klick auf eine Person führt (für
   Berechtigte) zur gefilterten Liste in Admin → Laufende Vorgänge.
7. **Export**: CSV (Semikolon, UTF-8 mit BOM, öffnet direkt in Excel), ein Knopf pro Abschnitt,
   jeweils mit den aktiven Filtern.
8. **Budget-Import** (optional, eigener Schritt am Ende): CSV oder XLSX mit Spalten
   Kontonummer und Betrag (Kopfzeile frei wählbar über Zuordnung im Formular), Vorschau vor dem
   Speichern, unbekannte Kontonummern werden gemeldet, nichts wird ohne Bestätigung
   überschrieben.
9. **Navigation**: "Auswertung" in der Seitenleiste unter "Arbeit" für alle mit Zugang;
   "Budgets" unter Admin → Stammdaten für `budgets_verwalten`.
10. **Performance**: Berechnung pro Aufruf per SQL-Aggregation, kein Zwischenspeicher; bei den
    erwarteten Mengen (einige hundert Rechnungen pro Jahr) unkritisch.

## Einschränkungen

- Bestehende Muster: additive Rechte (`RIGHTS`/`GRANTABLE_BERECHTIGUNGEN`), Shell-Layout mit
  Seitenleiste, CSRF bei POST, Audit-Trigger für neue Tabellen (Budgets in die zentrale
  Liste), Mail-Typen nicht betroffen.
- Beträge sind in `jobs.betrag` als Text gespeichert (`"123.45"`); Gutschrift über
  `jobs.typ = 'gutschrift'` (Betrag positiv gespeichert).
- XLSX-Import braucht eine Bibliothek (z. B. eine kleine, gepflegte XLSX-Leser-Bibliothek);
  CSV ohne zusätzliche Abhängigkeit. Wenn eine neue Abhängigkeit nicht erwünscht ist, nur CSV.

## Dem Builder überlassen

- SQL und Aufteilung in Service-Funktionen, Darstellung der Balken (CSS, keine
  Diagramm-Bibliothek nötig).
- Genaue Texte der Fussnoten.
- Tests: Zählregeln (Gutschrift, abgelehnt, gelöscht, Split, Spesen, KK), Sichtbarkeit pro
  Rolle, Perzentil-Berechnung, Zeitraum-Grenzen (Zürcher Datum), Budget über Jahre, Import
  mit Fehlern.
