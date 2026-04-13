'use strict';

const nodemailer = require('nodemailer');

const RECIPIENTS = [
  'Samridh.sharma@gmail.com',
  'Samridh.sharma@sharmagrp.com'
];

module.exports = async function contactHandler(req, res) {
  const { name, email, company, size, type, message } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  // Build email content
  const subject = `New Enquiry from ${name}${company ? ' — ' + company : ''}`;
  const textBody = [
    `New enquiry from the Sharma Group website`,
    ``,
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Company: ${company || '—'}`,
    `Size:    ${size   || '—'}`,
    `Type:    ${type   || '—'}`,
    ``,
    `Message:`,
    message || '(none)',
  ].join('\n');

  const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#1a1510;">
  <h2 style="color:#C8903A;border-bottom:1px solid #ddd;padding-bottom:8px;">New Enquiry — Sharma Group</h2>
  <table style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:6px 0;color:#666;width:110px;">Name</td><td style="padding:6px 0;font-weight:600;">${escHtml(name)}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;"><a href="mailto:${escHtml(email)}">${escHtml(email)}</a></td></tr>
    <tr><td style="padding:6px 0;color:#666;">Company</td><td style="padding:6px 0;">${escHtml(company || '—')}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">Space Req.</td><td style="padding:6px 0;">${escHtml(size || '—')}</td></tr>
    <tr><td style="padding:6px 0;color:#666;">Facility Type</td><td style="padding:6px 0;">${escHtml(type || '—')}</td></tr>
  </table>
  ${message ? `<div style="margin-top:16px;"><strong>Message:</strong><p style="background:#f7f5f2;padding:12px;border-left:3px solid #C8903A;">${escHtml(message).replace(/\n/g, '<br>')}</p></div>` : ''}
  <p style="font-size:12px;color:#999;margin-top:24px;">Sent from sharmagrp.com contact form</p>
</div>`;

  // Configure transporter — reads SMTP settings from environment variables
  // Set in .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
  // For Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER=your@gmail.com, SMTP_PASS=app-password
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    // No SMTP configured — log to console so nothing is lost
    console.log('\n── New Enquiry (SMTP not configured) ──');
    console.log(textBody);
    console.log('───────────────────────────────────────\n');
    return res.json({ ok: true, note: 'logged' });
  }

  try {
    await transporter.sendMail({
      from:    `"Sharma Group Website" <${process.env.SMTP_USER}>`,
      to:      RECIPIENTS.join(', '),
      replyTo: email,
      subject,
      text:    textBody,
      html:    htmlBody,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Contact email error:', err.message);
    // Still log it so the lead isn't lost
    console.log('\n── Enquiry (email failed, logged) ──');
    console.log(textBody);
    console.log('─────────────────────────────────────\n');
    return res.status(500).json({ error: 'Email send failed.' });
  }
};

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
