# TSA-Vertrauensanker konfigurieren

Stand: 2026-09-28. Neue Zeitstempel brauchen neben Signatur und Anfragebindung
eine gueltige Zertifikatskette zu lokal freigegebenen Root-CAs und aktuelle,
signierte lokale Sperrlisten fuer alle Zertifikate unterhalb des Roots. Ohne diese
Konfiguration scheitert der TSA-Schritt. Einzelbelege koennen fachlich freigegeben
werden, bleiben aber fuer den Export gesperrt; Gruppen werden nicht finalisiert.
Eine Deaktivierung der globalen TSA-URL hebt bereits gespeicherte Pflichten nicht auf.

## Freigabe und Installation

1. Genaue DigiCert-TSA-URL und das dazugehoerige Zertifikatsprofil festhalten.
   Der konkrete Dienst ist fuer diese Installation noch zu bestaetigen.
2. Benoetigte Root-CA ausschliesslich aus einer unabhaengig geprueften offiziellen
   Quelle beziehen. Fingerprint und Zertifikat ausserhalb der TSA-Antwort
   vergleichen; Aussteller, Zweck und Freigabe dokumentieren. Nicht einfach alle
   System-/Browser-Root-CAs verwenden. Ein passender Root allein bestaetigt nicht,
   dass der Betreiber das gewuenschte TSA-Profil ausgewaehlt hat.
3. Ein PEM-Buendel nur mit diesen selbstsignierten Root-CA-Zertifikaten im
   deploymentverwalteten Bereich ablegen. Kein Symlink. Webprozess darf es lesen,
   aber nicht bearbeiten. Nicht unter JOBS_DIR/BRANDING_DIR/BACKUP_DIR ablegen.
   Die Weboberflaeche kann keine Vertrauensanker freigeben.
4. SHA-256 der gesamten PEM-Datei bestimmen und beide Deployment-Werte setzen:

   ```sh
   sha256sum /etc/freigabeportal/tsa-roots.pem
   ```

   ```dotenv
   TSA_TRUST_ANCHORS_FILE=/etc/freigabeportal/tsa-roots.pem
   TSA_TRUST_ANCHORS_SHA256=<64-stelliger-kleingeschriebener-sha256>
   TSA_CRL_FILE=/etc/freigabeportal/tsa-crls.pem
   ```

5. Vollstaendige direkte CRLs der benoetigten Aussteller aus separat freigegebenen
   Anbieterquellen beziehen und als PEM-Buendel unter `TSA_CRL_FILE` bereitstellen.
   CRL-Signatur und Gueltigkeit werden vom Portal geprueft; es gibt keinen
   zusaetzlichen Dateihash-Pin fuer die regelmaessig erneuerte CRL-Datei.
   Webprozess nur leseberechtigen, keine Symlinks und keine Ablage unter Nutzdaten.
   Erneuerung vor `nextUpdate` sicherstellen: entweder extern (eigener Cron) oder ueber
   die eingebaute automatische Erneuerung (siehe unten).
   Neue Listen vollstaendig in einer Nachbardatei schreiben, dann atomar ersetzen.
   Nicht alte und neue Listen desselben Ausstellers sammeln: jede passende Liste
   muss aktuell und gueltig sein, jede enthaltene Sperrung blockiert.
6. Portal neu starten und eine kontrollierte Freigabe mit dem echten DigiCert-Dienst
   pruefen. Nachholjob, Gruppenfinalisierung und n8n-Exportsperre ebenfalls testen.
   Noch keine reale Betriebsabnahme durchgefuehrt.

Die Datei ist auf 128 KiB und 16 eindeutige selbstsignierte CA-Zertifikate begrenzt.
Das Portal prueft den Dateihash bei jedem TSA-Versuch. Fehlende, falsche,
ausgetauschte oder unlesbare Dateien fuehren nicht zu einem ungesicherten Fallback.
Der normale Konfigurationsloader erlaubt kein Abschalten der Kettenpflicht;
ein interner Opt-out wird ausschliesslich zur Isolation anderer Tests verwendet.

## Beispiel DigiCert (`http://timestamp.digicert.com`)

Stand 2026-10-02 mit einem echten Zeitstempel geprueft (Kette, CRLs, Nachweis).
Die Kette lautet *DigiCert SHA256 RSA4096 Timestamp Responder 2026 1* →
*DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1* → *DigiCert Trusted Root G4*.

```sh
curl -o /tmp/root.crt https://cacerts.digicert.com/DigiCertTrustedRootG4.crt
openssl x509 -inform DER -in /tmp/root.crt -out /etc/freigabeportal/tsa-roots.pem
openssl x509 -in /etc/freigabeportal/tsa-roots.pem -noout -fingerprint -sha256
# erwartet: 55:2F:7B:DC:F1:A7:AF:9E:6C:E6:72:01:7F:4F:12:AB:F7:72:40:C7:8E:76:1A:C2:03:D1:D9:D2:0A:C8:99:88
sha256sum /etc/freigabeportal/tsa-roots.pem   # → TSA_TRUST_ANCHORS_SHA256

# CRLs: am einfachsten `npm run tsa:crl-update` (siehe unten). Manuell (Gueltigkeit ca.
# 3 Wochen, regelmaessig erneuern; Verteilpunkte bei Profilwechsel neu ermitteln):
tmp=$(mktemp)
for n in DigiCertTrustedG4TimeStampingRSA4096SHA2562025CA1 DigiCertTrustedRootG4; do
  curl -fsS "http://crl3.digicert.com/$n.crl" | openssl crl -inform DER >> "$tmp" || exit 1
done
mv "$tmp" /etc/freigabeportal/tsa-crls.pem
```

Die Fingerprint-Angabe zusaetzlich mit der offiziellen DigiCert-Root-Liste abgleichen.
Wechselt DigiCert Responder oder Zwischenzertifikat, aendern sich die CRL-URLs.

## Automatische Sperrlisten-Erneuerung

Mit `TSA_CRL_AUTO_UPDATE=true` erneuert das Portal `TSA_CRL_FILE` taeglich selbst
(Standard 04:15 Europe/Zurich, aenderbar ueber `cron_tsa_crl_stunde`/`cron_tsa_crl_minute`;
manuell per `POST /internal/cron/tsa-crl-aktualisierung`). Gedacht fuer Hosting ohne eigenen
Cron, z.B. Infomaniak-Webhosting. Ablauf (`src/services/tsaCrlUpdate.js`):

1. Testzeitstempel bei der konfigurierten TSA anfordern und dessen Kette gegen die lokalen
   Anker validieren. Ohne gueltige Kette wird nichts geladen.
2. CRL-Adressen (nur http/https, nur uneingeschraenkte Verteilpunkte) ausschliesslich aus
   dieser validierten Kette lesen und laden (max. 4 MiB je Liste). Ein Wechsel des
   DigiCert-Zwischenzertifikats wird so automatisch beruecksichtigt.
3. Listen mit derselben Pruefung wie bei echten Zeitstempeln kontrollieren und die Datei
   atomar ersetzen (temporaere Nachbardatei + rename, kein Symlink-Ziel).

Schlaegt ein Schritt fehl, bleibt die bisherige Datei unveraendert. Ausnahme: authentische,
aktuelle Listen, die ein Zertifikat der TSA-Kette sperren, werden trotzdem uebernommen, damit
die Sperrung nicht durch aeltere Listen verdeckt wird. Eine Alarm-Mail (Typ `sicherheitsalarm`,
Empfaenger `sicherheitsalarm_empfaenger`, Standard Admin-Gruppe) geht raus bei Sperrung, bei
fehlender/unlesbarer Datei oder wenn die vorhandenen Listen in weniger als 7 Tagen ablaufen;
voruebergehende Ausfaelle davor erscheinen nur im Audit-Log (`tsa-crl-aktualisierung`).

Abweichung vom Grundsatz oben: Der Webprozess braucht Schreibrecht auf die CRL-Datei und ihr
Verzeichnis und ruft Adressen aus Zertifikaten ab. Vertretbar, weil diese Zertifikate vorher
gegen die gepinnten Anker validiert und alle Listen signaturgeprueft werden; die Anker-Datei
bleibt schreibgeschuetzt. Wo SSH-Benutzer und Webprozess ohnehin identisch sind (Shared
Hosting), entfaellt die Trennung praktisch ohnehin. Mit getrennten Benutzern kann weiterhin
extern erneuert werden (`TSA_CRL_AUTO_UPDATE=false`).

Ersteinrichtung bzw. manueller Lauf (auch ohne den Schalter, Exit-Code 1 bei Fehler):

```sh
npm run tsa:crl-update -- --url http://timestamp.digicert.com
```

## Was geprueft wird

- Nur lokal freigegebene Root-CAs sind vertrauenswuerdig; Zertifikate aus der
  Antwort dienen lediglich als ungesicherte Kettenkandidaten.
- Der Pfad muss zum tatsaechlichen CMS-Unterzeichner und zu einem konfigurierten
  Root fuehren. Mitgelieferte Zertifikate mit Name und Schluessel eines konfigurierten
  Roots (Querzertifikate, z.B. DigiCerts "Trusted Root G4" signiert von "Assured ID Root
  CA") werden ignoriert; der Pfad endet immer am lokalen selbstsignierten Anker. PKI.js validiert ihn zum behaupteten Zeitstempelzeitpunkt und
  zum lokalen Empfangszeitpunkt. Fehlende Zwischenzertifikate werden nicht
  automatisch aus URLs nachgeladen.
- SHA-256/384/512 als Signatur-Digest, ESS-Bindung an das Signierzertifikat,
  kritische exklusive Zeitstempel-EKU und Gueltigkeitszeitraeume bleiben erforderlich.
- Fuer jede Stufe unterhalb des Roots muss eine aktuelle CRL vorhanden sein:
  `thisUpdate <= lokale Uhr < nextUpdate`. Die Signatur wird gegen genau den
  Aussteller im validierten Pfad geprueft; dessen KeyUsage muss `cRLSign` erlauben.
  Gesperrte Signier- oder Zwischenzertifikate verhindern die Uebernahme.
- Unterstuetzt sind vollstaendige direkte CRLs mit RSA-PKCS1- oder ECDSA-Signatur
  und SHA-256/384/512, maximal 16 Listen in einer regulaeren Datei bis 16 MiB.
  Eine (kritische) IssuingDistributionPoint-Erweiterung wird nur akzeptiert, wenn sie
  ausschliesslich fullName-URIs enthaelt (keine onlyContains*-, onlySomeReasons- oder
  indirectCRL-Einschraenkung) und eine davon einem uneingeschraenkten CRL-Verteilpunkt
  des geprueften Zertifikats entspricht. Delta-CRLs, FreshestCRL, indirekte Eintraege,
  doppelte Erweiterungen und sonstige kritische CRL-/Eintragserweiterungen werden abgelehnt.
  Das ist ein bewusst begrenztes Profil, keine allgemeine CRL-/OCSP-Implementierung.
  Grundlage: [RFC 5280, Abschnitt 5](https://www.rfc-editor.org/rfc/rfc5280.html#section-5).

## Grenzen und Rotation

Die Sperrpruefung gilt nur fuer neue Zeitstempel anhand lokal vorhandener, aktuell
gueltiger CRLs. Sie beweist weder eine Live-Abfrage noch, dass zwischenzeitlich
keine neuere Liste veroeffentlicht wurde. OCSP, Delta-/indirekte CRLs,
historische Langzeitvalidierung und weitere ESS-Kettenbeschraenkungen bleiben offen.

Seit 2026-09-29 wird je neuem Zeitstempel die bei der Pruefung verwendete Evidenz
gespeichert (`tsa_pruefnachweise`, `tsa_evidenz_objekte`, `src/services/tsaNachweis.js`):
Token-Hash, Zertifikatskette vom Signer bis zum lokalen Vertrauensanker, die tatsaechlich
verwendeten CRLs byte-genau samt `thisUpdate`/`nextUpdate`, lokaler Pruefzeitpunkt,
Truststore-SHA-256 und Zuordnung zu Job, Dokumentart und SHA-256 der gestempelten Datei.
Einzelfreigabe, Nachholjob und Gruppenfinalisierung speichern den Nachweis in derselben
Transaktion wie den Zeitstempel-Hash; scheitert das Speichern, wird der Zeitstempel nicht
festgeschrieben und die Exportsperre bleibt bestehen. Ohne konfigurierte Anker vermerkt der
Nachweis ausdruecklich `kettenpruefung: nicht_konfiguriert`. Der Nachweis belegt den Stand zum
lokalen Pruefzeitpunkt; er ist keine Langzeitvalidierung (kein LTV/DSS in der PDF, keine
OCSP-Antworten, keine Erneuerung per Archivzeitstempel) und lokal gegen DB-Administratoren nicht
geschuetzt. Zusaetzliche OCSP-/CRL-Profile wurden nicht umgesetzt, da ohne konkrete
DigiCert-Profilanalyse kein nachgewiesener Bedarf besteht. Die Anzeige des Nachweises in der
Pruefbescheinigung steht noch aus. Die konkrete DigiCert-Kompatibilitaet
und der externe Aktualisierungsprozess sind noch nicht betrieblich abgenommen.
Es gibt bewusst keine Netzwerkabrufe von URLs aus ungesicherten
Zertifikaten. Die vorhandene Upload-Pruefansicht behauptet weiterhin kein
Zertifikatsvertrauen und fuehrt keine historische Kettenpruefung durch.

Bei Root-Rotation das neue Zertifikat separat pruefen und freigeben, Bundle und
Dateihash gemeinsam aktualisieren und neu starten. Alte Bundle-Staende samt
Freigaben fuer Audits aufbewahren. Diese Deployment-Historie wird derzeit nicht
automatisch als eigener unveraenderlicher Pruefnachweis in der Job-DB gespeichert.
Das Portal-Backup enthaelt das externe Trust-/CRL-Buendel nicht; es gehoert zur separat
gesicherten Betriebskonfiguration. Ein Restore darf es nicht stillschweigend ersetzen.
