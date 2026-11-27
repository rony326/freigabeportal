// KI-Werte in Kontierung und Aufsplitten (views/_ki_bestaetigen.ejs, services/kiBestaetigung.js): Ein Feld mit
// data-ki-feld bleibt rot markiert, bis sein Haken gesetzt ist. Wer den Wert selbst ändert, hat ihn geprüft – dann setzt
// dieses Skript den Haken automatisch; wird der ursprüngliche Wert wiederhergestellt, ist der Haken wieder von Hand nötig.
// Ohne JS funktioniert der Haken als normale Checkbox; die serverseitige Prüfung gilt in beiden Fällen.
(function () {
  document.querySelectorAll('[data-ki-feld]').forEach(function (feld) {
    var name = feld.getAttribute('data-ki-feld');
    // Je Formular: Kontierung und Aufsplitten-Assistent haben auf derselben Seite je eigene Haken.
    var form = feld.form;
    var haken = form && form.querySelector('[data-ki-haken="' + name + '"]');
    var hinweis = form && form.querySelector('[data-ki-hinweis="' + name + '"]');
    if (!haken) return;
    var original = feld.getAttribute('data-ki-wert') || '';
    var vonHand = haken.checked;

    function anzeigen() {
      feld.classList.toggle('feld-erkannt', !haken.checked);
      if (hinweis) hinweis.hidden = haken.checked;
    }
    haken.addEventListener('change', function () {
      vonHand = haken.checked;
      anzeigen();
    });
    feld.addEventListener('input', function () {
      var geaendert = feld.value.trim() !== original.trim();
      haken.checked = geaendert || vonHand;
      anzeigen();
    });
    anzeigen();
  });
})();
