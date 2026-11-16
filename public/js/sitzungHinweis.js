// Hinweis «Deine Anmeldung läuft bald ab» (Prüfung 2026-11-15, U2). Die Sitzung gilt 8 Stunden ab der Anmeldung (src/app.js);
// der Server schreibt den festen Ablaufzeitpunkt als data-ablauf in #sitzung-hinweis (views/_seite_anfang.ejs).
// Diese Datei zeigt nur an und verlängert nichts: es gibt bewusst keinen Keep-alive-Aufruf an den Server.
(function (fenster) {
  'use strict';

  // So früh vor dem Ablauf erscheint der Hinweis.
  var VORLAUF_MS = 10 * 60 * 1000;

  // 'ok' (noch lange gültig) | 'bald' (innerhalb des Vorlaufs) | 'abgelaufen'. Zeiten in Millisekunden.
  function zustand(jetzt, ablauf) {
    if (jetzt >= ablauf) return 'abgelaufen';
    if (ablauf - jetzt <= VORLAUF_MS) return 'bald';
    return 'ok';
  }

  // Hinweistext in Du-Form; `uhrzeit` ist «HH:MM».
  function text(z, uhrzeit) {
    if (z === 'bald') {
      return 'Deine Anmeldung läuft um ' + uhrzeit + ' ab. Bitte sende deine Eingaben vorher ab oder sichere sie, zum Beispiel, indem du den Text kopierst.';
    }
    return 'Deine Anmeldung ist seit ' + uhrzeit + ' abgelaufen. Eingaben, die du jetzt absendest, gehen verloren. Kopiere sie zuerst und melde dich dann neu an.';
  }

  fenster.SitzungHinweis = { VORLAUF_MS: VORLAUF_MS, zustand: zustand, text: text };

  if (typeof document === 'undefined') return;
  var feld = document.getElementById('sitzung-hinweis');
  if (!feld) return;
  var ablauf = Date.parse(feld.getAttribute('data-ablauf'));
  if (isNaN(ablauf)) return;
  // Nur auf Seiten mit einem Formular im Inhaltsbereich: dort gehen Eingaben verloren.
  if (!document.querySelector('main form')) return;
  var uhrzeit = new Date(ablauf).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  var angezeigt = 'ok';

  function aktualisiere() {
    var z = zustand(Date.now(), ablauf);
    if (z === angezeigt) return;
    angezeigt = z;
    feld.textContent = '';
    if (z === 'ok') return;
    var box = document.createElement('div');
    box.className = 'alert ' + (z === 'bald' ? 'alert-warning' : 'alert-danger');
    box.textContent = text(z, uhrzeit) + ' ';
    if (z === 'abgelaufen') {
      var link = document.createElement('a');
      link.href = '/auth/login';
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Neu anmelden (öffnet in einem neuen Tab)';
      box.appendChild(link);
    }
    feld.appendChild(box);
  }

  aktualisiere();
  setInterval(aktualisiere, 30000);
})(window);
