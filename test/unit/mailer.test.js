import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createMailer } from '../../src/services/mailer.js';
import { createServer } from 'node:net';
import { once } from 'node:events';

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

test('real Nodemailer transport delivers through the portal API to a local SMTP fixture', { timeout: 10000 }, async (t) => {
  const sockets = new Set();
  const messages = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let data = null;
    socket.setEncoding('utf8');
    socket.write('220 localhost test SMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === '.') { messages.push(data.join('\r\n')); data = null; socket.write('250 accepted\r\n'); }
          else data.push(line);
        } else if (/^EHLO /.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) socket.write('235 authenticated\r\n');
        else if (line === 'DATA') { data = []; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const mailer = createMailer({ host: '127.0.0.1', port: server.address().port, user: 'fixture', pass: 'fixture', from: 'portal@example.org' });
  await mailer.sendMail({ to: 'recipient@example.org', subject: 'Transport compatibility', text: 'Local SMTP test only.' });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Subject: Transport compatibility/);
  assert.match(messages[0], /Local SMTP test only\./);
});
