# Baut golive.html (Go-Live-Checkliste) im Stil des Test-Runbooks.
import html, pathlib, re

HIER = pathlib.Path(__file__).parent

def esc(t):
    t = html.escape(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"`(.+?)`", r"<code>\1</code>", t)
    return t

# (Abschnitt, Einleitung, [(Punkt, Detail/Wo, Wer)])
TEILE = [
 ("1 · Vor dem Aufspielen: Daten und Server", "Das grösste Risiko ist Datenverlust beim Deploy. Diese Punkte zuerst.", [
  ("Aktuelle Sicherung ziehen und **ausserhalb** des Servers ablegen.", "Admin → Betrieb → Datenbank-Backup → Sicherung erstellen, `.fpbak` herunterladen. Schlüsselbund getrennt aufbewahren.", "Du"),
  ("**Dauerhafter Speicher (O1):** `DB_PATH`, `JOBS_DIR`, `BACKUP_DIR`, `BRANDING_DIR` liegen nicht im Deploy-Ordner.", "Infomaniak Manager → Site → Umgebungsvariablen. Ohne Angabe gilt `./data/…` im Programmordner, der beim Deploy ersetzt werden kann.", "Du"),
  ("**Node.js mindestens 22.23.4** eingestellt (N1).", "Infomaniak Manager → Node-Version. Nach dem Start in der Konsole `node -v` prüfen.", "Du"),
  ("`NODE_ENV=production` gesetzt.", "Umgebungsvariablen. Ohne den Wert läuft Express im Entwicklungsmodus (langsamer, ausführlichere Fehler).", "Du"),
  ("`PUBLIC_BASE_URL` beginnt mit `https://`, `CT_REDIRECT_URI` passt dazu (O4).", "Sonst wird das Anmelde-Cookie nicht als «Secure» markiert.", "Du"),
  ("Auto-Neustart bei Absturz aktiv (O2), genau **ein** Proxy vor der App (O3), Host-Zeitzone UTC (O5), Logrotation (O6).", "Bei Infomaniak nachfragen bzw. im Manager prüfen.", "Du"),
  ("`BACKUP_KEYRING_FILE` gesetzt, Datei lesbar, Kopie sicher und getrennt verwahrt.", "Ohne Schlüsselbund schlagen Sicherungen fehl, ohne Kopie sind Sicherungen wertlos.", "Du"),
  ("Zeitstempel: `TSA_TRUST_ANCHORS_FILE`, `TSA_TRUST_ANCHORS_SHA256`, `TSA_CRL_FILE`, `TSA_CRL_AUTO_UPDATE=true` — oder bewusst ohne Zeitstempel starten.", "Einmalig `npm run tsa:crl-update` für die Sperrlisten. Siehe docs/tsa-vertrauensanker.md.", "Du"),
 ]),
 ("2 · Geheimnisse", "Nur Namen, keine Werte. Jedes Pflicht-Geheimnis hat mindestens 32 zufällige Zeichen, stammt nicht aus `.env.example` und lag nie in Chat, Mail oder Screenshot.", [
  ("`SESSION_SECRET`", "Wechsel meldet alle ab, sonst ohne Folgen.", "Du"),
  ("`DOWNLOAD_SIGNING_SECRET`", "Wechsel lässt alte PDF-Links verfallen.", "Du"),
  ("`CT_CLIENT_SECRET`, `CT_SYNC_SERVICE_TOKEN`", "Gleichzeitig in ChurchTools nachführen.", "Du"),
  ("`CRON_SECRET`, `N8N_API_KEY`, `BACKUP_API_KEY` (optional, muss sich von `N8N_API_KEY` unterscheiden)", "Gleichzeitig in n8n nachführen.", "Du"),
  ("`SMTP_USER` / `SMTP_PASS`", "Bei Verdacht beim Mail-Anbieter erneuern.", "Du"),
  ("TSA-Zugang (falls verlangt) nur mit `https://`-Adresse; Überwachungsschlüssel im Portal gesetzt.", "Admin → Zeitstempel bzw. Admin → Betrieb → Status.", "Du"),
 ]),
 ("3 · Aufspielen", "Der lokale Stand ist 20 Commits weiter als GitHub: Auswertung und Budgets, strengere Sicherheitsrichtlinie (CSP), Korrekturen der Prüfung vom 7. November.", [
  ("`master` nach GitHub pushen.", "Enthält u. a. die neue Abhängigkeit `read-excel-file` und `qs` 6.16.1.", "Du"),
  ("Infomaniak holt den Stand, **`npm install`** läuft, App startet neu.", "Build-Kommando `npm install`, Start `npm start`. Nur **ein** Prozess pro `DB_PATH` (Prozesssperre).", "Du"),
  ("App startet ohne Fehler; Datenbank-Migrationen sind durch.", "Log prüfen. Bleibt eine alte Sperre `<DB_PATH>.process-lock` nach einem harten Abbruch liegen: docs/offline-restore.md.", "Du"),
 ]),
 ("4 · Direkt nach dem Aufspielen: technische Prüfung", "Erst wenn alles grün ist, mit Testenden starten.", [
  ("`GET /healthz` antwortet `{\"status\":\"ok\"}`; mit Header `X-Monitoring-Key` alle Dienste ok.", "Schlüssel unter Admin → Betrieb → Status.", "Du"),
  ("Aussenprüfung: `PRUEF_ZIEL_URL=<live> node scripts/pruefung/aussen.mjs`.", "Prüft Header (HSTS, CSP mit Nonce, Permissions-Policy, COOP/CORP, kein X-Powered-By), kaputtes JSON → 400, geschützte Seiten → 401/403. Die Live-Adresse nie ins Repo schreiben.", "Du"),
  ("TLS 1.0/1.1 werden abgelehnt (N2).", "SSL Labs oder `openssl s_client -tls1_1 -connect <Host>:443` muss scheitern.", "Du"),
  ("Login-Roundtrip als Superadmin, `/admin` erreichbar.", "Die Person muss vorher in ChurchTools in der Superadmin-Gruppe sein.", "Du"),
  ("Admin → **Ersteinrichtung**: alle 8 Pflichtschritte erledigt, Abschnitt **Go-Live-Prüfung** grün.", "Status ohne Fehler, Testmail zugestellt, Sicherung jünger als 7 Tage.", "Du"),
  ("Admin → Betrieb → **Status**: alles grün.", "Speicher, Mail-Stau, ChurchTools-Abgleich, Zeitstempel, Sicherung.", "Du"),
  ("Geplante Jobs einmal von Hand auslösen und Erfolg prüfen.", "Admin → Betrieb → Geplante Jobs → «Jetzt ausführen» (oder `POST /internal/cron/<job>` mit `X-Cron-Secret`).", "Du"),
  ("Sicherung auslösen und offline mit `npm run backup:verify` prüfen.", "Ohne geprüfte Wiederherstellung gilt eine Sicherung nicht als Sicherung.", "Du"),
  ("Testmail: Admin → Betrieb → Mail-Protokoll zeigt `versendet`.", "Nicht `eingereiht` oder `fehlgeschlagen`.", "Du"),
  ("Uptime Kuma (o. ä.) **mit** Überwachungsschlüssel auf `/healthz` (O7).", "Siehe docs/statusseite-und-monitoring.md.", "Du"),
 ]),
 ("5 · n8n", "Die Schnittstelle hat seit dem letzten Live-Stand neue Anforderungen.", [
  ("Rechnungseingang: n8n behandelt die Antwort **422** (PDF vom Portal abgewiesen, z. B. passwortgeschützt oder beschädigt).", "Abweisung sichtbar machen statt endlos wiederholen.", "Du"),
  ("Neuer Zweig für **Rapporte**: `/api/n8n/rapporte` holt abgeschlossene Rapporte ab und archiviert sie **nur in Paperless** (kein Bexio).", "Siehe docs/n8n-schnittstelle.md. Rapporte erscheinen nie unter `/api/n8n/jobs`.", "Du"),
  ("Kreditkarten-Beleg-Postfach → `/api/n8n/kk-belege` (falls genutzt).", "", "Du"),
  ("Backup-Abholung mit eigenem `BACKUP_API_KEY` (falls genutzt).", "Liefert `.fpbak`.", "Du"),
  ("**Während des Abnahmetests**: Export nach Bexio und Paperless pausieren oder auf ein Testziel umleiten.", "Sonst entstehen echte Buchungen oder Zahlungen aus Testbelegen.", "Du"),
 ]),
 ("6 · Fachliche Einrichtung", "Was das Portal für den echten Betrieb braucht. Vieles zeigt der Assistent unter Admin → Ersteinrichtung an.", [
  ("ChurchTools-Gruppen: Buchhaltung, Superadmin, optional Manager — richtige Personen drin.", "Rollen kommen aus der Gruppenmitgliedschaft (Sync nachts oder beim Login).", "Du"),
  ("Konten mit Freigeber 1/2 und Stellvertretungen angelegt (vier verschiedene, aktive Personen).", "Admin → Stammdaten → Konten.", "Du"),
  ("Kreditoren mit hinterlegten IBANs, Zuweisungsregeln für feste Absender.", "Zahlungsart je Kreditor; bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht (Grundlage der IBAN-Betrugserkennung). Neue IBANs nur aus unabhängiger Quelle.", "Du"),
  ("Kreditkarten mit verantwortlicher Person und Erfassern (falls Modul genutzt).", "Admin → Stammdaten → Kreditkarten.", "Du"),
  ("**Budgets** 2026/2027 erfassen oder aus der Excel-Liste importieren.", "Admin → Stammdaten → Budgets → «Aus Excel oder CSV importieren» mit Vorschau.", "Kassier"),
  ("**Rechte vergeben**: «Auswertung einsehen (alle Konten)» für Kassier und Vorstand, «Budgets verwalten» für den Kassier; weitere Einzelrechte nach Bedarf (Vorgänge einsehen, Pool zuweisen …).", "Admin → Stammdaten → Personen → Berechtigungen.", "Superadmin"),
  ("Module bewusst einstellen: Spesen, Kreditkarten, **Rapporte**, strikte Freigeber1-Prüfung, Schwelle «länger offen» für die Auswertung.", "Admin → Einstellungen → Module.", "Superadmin"),
  ("Zeiten für Erinnerung und Eskalation in Pool, Freigabe 2 und Rapporte (Betriebswerte, nicht die kurzen Testwerte).", "Admin → Einstellungen → Benachrichtigungen.", "Superadmin"),
  ("Mail-Texte, Standard-Benachrichtigung (sofort oder täglich gebündelt), Zusatzempfänger bei «Auffälligkeiten bei Kontierung», Sync-Fehler und Audit-Prüfnummer.", "Admin → Einstellungen → Benachrichtigungen.", "Superadmin"),
  ("Erscheinungsbild: Seitentitel, Logo hell/dunkel, Farben.", "Admin → Einstellungen → Erscheinungsbild.", "Superadmin"),
  ("Kontakt-E-Mail und Datenschutztext für die Nutzungsdaten; optional ein Start-Banner.", "Admin → Betrieb → Betrieb & Nutzung → Datenschutz / Banner.", "Superadmin"),
  ("Zeitstempeldienst eingerichtet und Probe erfolgreich (oder bewusst darauf verzichtet).", "Admin → Einstellungen → Zeitstempel.", "Superadmin"),
  ("Audit-Nachweis für die Revision: Empfänger und Versandtag der Prüfnummer.", "Admin → Einstellungen → Zeitstempel (Abschnitt Audit-Nachweis), Prüfseite `/audit-pruefen`.", "Superadmin"),
 ]),
 ("7 · Abnahmetest", "Mit dem Test-Runbook (Stand 7. November 2026, 46 Szenarien).", [
  ("Vorbereitung laut Runbook Seite 2–4 erledigt (Testkonten T1–T4, Testlieferanten, Test-Visa, Module, Rechte für A).", "", "Testleitung"),
  ("Alle 46 Szenarien durchgeführt oder bewusst ausgelassen.", "", "Testleitung"),
  ("Keine offenen Fehler der Schwere 1.", "Fehlerprotokoll und Admin → Betrieb → Meldungen.", "Testleitung"),
  ("Mindestens ein Ablauf je Person auf echtem Handy/Tablet (PDF-Vorschau, Kamera-Upload, Dunkelmodus).", "", "alle"),
  ("Manuelle Sichtprüfung der neuen Seiten: Auswertung, Budgets, Budget-Import, Rapporte, Audit-Log mit mehreren Seiten.", "Diese Seiten wurden bisher nur automatisch geprüft.", "Testleitung"),
 ]),
 ("8 · Umschalten auf den echten Betrieb", "Nach dem Test, vor der Bekanntgabe.", [
  ("Testdaten: entweder im System lassen (klar als TEST erkennbar, bleiben im Audit-Log) **oder** vor dem Start mit leerem Datenstand neu einrichten.", "Abgeschlossene Vorgänge und Audit-Log sind bewusst nicht löschbar.", "Du"),
  ("Testkonten, Testlieferanten und Test-Kreditkarte deaktivieren; Test-Budgets leeren; Test-Rechte entfernen.", "", "Superadmin"),
  ("Benachrichtigungen (Zeiten, Empfänger, Texte) und Module auf Betriebswerte.", "", "Superadmin"),
  ("n8n-Export nach Bexio/Paperless wieder einschalten — erst wenn keine Testvorgänge mehr abholbereit sind.", "", "Du"),
  ("Frische Sicherung nach dem Aufräumen ziehen und extern ablegen.", "", "Du"),
  ("Benutzerinnen und Benutzer informieren (Adresse, Anmeldung mit ChurchTools, «Problem melden»); optional Banner.", "", "Du"),
 ]),
 ("9 · Erste Woche", "Täglich kurz hinschauen, danach wöchentlich.", [
  ("Status-Seite grün, keine Sicherheitsalarme.", "Admin → Betrieb → Status.", "Superadmin"),
  ("Neueste Sicherung jünger als 24 Stunden.", "Verpasste Termine nach einem Neustart werden nicht nachgeholt — dann von Hand auslösen.", "Superadmin"),
  ("Mail-Protokoll ohne `fehlgeschlagen`, ChurchTools-Abgleich erfolgreich.", "Admin → Betrieb → Mail-Protokoll / Sync-Übersicht.", "Superadmin"),
  ("Meldungen aus «Problem melden» und Fehlerliste durchgehen.", "Admin → Betrieb → Betrieb & Nutzung.", "Superadmin"),
  ("Erste echte Exporte in Bexio und Paperless stichprobenartig kontrollieren.", "", "Kassier"),
 ]),
]

def teil_html(titel, intro, punkte):
    rows = "".join(
        f'<tr><td><span class="box"></span></td><td>{esc(p)}{f"<div class=\'wo\'>{esc(d)}</div>" if d else ""}</td><td class="werspalte">{esc(w)}</td></tr>'
        for p, d, w in punkte)
    return f'''
<section class="teil">
  <h2>{esc(titel)}</h2>
  <p class="bdesc">{esc(intro)}</p>
  <table class="grid check"><thead><tr><th></th><th>Punkt</th><th>Wer</th></tr></thead><tbody>{rows}</tbody></table>
</section>'''

css = (HIER / "style.css").read_text()
extra = """
.teil { break-inside: auto; margin-bottom: 8mm; }
.teil h2 { margin-top: 0; }
table.check td .wo { color: #57606a; font-size: 8.5pt; margin-top: 1mm; }
table.check td.werspalte { white-space: nowrap; color: #57606a; font-size: 9pt; width: 22mm; }
table.check tr { break-inside: avoid; }
"""
anzahl = sum(len(t[2]) for t in TEILE)
body = "\n".join(teil_html(*t) for t in TEILE)
doc = f'''<!doctype html>
<html lang="de-CH"><head><meta charset="utf-8"><title>Go-Live-Checkliste Freigabeportal</title>
<style>{css}{extra}</style></head>
<body>
<section class="cover">
  <div class="kicker">Freigabeportal · Stand 7. November 2026</div>
  <h1>Go-Live-Checkliste</h1>
  <p class="lead">Alles, was zwischen dem aktuellen Entwicklungsstand und dem echten Betrieb erledigt sein muss — in der Reihenfolge, in der du es abarbeitest.</p>
  <table class="kv">
    <tr><th>Live-Adresse</th><td class="fill"></td></tr>
    <tr><th>Datum Aufspielen</th><td class="fill"></td></tr>
    <tr><th>Datum Abnahmetest</th><td class="fill"></td></tr>
    <tr><th>Start echter Betrieb</th><td class="fill"></td></tr>
    <tr><th>Umfang</th><td>{anzahl} Punkte in {len(TEILE)} Abschnitten</td></tr>
  </table>
  <div class="howto">
    <h4>Stand der Entwicklung</h4>
    <ol>
      <li>Alle bestellten Funktionen sind fertig und lokal auf <b>master</b> zusammengeführt: 2518 automatische Tests, 36 Browsertests, Responsive-Prüfung ohne Verstösse, <code>npm audit</code> ohne Befund.</li>
      <li>Sicherheitsprüfung des ganzen Codes am 7. November: keine kritische oder schwere Lücke.</li>
      <li>Offen sind nur Schritte auf deiner Seite (Server, Geheimnisse, n8n, Einrichtung) und der Abnahmetest mit Menschen.</li>
    </ol>
  </div>
</section>
<section class="page">
{body}
  <h2>Freigabe</h2>
  <table class="grid sign">
    <tbody>
      <tr><td>Alle Punkte erledigt oder bewusst ausgelassen</td><td><span class="box"></span> ja &nbsp;&nbsp; <span class="box"></span> offen: <span class="fill inline"></span></td></tr>
      <tr><td>Abnahmetest bestanden</td><td><span class="box"></span> ja &nbsp;&nbsp; <span class="box"></span> nach Behebung</td></tr>
      <tr><td>Start freigegeben</td><td>Datum, Unterschrift: <span class="fill inline"></span></td></tr>
    </tbody>
  </table>
</section>
</body></html>'''
(HIER / "golive.html").write_text(doc)
print("ok", anzahl, "Punkte")
