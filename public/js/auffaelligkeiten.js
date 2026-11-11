// Prüf-Popup bei Kontierung und Aufsplitten (views/_auffaelligkeiten_modal.ejs): ohne JS steht der
// Inhalt als Block über dem Formular; mit JS wird daraus ein beim Laden geöffnetes Bootstrap-Modal.
(function () {
  var modal = document.querySelector('[data-auffaelligkeiten-modal]');
  if (!modal || !window.bootstrap) return;
  var hash = modal.querySelector('[data-auffaelligkeiten-hash]');
  var bestaetigen = modal.querySelector('[data-auffaelligkeiten-bestaetigen]');
  var hashWert = hash ? hash.getAttribute('data-hash') : '';
  modal.classList.remove('auffaelligkeiten-modal-ohne-js', 'mb-3');
  modal.classList.add('fade');
  modal.setAttribute('aria-hidden', 'true');
  // Ausserhalb der Karte, damit Positionierung und Overlay der Modals stimmen.
  document.body.appendChild(modal);
  // Abbrechen, ✕ oder Esc: ohne Bestätigung gilt nichts als geprüft. Der Hash (und ein im Modal
  // nochmals gewählter Beleg) darf deshalb nicht beim nächsten normalen Absenden mitgehen —
  // sonst würde gespeichert, ohne dass das Popup erneut erscheint.
  modal.addEventListener('hidden.bs.modal', function () {
    if (hash) hash.value = '';
    modal.querySelectorAll('input[type="file"]').forEach(function (datei) { datei.value = ''; });
  });
  // Nur „Geprüft, trotzdem speichern“ schickt den Hash mit.
  if (bestaetigen && hash) {
    bestaetigen.addEventListener('click', function () { hash.value = hashWert; });
  }
  window.bootstrap.Modal.getOrCreateInstance(modal).show();
})();
