// Prüf-Popup bei der Kontierung (views/_auffaelligkeiten_modal.ejs): ohne JS steht der Inhalt als
// Block über dem Formular; mit JS wird daraus ein beim Laden geöffnetes Bootstrap-Modal.
(function () {
  var modal = document.querySelector('[data-auffaelligkeiten-modal]');
  if (!modal || !window.bootstrap) return;
  modal.classList.remove('auffaelligkeiten-modal-ohne-js', 'mb-3');
  modal.classList.add('fade');
  modal.setAttribute('aria-hidden', 'true');
  // Ausserhalb der Karte, damit Positionierung und Overlay der Modals stimmen.
  document.body.appendChild(modal);
  window.bootstrap.Modal.getOrCreateInstance(modal).show();
})();
