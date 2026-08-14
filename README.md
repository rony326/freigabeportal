# Freigabeportal — Phase A

Rechnungsfreigabe-Portal für eine Schweizer Kirchgemeinde. Diese Phase liefert
das Fundament: Express/SQLite-Skeleton, ChurchTools-OAuth2-Login,
Rollen-Ableitung aus Gruppen, Personen-Sync.

## Setup

1. `npm install`
2. `cp .env.example .env` und Werte eintragen
3. `npm test` — gesamte Test-Suite
4. `npm run dev` — Entwicklungsserver mit Autoreload

## Deployment (Infomaniak Node.js-Hosting)

- Start-Kommando: `npm start`
- Der Port wird von Infomaniak über die Umgebungsvariable `PORT` vorgegeben.
- Task Scheduler (Manager → Website → Advanced Tools → Task Scheduler)
  einrichten: `POST` auf `/internal/cron/sync-personen` mit Header
  `X-Cron-Secret: <CRON_SECRET>`, empfohlen einmal täglich (nachts).
- `node:sqlite` benötigt Node.js ≥22.13.0 (kein `--experimental-sqlite`-Flag
  mehr nötig ab dieser Version) — bei der Node-Versionswahl im Infomaniak
  Manager entsprechend eine aktuelle LTS-Version wählen und früh im
  Deployment verifizieren, dass `node:sqlite` verfügbar ist.

## Nächste Phasen

Siehe `docs/superpowers/specs/2026-08-14-phase-a-fundament-auth-design.md`
für den Gesamt-Phasenplan (B: Admin-Bereich, C: n8n-Schnittstelle, D:
Freigabe-Workflow-UI, E: Härtung & Deployment).
