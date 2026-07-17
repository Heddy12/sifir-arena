'use strict';

const nodemailer = require('nodemailer');

let transporter = null;
const testMessages = [];

function smtpConfiguration() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const from = String(process.env.SMTP_FROM || user).trim();
  const port = Math.max(1, Math.min(65535, Number(process.env.SMTP_PORT) || 587));
  return {
    configured: !!(host && user && pass && from),
    host: host,
    port: port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    user: user,
    pass: pass,
    from: from
  };
}

function webhookConfiguration() {
  const url = String(process.env.EMAIL_WEBHOOK_URL || '').trim();
  const secret = String(process.env.EMAIL_WEBHOOK_SECRET || '');
  return {
    configured: /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) && secret.length >= 32,
    url: url,
    secret: secret
  };
}

function isConfigured() {
  return process.env.NODE_ENV === 'test' || webhookConfiguration().configured || smtpConfiguration().configured;
}

function getTransporter() {
  if (transporter) return transporter;
  const config = smtpConfiguration();
  if (!config.configured) {
    const error = new Error('Reset email delivery has not been configured.');
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    disableFileAccess: true,
    disableUrlAccess: true
  });
  return transporter;
}

async function sendPasswordResetCode(email, code) {
  if (process.env.NODE_ENV === 'test') {
    testMessages.push({ email: email, code: code });
    return true;
  }
  const webhook = webhookConfiguration();
  if (webhook.configured) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 15000);
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret: webhook.secret, email: email, code: code }),
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Email webhook returned HTTP ' + response.status);
      const body = await response.json().catch(function () { return {}; });
      if (!body.ok) throw new Error('Email webhook rejected the request');
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }
  const config = smtpConfiguration();
  const mailer = getTransporter();
  await mailer.sendMail({
    from: config.from,
    to: email,
    subject: 'Password Reset Code — Times Table Hero Arena',
    text: [
      'Your password reset code is: ' + code,
      '',
      'This code is valid for 15 minutes and can only be used once.',
      'If you did not request this reset, ignore this email.'
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#11111f;color:#f7f7ff;border-radius:14px">',
      '<h2 style="color:#00f0ff">Times Table Hero Arena</h2>',
      '<p>Your password reset code:</p>',
      '<div style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#ffe600;padding:16px 0">' + code + '</div>',
      '<p>This code is valid for <strong>15 minutes</strong> and can only be used once.</p>',
      '<p style="color:#9a9ab4">If you did not request this reset, ignore this email.</p>',
      '</div>'
    ].join('')
  });
  return true;
}

function takeLastTestMessage() {
  return testMessages.pop() || null;
}

module.exports = {
  isConfigured,
  sendPasswordResetCode,
  takeLastTestMessage
};
