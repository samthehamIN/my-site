'use strict';

const fetch = require('node-fetch');

const TO_EMAIL   = 'samridh.sharma@gmail.com';
const FROM_EMAIL = 'website@sharmagrp.com';

module.exports = async function contactHandler(req, res) {
  const { name, email, company, size, type, message } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const subject  = `New Enquiry from ${name}${company ? ' — ' + company : ''}`;

  const textBody = [
    `New enquiry from the Sharma Group website`,
    ``,
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Company: ${company || '—'}`,
    `Size:    ${size    || '—'}`,
    `Type:    ${type    || '—'}`,
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

  if (!process.env.RESEND_API_KEY) {
    console.log('\n── New Enquiry (RESEND_API_KEY not set) ──');
    console.log(textBody);
    console.log('───────────────────────────────────────────\n');
    return res.json({ ok: true, note: 'logged' });
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:     FROM_EMAIL,
        to:       [TO_EMAIL],
        reply_to: email,
        subject,
        text:     textBody,
        html:     htmlBody,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Resend ${resp.status}: ${errText}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Contact email error:', err.message);
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
