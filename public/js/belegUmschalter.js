// Beleg/Formular-Umschalter der PDF-Seiten (views/_beleg_umschalter.ejs). Wird mit defer geladen.
// Ab 992 px: eingebettetes PDF neben dem Formular wie bisher (PDF.js-Viewer, "Vorschau neu laden").
// Darunter: Knöpfe "Beleg" / "Formular" (Formular vorgewählt), Vorschaubild + "PDF öffnen" statt
// des eingebetteten PDFs — das iframe lädt dort gar nicht (Datenvolumen; iOS/iPadOS scrollen
// eingebettete PDFs nicht zuverlässig). Ohne dieses Skript bleiben beide Bereiche sichtbar.
(function () {
  var container = document.querySelector('[data-beleg-umschalter]');
  if (!container) return;
  var desktop = window.matchMedia('(min-width: 992px)');
  var frame = container.querySelector('iframe[data-preview-url]');
  var geladen = false;

  // See pool.ejs's thumbnail-click handler for why file= must be resolved to an absolute URL.
  function ladeVorschau() {
    if (!frame || !desktop.matches) return;
    var absoluteUrl = new URL(frame.dataset.previewUrl, window.location.origin).href;
    frame.src = '/vendor/pdfjs/web/viewer.html?file=' + encodeURIComponent(absoluteUrl);
    geladen = true;
  }
  ladeVorschau();
  // Tablet gedreht / Fenster verbreitert: erst jetzt laden.
  function beiBreitenwechsel() { if (!geladen) ladeVorschau(); }
  if (desktop.addEventListener) desktop.addEventListener('change', beiBreitenwechsel);
  else if (desktop.addListener) desktop.addListener(beiBreitenwechsel);

  // Signed preview links are short-lived (see PDF_PREVIEW_TTL_SECONDS) — if this page has
  // been open longer than that, the embedded PDF stops loading with no obvious way to
  // recover short of a full reload. This button re-authorizes the session and mints a fresh
  // link instead. ("PDF öffnen" needs no refresh: /downloads/:id/oeffnen signs on each click.)
  var refreshBtn = document.getElementById('preview-refresh-btn');
  if (refreshBtn && frame && container.dataset.refreshUrl) {
    refreshBtn.addEventListener('click', function () {
      fetch(container.dataset.refreshUrl)
        .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
        .then(function (data) {
          frame.dataset.previewUrl = data.url;
          geladen = false;
          ladeVorschau();
        })
        .catch(function () {
          alert('Vorschau konnte nicht neu geladen werden.');
        });
    });
  }

  // Vorschaubild fehlt auf der Platte (Thumbnail-Route 404): Platzhalter statt kaputtem Bild.
  var bild = container.querySelector('.beleg-umschalter-bild');
  function bildFehlt() {
    var link = bild.closest('a');
    var leer = container.querySelector('.beleg-umschalter-leer');
    if (link) link.hidden = true;
    if (leer) leer.hidden = false;
  }
  if (bild) {
    bild.addEventListener('error', bildFehlt);
    if (bild.complete && bild.currentSrc && bild.naturalWidth === 0) bildFehlt();
  }

  // Umschalter: nur unter 992 px sichtbar (d-lg-none); die Ausblende-Regeln in portal.css greifen
  // nur mit .js-aktiv und nur unter 992 px, ab 992 px sind immer beide Bereiche da.
  var knoepfe = container.querySelectorAll('[data-beleg-ansicht]');
  function zeige(ansicht) {
    container.setAttribute('data-ansicht', ansicht);
    knoepfe.forEach(function (knopf) {
      var aktiv = knopf.getAttribute('data-beleg-ansicht') === ansicht;
      knopf.setAttribute('aria-pressed', aktiv ? 'true' : 'false');
      knopf.classList.toggle('active', aktiv);
    });
  }
  knoepfe.forEach(function (knopf) {
    knopf.addEventListener('click', function () {
      var ansicht = knopf.getAttribute('data-beleg-ansicht');
      if (container.getAttribute('data-ansicht') === ansicht) return;
      zeige(ansicht);
      // Zum Anfang des Bereichs, sonst bleibt man mitten im (jetzt anderen) Inhalt stehen.
      var oben = container.getBoundingClientRect().top;
      if (oben < 0) window.scrollBy(0, oben - 8);
    });
  });
  zeige('formular');
  container.classList.add('js-aktiv');
  var leiste = container.querySelector('.beleg-umschalter-knoepfe');
  if (leiste) leiste.removeAttribute('hidden');
})();
