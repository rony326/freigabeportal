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
