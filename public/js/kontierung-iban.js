// Kontierung ohne QR-Code: Kasten «IBAN bitte von Hand prüfen» nur zeigen, wenn der gewählte Lieferant
// eine IBAN braucht (data-iban-pflicht="1") und der Typ «Rechnung» gewählt ist. Kein Live-Abgleich.
(function () {
  var kasten = document.getElementById('iban-manuell-kasten');
  var select = document.getElementById('kreditorId');
  var eingabe = document.getElementById('ibanEndung');
  if (!kasten || !select || !eingabe) return;
  function aktualisieren() {
    var option = select.options[select.selectedIndex];
    var typ = document.querySelector('input[name="typ"]:checked');
    var noetig = Boolean(option) && option.getAttribute('data-iban-pflicht') === '1' && (!typ || typ.value === 'rechnung');
    kasten.classList.toggle('d-none', !noetig);
    eingabe.required = noetig;
  }
  select.addEventListener('change', aktualisieren);
  document.querySelectorAll('input[name="typ"]').forEach(function (radio) {
    radio.addEventListener('change', aktualisieren);
  });
  aktualisieren();
})();
