import nodemailer from 'nodemailer';

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

// SMTP is optional until final production credentials exist (see .env.example) — both app.js
// (request-time mail sending) and index.js (the in-process scheduler) need the same
// "log and fall back to an always-failing mailer" behavior rather than crashing the whole
// process on a missing/incomplete SMTP config, so it lives here once instead of twice.
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
