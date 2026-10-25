// Mailer der Test-Instanz: sammelt nur, kein SMTP, kein Netz. Der normale Outbox-Ablauf
// (mailZustellung.js) markiert die Zeile danach in der Spiel-DB als 'versendet'.
export function createTestMailer() {
  const gesendet = [];
  return {
    gesendet,
    async sendMail(mail) {
      gesendet.push({ ...mail, am: new Date().toISOString() });
    },
  };
}
