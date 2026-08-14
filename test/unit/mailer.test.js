import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createMailer } from '../../src/services/mailer.js';

test('sendMail delivers via the configured transporter', async (t) => {
  let captured;
  const fakeTransporter = {
    sendMail: async (mail) => {
      captured = mail;
      return { messageId: 'test' };
    },
  };
  t.mock.method(nodemailer, 'createTransport', () => fakeTransporter);

  const mailer = createMailer({ host: 'smtp.example.org', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' });
  await mailer.sendMail({ to: 'person@example.org', subject: 'Test', text: 'Hallo' });

  assert.equal(captured.to, 'person@example.org');
  assert.equal(captured.from, 'portal@example.org');
  assert.equal(captured.subject, 'Test');
  assert.equal(captured.text, 'Hallo');
});

test('createMailer throws when required SMTP settings are missing', () => {
  assert.throws(() => createMailer({}), /SMTP ist nicht konfiguriert/);
  assert.throws(
    () => createMailer({ port: 587, user: 'u', pass: 'p', from: 'portal@example.org' }),
    /SMTP ist nicht konfiguriert/
  );
});
