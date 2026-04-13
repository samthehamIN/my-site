'use strict';

// ── Pending proposal store ──────────────────────────────────────────────────
// Priority:
//   1. Supabase  — when SUPABASE_URL + SUPABASE_KEY are set AND the table exists
//   2. File      — .pending-proposals.json in the project root (survives restarts)
//   3. Memory    — last resort (lost on restart)
//
// The file store fixes the "proposal not found" problem when the server restarts
// between proposal generation and the owner clicking the approval link.

const fs   = require('fs');
const path = require('path');

// Vercel's /tmp is writable; in dev, write next to the project files
const STORE_PATH = process.env.VERCEL
  ? '/tmp/.pending-proposals.json'
  : path.join(__dirname, '..', '.pending-proposals.json');

// ── File store helpers ────────────────────────────────────────────────────────

function fileRead() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return {}; }
}

function fileWrite(data) {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(data)); }
  catch (e) { console.error('File store write error:', e.message); }
}

// ── ID generator ──────────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
// Only used when SUPABASE_URL + SUPABASE_KEY are configured.
// Column names must match your actual pending_proposals table.

function supabaseHeaders() {
  return {
    apikey:          process.env.SUPABASE_KEY,
    Authorization:   `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type':  'application/json',
  };
}

async function supabaseSave(id, record) {
  // intake_data stores extra fields not in the schema (agentMessages, pdfBase64)
  const intakeBlob = {
    ...(record.intakeData || {}),
    _agentMessages: record.agentMessages || [],
    _pdfBase64:     record.pdfBase64     || null,
  };
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_proposals`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      id,
      visitor_email:        record.prospectEmail || null,
      visitor_name:         record.prospectName  || null,
      company_name:         record.company       || null,
      lead_score:           record.score         || null,
      proposal_pdf_base64:  record.pdfBase64     || null,
      email_subject:        record.emailSubject  || null,
      email_body:           record.emailBody     || null,
      intake_data:          JSON.stringify(intakeBlob),
      status:               'pending',
      created_at:           new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Supabase insert failed: ${r.status} ${await r.text()}`);
}

async function supabaseGet(id) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/pending_proposals?id=eq.${encodeURIComponent(id)}&select=*`,
    { headers: supabaseHeaders() }
  );
  if (!r.ok) throw new Error(`Supabase get failed: ${r.status}`);
  const rows = await r.json();
  if (!rows.length) return null;
  const row = rows[0];
  const intake = JSON.parse(row.intake_data || '{}');
  return {
    id:            row.id,
    prospectEmail: row.visitor_email,
    prospectName:  row.visitor_name,
    company:       row.company_name  || intake.company   || '',
    challenge:     intake.challenge  || '',
    score:         row.lead_score,
    pdfBase64:     row.proposal_pdf_base64 || intake._pdfBase64 || null,
    emailSubject:  row.email_subject,
    emailBody:     row.email_body,
    intakeData:    intake,
    agentMessages: intake._agentMessages || [],
    status:        row.status,
  };
}

async function supabaseUpdate(id, fields) {
  const body = {};
  if (fields.status)       body.status        = fields.status;
  if (fields.emailSubject) body.email_subject  = fields.emailSubject;
  if (fields.emailBody)    body.email_body     = fields.emailBody;
  if (fields.pdfBase64)    body.proposal_pdf_base64 = fields.pdfBase64;

  // agentMessages and pdfBase64 are stored inside intake_data — fetch first, merge, write back
  if (fields.agentMessages || fields.pdfBase64) {
    try {
      const existing = await supabaseGet(id);
      if (existing) {
        const intake = { ...existing.intakeData };
        if (fields.agentMessages) intake._agentMessages = fields.agentMessages;
        if (fields.pdfBase64)     intake._pdfBase64     = fields.pdfBase64;
        body.intake_data = JSON.stringify(intake);
      }
    } catch (_) {}
  }

  if (!Object.keys(body).length) return;
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/pending_proposals?id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: supabaseHeaders(), body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error(`Supabase update failed: ${r.status}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function save(record) {
  const id = genId();
  const entry = { ...record, id, status: 'pending', createdAt: Date.now() };

  // On Vercel: Supabase is the ONLY persistent store (/tmp is per-container, not shared)
  // In dev: file store works fine as primary, Supabase is secondary
  if (process.env.VERCEL) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY must be set on Vercel — no shared /tmp available');
    }
    await supabaseSave(id, entry);
    console.log(`Store: saved ${id} to Supabase (Vercel)`);
    return id;
  }

  // Dev: try Supabase first, always write to file as local cache
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    try {
      await supabaseSave(id, entry);
      console.log(`Store: saved ${id} to Supabase + file cache`);
    } catch (e) {
      console.error(`Store: Supabase save failed (${e.message}) — file store only`);
    }
  }

  const data = fileRead();
  data[id] = entry;
  fileWrite(data);
  console.log(`Store: saved ${id} to file store (${STORE_PATH})`);
  return id;
}

async function get(id) {
  // On Vercel: Supabase only
  if (process.env.VERCEL) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return null;
    try { return await supabaseGet(id); }
    catch (e) { console.error('Store: Supabase get failed:', e.message); return null; }
  }

  // Dev: file first (fast, survives restarts), Supabase fallback
  const data = fileRead();
  if (data[id]) return data[id];

  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    try {
      const record = await supabaseGet(id);
      if (record) return record;
    } catch (e) {
      console.error('Store: Supabase get failed:', e.message);
    }
  }

  return null;
}

async function update(id, fields) {
  // Update file store
  const data = fileRead();
  if (data[id]) {
    data[id] = { ...data[id], ...fields };
    fileWrite(data);
  }

  // Update Supabase too if configured
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    try { await supabaseUpdate(id, fields); }
    catch (e) { console.error('Store: Supabase update failed:', e.message); }
  }
}

module.exports = { save, get, update };
