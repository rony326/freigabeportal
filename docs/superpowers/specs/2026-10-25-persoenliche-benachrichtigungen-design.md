# Persönliche Benachrichtigungen — Design

Stand: 2026-10-25. Status: Entwurf, zur Freigabe.
Teil 5 des Backlogs vor dem Launch.

## Absicht und Warum

Heute gilt eine einzige Einstellung für alle: Mails sofort oder einmal täglich gebündelt
(`mail_batching_aktiv`, Digest-Job `mail-digest`), Sicherheits-Mails immer sofort. Personen sollen
selbst wählen können, ob sie **sofort**, **täglich** oder **wöchentlich** gebündelt informiert
werden.

## Ziele

1. Seite **"Meine Benachrichtigungen"** (Seitenleiste → Persönlich) mit Auswahl sofort / täglich /
   wöchentlich.
2. Admin legt den **Standard** für alle ohne eigene Wahl fest (ersetzt das heutige globale
   sofort/gebündelt, bestehende Installationen behalten ihr Verhalten: `mail_batching_aktiv = 1`
   → Standard "täglich", sonst "sofort").
3. **Wöchentlicher Versand** für alle gemeinsam an einem einstellbaren Wochentag und einer Uhrzeit
   (Standard Montag 07:00); täglicher Versand wie heute zur eingestellten Uhrzeit.
4. **Immer sofort**, unabhängig von der Wahl: Sicherheitswarnungen, IBAN-Abweichungen, neues
   Gerät, Fehlermeldungen an Admins, Sync-Fehler, Admin-Umhängen, Audit-Prüfnummer (bestehende
   `IMMER_SOFORT_TYPEN` bleiben die Grundlage) **sowie Erinnerungen und Eskalationen**.
5. **Hinweis** auf der Seite, wenn die gewählte Bündelung länger ist als die kürzeste für die
   Person relevante Eskalationsfrist ("Bei wöchentlicher Bündelung siehst du neue Aufgaben
   eventuell erst nach der Erinnerung — Erinnerungen kommen trotzdem sofort.").

## Nicht-Ziele

- Keine Auswahl pro Mail-Typ (nur eine Einstellung pro Person).
- Keine anderen Kanäle (Push, SMS, Signal).
- Keine Änderung an Inhalten/Vorlagen der Einzelmails.

## Anti-Ziele

- Eine dringende Mail (Sicherheit, Eskalation) wartet wegen der Bündelung.
- Eine Mail geht verloren, wenn jemand die Einstellung wechselt (bereits geplante Mails werden
  beim nächsten passenden Lauf mitgeschickt; Wechsel auf "sofort" schickt Geplantes sofort).
- Doppelte Zustellung derselben Mail in Digest und Einzelmail.

## Vom Nutzer entschieden

1. Persönlich einstellbar **sofort / täglich / wöchentlich**.
2. Admin-Standard, gemeinsamer Wochentag/Uhrzeit, immer-sofort-Ausnahmen bleiben.
3. **Erinnerungen und Eskalationen immer sofort**; Hinweis, wenn die Bündelung länger dauert als
   die Eskalationsfrist.

## Entscheidungen des Entwurfs (meine Calls)

1. Speicherung: Spalte `personen.benachrichtigung` (`'sofort'|'taeglich'|'woechentlich'|NULL`
   = Standard); Änderung im Audit (personen ist bereits auditiert).
2. Digest-Job erweitert statt neuer Job: der bestehende `mail-digest`-Lauf verschickt täglich an
   alle "täglich"-Empfänger und am eingestellten Wochentag zusätzlich an "wöchentlich"-Empfänger.
   Config neu: `mail_digest_wochentag` (1 = Montag … 7 = Sonntag, Standard 1); bestehende Stunde/
   Minute gelten für beide.
3. Neue Mail-Typen aus dem Backlog (`kommentar`) folgen der persönlichen Wahl; die Typen
   `reminder`, `eskalation`, `freigabe2-reminder`, `freigabe2-eskalation`, `kk-beleg-erinnerung`
   kommen in die Immer-sofort-Liste.
4. Mail-Adresse ohne Login: Personen, die sich nie angemeldet haben, bekommen den Standard.
5. Digest-Mail nennt oben "Deine wöchentliche Zusammenfassung (Einstellung ändern: Link)".
6. **Responsive**.

## Einschränkungen

- Bestehende Outbox (`mail_log` Status `geplant`), Digest-Job, Mail-Vorlage `digest`, Admin →
  Mail-Einstellungen (dort wird aus dem Schalter die Standard-Auswahl).

## Dem Builder überlassen

- Darstellung der Seite, Text des Hinweises.
- Migration der bestehenden Einstellung.
- Tests: Zuordnung pro Person/Standard, Wochentag-Logik (Zürcher Datum), Immer-sofort-Typen,
  Wechsel der Einstellung mit geplanten Mails, keine Doppelzustellung, Hinweis bei Eskalations-
  frist.
