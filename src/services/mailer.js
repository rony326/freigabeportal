// SMTP-Mailversand über nodemailer. Der Versandweg mit Wiederholung und Protokoll ist services/notify.js bzw. services/mailZustellung.js.

import nodemailer from 'nodemailer';

// Erstellt den Mailer mit `sendMail({to, subject, text})`. Wirft, wenn SMTP_HOST/USER/PASS/FROM fehlen. Port 465 = implizites TLS.
export function createMailer(smtpConfig) {
  if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass || !smtpConfig.from) {
    throw new Error('SMTP ist nicht konfiguriert (SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM fehlen).');
  }

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  return {
    async sendMail({ to, subject, text }) {
      await transporter.sendMail({ from: smtpConfig.from, to, subject, text });
    },
  };
}

// SMTP ist optional, bis endgültige Produktivzugangsdaten existieren (siehe .env.example) — sowohl app.js (Mailversand während
// einer Anfrage) als auch index.js (der In-Process-Scheduler) brauchen dasselbe Verhalten "protokollieren und auf einen immer
// fehlschlagenden Mailer zurückfallen", statt den ganzen Prozess bei fehlender/unvollständiger SMTP-Konfiguration abstürzen zu
// lassen — deshalb steht es einmal hier statt zweimal.
export function createMailerOrFallback(smtpConfig) {
  try {
    return createMailer(smtpConfig);
  } catch (err) {
    console.error('Mailer konnte nicht initialisiert werden, E-Mail-Versand ist deaktiviert:', err.message);
    return {
      async sendMail() {
        throw new Error('SMTP ist nicht konfiguriert.');
      },
    };
  }
}
