// Kontierung ohne QR-Code: Kasten «IBAN bitte von Hand prüfen» nur zeigen, wenn der gewählte Lieferant
// eine IBAN braucht (data-iban-pflicht="1") und der Typ «Rechnung» gewählt ist. Kein Live-Abgleich.
// Wirkt je Formular: Kontierung und Aufsplitten-Assistent stehen auf derselben Seite.
(function () {
  function binde(form) {
    var kasten = form.querySelector('[data-iban-kasten]');
    var select = form.querySelector('select[name="kreditorId"]');
    var eingabe = form.querySelector('input[name="ibanEndung"]');
    if (!kasten || !select || !eingabe) return;
    function aktualisieren() {
      var option = select.options[select.selectedIndex];
      var typ = form.querySelector('input[name="typ"]:checked');
      var noetig = Boolean(option) && option.getAttribute('data-iban-pflicht') === '1' && (!typ || typ.value === 'rechnung');
      kasten.classList.toggle('d-none', !noetig);
      eingabe.required = noetig;
    }
    select.addEventListener('change', aktualisieren);
    form.querySelectorAll('input[name="typ"]').forEach(function (radio) {
      radio.addEventListener('change', aktualisieren);
    });
    aktualisieren();
  }
  Array.prototype.forEach.call(document.forms, binde);
})();
