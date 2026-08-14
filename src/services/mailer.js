import nodemailer from 'nodemailer';

export function createMailer(smtpConfig) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });

  return {
    async sendMail({ to, subject, text }) {
      await transporter.sendMail({ from: smtpConfig.from, to, subject, text });
    },
  };
}
