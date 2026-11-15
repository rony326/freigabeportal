// Kurze Hilfetexte für den Knopf "Hilfe" im Seitenkopf (views/_seite_anfang.ejs).
// Für Personen, die das Portal selten oder zum ersten Mal benutzen: was ist das hier, was tue ich jetzt?
// Neue Seite: Eintrag mit `pfad` ergänzen. Der längste passende Pfad gewinnt; Seiten ohne Eintrag zeigen keinen Knopf.
// Ansprache wie im übrigen Portal: "du".

const TEXTE = [
  {
    pfad: '/pool',
    titel: 'Hilfe: Aufgaben',
    worum: 'Hier siehst du alles, was auf dich wartet. Jede Zeile ist ein Beleg (Rechnung oder Spesen).',
    schritte: [
      'Klicke bei einem Beleg auf den Knopf rechts in der Zeile, zum Beispiel "Freigeben" oder "Beanspruchen".',
      'Prüfe den Beleg und klicke auf den grossen blauen Knopf.',
      'Danach bist du wieder hier, und der Beleg ist aus der Liste verschwunden.',
    ],
    tipp: 'Steht hier nichts, bist du fertig. Du musst dann nichts tun.',
  },
  {
    pfad: '/kontierung',
    titel: 'Hilfe: Beleg kontieren',
    worum: 'Links siehst du die Rechnung, rechts legst du fest, auf welches Konto sie gehört.',
    schritte: [
      'Prüfe, ob Absender, Betrag und Zahlungsziel stimmen. Korrigiere sie, falls nicht.',
      'Wähle das Konto aus der Liste.',
      'Klicke auf den grossen Knopf "Kontieren". Die Rechnung geht dann weiter zur Freigabe.',
    ],
    tipp: 'Bist du unsicher, wähle "Weitere Aktionen" und lege den Beleg mit "Zurück in den Pool legen" zurück. Dann kann jemand anders ihn übernehmen.',
  },
  {
    pfad: '/freigabe2',
    titel: 'Hilfe: Rechnung freigeben',
    worum: 'Du bestätigst, dass die Rechnung bezahlt werden darf.',
    schritte: [
      'Sieh dir die Rechnung links an und prüfe Betrag und Konto.',
      'Passt alles, klicke auf "Freigeben".',
      'Passt etwas nicht, klicke auf "Ablehnen" und schreibe kurz, was nicht stimmt.',
    ],
    tipp: 'Nach der Freigabe wird die Rechnung weiterverarbeitet. Bei Zweifeln lieber ablehnen und kurz begründen.',
  },
  {
    pfad: '/spesen-freigabe1',
    titel: 'Hilfe: Spesen prüfen',
    worum: 'Eine Person hat Spesen eingereicht. Du prüfst, ob sie in Ordnung sind.',
    schritte: [
      'Sieh dir Beleg und Betrag an.',
      'Passt alles, klicke auf "Freigeben". Dann geht es weiter zur nächsten Stelle.',
      'Passt etwas nicht, klicke auf "Ablehnen" und schreibe der Person kurz, warum.',
    ],
  },
  {
    pfad: '/spesen/neu',
    titel: 'Hilfe: Spesen einreichen',
    worum: 'Hier reichst du Auslagen ein, die du selbst bezahlt hast.',
    schritte: [
      'Lade den Beleg hoch.',
      'Trage Datum, Betrag und Zweck ein.',
      'Klicke auf "Einreichen". Ab dann siehst du unter "Meine Spesen", wie weit es ist.',
    ],
  },
  {
    pfad: '/meine-spesen',
    titel: 'Hilfe: Meine Spesen',
    worum: 'Hier siehst du deine eingereichten Spesen und in welchem Stand sie sind.',
    tipp: 'Wurde etwas abgelehnt, siehst du hier den Stand der Spesen.',
  },
  {
    pfad: '/meine-abgeschlossenen',
    titel: 'Hilfe: Abgeschlossene Rechnungen',
    worum: 'Hier findest du Rechnungen, die du bearbeitet hast und die fertig sind. Du kannst sie nur ansehen.',
  },
  {
    pfad: '/rapporte',
    titel: 'Hilfe: Zur Kenntnis',
    worum: 'Dieser Beleg ist nur zu deiner Information. Du musst nichts entscheiden.',
    schritte: ['Lies den Beleg und kehre zu den Aufgaben zurück.'],
  },
  {
    pfad: '/kreditkarte',
    titel: 'Hilfe: Kreditkartenbelege',
    worum: 'Hier reichst du Belege für Zahlungen mit der Kreditkarte ein. Sie werden später mit der Monatsabrechnung abgeglichen.',
  },
  {
    pfad: '/meine-benachrichtigungen',
    titel: 'Hilfe: Benachrichtigungen',
    worum: 'Du bestimmst, wann das Portal dir eine E-Mail schickt, zum Beispiel sofort oder gesammelt.',
    tipp: 'Vergiss nicht, am Schluss auf "Speichern" zu klicken.',
  },
  {
    pfad: '/ferienmodus',
    titel: 'Hilfe: Ferienmodus',
    worum: 'Bist du abwesend, erhält dein Stellvertreter für diese Zeit zusätzlichen Zugriff auf deine Aufgaben.',
  },
];

export function hilfeFuer(pfad) {
  if (!pfad) return null;
  let treffer = null;
  for (const t of TEXTE) {
    if (pfad === t.pfad || pfad.startsWith(`${t.pfad}/`)) {
      if (!treffer || t.pfad.length > treffer.pfad.length) treffer = t;
    }
  }
  return treffer;
}
