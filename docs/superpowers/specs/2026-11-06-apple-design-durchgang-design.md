# Apple-Design-Durchgang — Design

Stand 2026-11-06. Grundlage: Durchsicht des Portals mit dem Skill `apple-design` (WWDC *Designing Fluid
Interfaces*, *Principles of Great Design*, *Details of UI Typography*). Vom Nutzer freigegeben: alle 14
Vorschläge umsetzen.

## Leitlinie

Das Portal ist ein Arbeitswerkzeug für Freigaben und Geld: ruhig, verlässlich, sofortige Rückmeldung.
**Keine** Federanimationen, Wischgesten, Schwung-Projektion oder Effekte ohne Zweck. Bewegung nur, wo sie
Herkunft oder Zustand erklärt, immer mit `prefers-reduced-motion`-Fallback.

## Die 14 Punkte

### A. Rückmeldung und Sicherheit

1. **Sendestatus.** Jeder POST-Knopf zeigt nach dem Klick sofort, dass gesendet wird (Spinner + `aria-busy`),
   ein zweiter Klick sendet nicht nochmals. Gilt auch für fetch-Knöpfe (Beanspruchen, Senden, Lieferant
   anlegen). *Warum:* Response ist die Grundlage; Doppelklick bei Freigaben hat Folgen.
2. **Fehler am Feld.** Kontierung, Freigabe 2, Spesen-Freigabe 1: Serverfehler erscheinen am betroffenen
   Feld (`is-invalid`, Text darunter, `aria-describedby`), oben bleibt eine kurze Liste mit Sprunglinks.
   Begründung wird erst Pflicht (Markierung + `required`), wenn "Interessenskonflikt" gewählt ist.
   *Warum:* "Validate inline" — zeigen, wo das Problem ist.
3. **Ablehnen mit Rückfrage.** Ablehnen öffnet einen Dialog, der die Begründung direkt abfragt und mit
   rotem Knopf bestätigt. Ohne JS bleibt der heutige direkte Submit. "In den Pool legen" aus der
   Aufgabenliste öffnet denselben Hinweis-Dialog wie auf der Kontierungsseite. *Warum:* Agency/Forgiveness;
   Gleiches verhält sich gleich.
4. **Keine Browser-Popups.** `alert()`/`confirm()` werden durch Meldungen am Ort bzw. einen gemeinsamen
   Bootstrap-Bestätigungsdialog ersetzt. Zuweisen im Pool ersetzt die Zeile/Kachel durch "An … gesendet ✓"
   statt die Seite neu zu laden.

### B. Hierarchie und Klarheit

5. **Kontierung:** "Kontieren" (primär, normale Grösse) und "Ablehnen" sichtbar; "Zurück in den Pool",
   "An Gruppe zurücksenden", "Rechnung aufsplitten" und "Kreditkartenabrechnung" unter "Weitere Aktionen ▾".
6. **Freigabe 2:** Entscheidungsblock oben (Betrag gross, Lieferant, Konto, Typ), Details als zweispaltige
   Liste; IBAN-Abweichung farbig hervorgehoben.
7. **Aufgabenliste:** Anzahl je Abschnitt in der Überschrift; Spalte/Angabe "Betrag" in Tabelle und Kachel.
   (Der Überfällig-Text existiert in Laufende Vorgänge bereits als Badge — nichts zu tun.)
8. **Begriffe und Schreibweise:** "Lieferant" in Portal-Ansichten (Tabelle sagte "Kreditor"; der
   Admin-Bereich bleibt "Kreditoren", siehe `docs/kreditoren-statt-debitoren.md`); überall "Schliessen";
   echte Umlaute in sichtbaren Texten; doppelte "Vorgangsnummer" auf Kontierung/Aufsplitten entfällt.

### C. Gestaltung

9. **Symbole:** einheitliches SVG-Set (Bootstrap Icons, lokal als Sprite), ein eindeutiges Symbol je
   Navigationspunkt, auch Kopf (Menü, Farbmodus, Neu laden) und Ansichtswahl.
10. **Farbmodus-Menü** Hell / Dunkel / System; "System" überschreibt auch einen Admin-Standard; kurzer
    Farbübergang beim Wechsel (nicht bei reduzierter Bewegung).
11. **Klebende Kopfzeile ab 992 px**, leicht durchscheinend (`backdrop-filter`), Fallback für
    `prefers-reduced-transparency` und `prefers-contrast: more`; Seitenleiste klebt darunter.
12. **PDF-Rahmen** feiner Rand + Schatten statt 2 px Schwarz; globale Regel `button { border-color }` entfällt.
13. **Typografie:** Seitentitel 600 / `-0.01em`; Beträge, Belegnummern und Zeitpunkte mit `tabular-nums`.
14. **Antippen und Kacheln:** Knöpfe auf Touch-Geräten minimal gedrückt (`scale(.97)`, 100 ms); Kacheln
    mit einer einzigen Hauptaktion sind als Ganzes anklickbar (Hover-Zustand); die PDF-Vorschau im Pool
    öffnet sich aus dem Vorschaubild heraus. Alles unter `prefers-reduced-motion` ohne Bewegung.

## Nicht-Ziele

Federn, Gesten, Schwung, Sound/Haptik, neue Seiten, Änderungen an Rechten oder Workflow-Logik.
