'use strict';

// ============================================================================
// AGENTIC PROPOSAL ENGINE
// ============================================================================
// Flow (auto mode):   intake → render PDF → email visitor → store lead → alert owner
// Flow (approval):    intake → render PDF → queue + email OWNER → alert owner with link
//                     → owner clicks approve → email sent to visitor
//
// APPROVAL_MODE=true in .env activates human-in-the-loop review.
// Default (no env var, or false): auto-send as before.
// ============================================================================

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const store = require('./_store');

// ── Per-request state ────────────────────────────────────────────────────────
// Cleared at the start of every runAgentPipeline call.
// (One request at a time per Node instance — fine for this use case.)
let _pdf      = null;   // base64 PDF from render_proposal_pdf
let _lead     = null;   // args passed to store_lead (name, company, score, etc.)
let _pendingId = null;  // set when send_email is intercepted in approval mode

function resetState() { _pdf = null; _lead = null; _pendingId = null; }

// ── Tool definitions ─────────────────────────────────────────────────────────

function getTools(approvalMode) {
  return [
    {
      type: 'function',
      function: {
        name: 'store_lead',
        description: 'Stores the lead in the CRM database. Score the lead yourself using the triage rules. Call this BEFORE send_email so the lead data is available.',
        parameters: {
          type: 'object',
          properties: {
            name:      { type: 'string' },
            company:   { type: 'string' },
            email:     { type: 'string' },
            industry:  { type: 'string' },
            challenge: { type: 'string', description: '1-2 sentences' },
            budget:    { type: 'string' },
            score:     { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            status:    { type: 'string', description: approvalMode ? 'Use pending_approval' : 'Use proposal_sent' },
          },
          required: ['name', 'company', 'email', 'score', 'status'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'render_proposal_pdf',
        description: 'Renders a branded proposal PDF. Returns base64-encoded PDF data.',
        parameters: {
          type: 'object',
          properties: {
            company_name: { type: 'string' },
            contact_name: { type: 'string' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: { heading: { type: 'string' }, body: { type: 'string' } },
                required: ['heading', 'body'],
              },
            },
          },
          required: ['company_name', 'contact_name', 'sections'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_email',
        description: approvalMode
          ? 'Queues the proposal for owner review — does NOT send to the visitor yet. Returns { pending: true, proposal_id }. Use proposal_id in your alert_owner approval URL.'
          : 'Sends an email to the prospect with optional PDF attachment.',
        parameters: {
          type: 'object',
          properties: {
            to:         { type: 'string', description: 'Prospect email address' },
            subject:    { type: 'string' },
            body:       { type: 'string', description: 'Plain text email body' },
            attach_pdf: { type: 'boolean' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'alert_owner',
        description: 'Sends a Telegram alert to the owner with lead summary and proposal PDF.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: approvalMode
                ? 'Must start with "[ PENDING APPROVAL ]". Include lead name, company, score, and the full approval URL: [baseUrl]/api/approve-proposal?id=[proposal_id from send_email]'
                : 'Include lead name, company, score (HIGH/MEDIUM/LOW), and one-line reason.',
            },
          },
          required: ['message'],
        },
      },
    },
  ];
}

// ── PDF sanitizer ─────────────────────────────────────────────────────────────

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    .replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2018\u2019\u201A]/g, "'").replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2039\u203A]/g, "'").replace(/[\u00AB\u00BB]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2002\u2003\u2007\u202F]/g, ' ')
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '-')
    .replace(/\u2713/g, '[x]').replace(/\u2717/g, '[ ]').replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->').replace(/\u2190/g, '<-')
    .replace(/\u2264/g, '<=').replace(/\u2265/g, '>=')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function renderProposalPdf({ company_name, contact_name, sections }) {
  company_name = sanitizeForPdf(company_name);
  contact_name = sanitizeForPdf(contact_name);
  sections = sections.map(s => ({ heading: sanitizeForPdf(s.heading), body: sanitizeForPdf(s.body) }));

  const pdf = await PDFDocument.create();
  const font     = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const brandPrimary = rgb(0.1, 0.35, 0.32);
  const brandAccent  = rgb(0.77, 0.44, 0.23);
  const black = rgb(0.1, 0.1, 0.1);
  const gray  = rgb(0.35, 0.35, 0.35);

  // Cover page
  const cover = pdf.addPage([612, 792]);
  cover.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: brandPrimary });
  cover.drawText('SHARMA GROUP', { x: 50, y: 732, size: 22, font: fontBold, color: rgb(1, 1, 1) });
  cover.drawText('Industrial & Warehouse Real Estate', { x: 50, y: 710, size: 12, font, color: rgb(0.8, 0.8, 0.8) });
  cover.drawText('PROPOSAL', { x: 50, y: 600, size: 36, font: fontBold, color: brandPrimary });
  cover.drawText(`Prepared for ${contact_name}`, { x: 50, y: 565, size: 16, font, color: black });
  cover.drawText(company_name, { x: 50, y: 542, size: 14, font, color: gray });
  cover.drawText(
    new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }),
    { x: 50, y: 510, size: 12, font, color: gray }
  );

  // Content pages
  let y = 720;
  let page = pdf.addPage([612, 792]);
  const maxWidth = 500;

  function drawLine(text, options) {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawText(text, { x: 50, y, ...options });
    y -= options.lineHeight || 18;
  }

  for (const section of sections) {
    if (y < 120) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawLine({ start: { x: 50, y: y + 20 }, end: { x: 120, y: y + 20 }, thickness: 2, color: brandAccent });
    drawLine(section.heading, { size: 16, font: fontBold, color: brandPrimary, lineHeight: 28 });

    for (const paragraph of section.body.split('\n')) {
      if (!paragraph.trim()) { y -= 10; continue; }
      let line = '';
      for (const word of paragraph.split(' ')) {
        const test = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(test, 11) > maxWidth && line) {
          drawLine(line, { size: 11, font, color: black });
          line = word;
        } else {
          line = test;
        }
      }
      if (line) drawLine(line, { size: 11, font, color: black });
    }
    y -= 20;
  }

  const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
  lastPage.drawText('SCO 45, 2nd Floor, HUDA Market, Sector 31, Gurgaon 122001', {
    x: 50, y: 30, size: 9, font, color: gray,
  });

  const pdfBytes = await pdf.save();
  _pdf = Buffer.from(pdfBytes).toString('base64');
  return { success: true, pages: pdf.getPageCount(), size_kb: Math.round(pdfBytes.length / 1024) };
}

// Direct email send — shared by auto mode and the approve-proposal endpoint
async function sendEmailDirect({ to, subject, body, pdfBase64 }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not configured' };

  const domainVerified = process.env.RESEND_DOMAIN_VERIFIED === 'true';
  const toAddress   = domainVerified ? to : 'samridh.sharma@gmail.com';
  const fromAddress = domainVerified ? 'Sharma Group <proposals@sharmagrp.com>' : 'Sharma Group <onboarding@resend.dev>';

  const payload = { from: fromAddress, to: toAddress, subject, text: body };
  if (pdfBase64) {
    payload.attachments = [{ filename: 'proposal.pdf', content: pdfBase64 }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
    return { success: false, error: `Resend API error: ${res.status}` };
  }
  const data = await res.json();
  return { success: true, email_id: data.id };
}

async function sendEmail({ to, subject, body, attach_pdf }, approvalMode, baseUrl, intakeData) {
  if (approvalMode) {
    // Store pending proposal and email the owner for review
    const pendingId = await store.save({
      prospectEmail:  to,
      prospectName:   _lead?.name     || '',
      company:        _lead?.company  || intakeData?.company  || '',
      challenge:      _lead?.challenge || intakeData?.challenge || '',
      score:          _lead?.score    || 'MEDIUM',
      pdfBase64:      _pdf,
      emailSubject:   subject,
      emailBody:      body,
      intakeData:     intakeData || {},
      agentMessages:  [], // filled in after the agent loop completes
    });

    _pendingId = pendingId;

    // Email owner for review
    const ownerEmail = process.env.OWNER_EMAIL;
    if (ownerEmail) {
      const approvalUrl = `${baseUrl}/api/approve-proposal?id=${pendingId}`;
      await sendEmailDirect({
        to: ownerEmail,
        subject: `[REVIEW REQUIRED] ${subject}`,
        body: [
          `A new proposal is pending your approval.`,
          ``,
          `Approval link: ${approvalUrl}`,
          ``,
          `Lead: ${_lead?.name || 'Unknown'} / ${_lead?.company || 'Unknown'}`,
          `Score: ${_lead?.score || 'Unknown'}`,
          `Challenge: ${_lead?.challenge || ''}`,
          ``,
          `--- Proposed email to visitor ---`,
          ``,
          body,
        ].join('\n'),
        pdfBase64: _pdf,
      });
    }

    console.log(`Approval mode: proposal queued as ${pendingId}`);
    return { success: true, pending: true, proposal_id: pendingId };
  }

  // Auto mode — send directly to visitor
  return sendEmailDirect({ to, subject, body, pdfBase64: attach_pdf ? _pdf : null });
}

async function storeLead(args) {
  _lead = args; // cache for approval mode email

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { success: false, error: 'Supabase not configured' };

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      name:      args.name      || null,
      company:   args.company   || null,
      email:     args.email     || null,
      industry:  args.industry  || null,
      challenge: args.challenge || null,
      budget:    args.budget    || null,
      score:     args.score     || null,
      status:    args.status    || 'proposal_sent',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return { success: false, error: `Supabase error: ${res.status}` };
  }
  return { success: true };
}

async function alertOwner({ message }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_USER_ID;
  if (!botToken || !chatId) return { success: false, error: 'Telegram not configured' };

  const textRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });

  if (!textRes.ok) {
    const err = await textRes.text();
    console.error('Telegram error:', err);
    return { success: false, error: `Telegram error: ${textRes.status}` };
  }

  if (_pdf) {
    const pdfBuffer = Buffer.from(_pdf, 'base64');
    const formData  = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), 'proposal.pdf');
    formData.append('caption', _pendingId ? 'Proposal PDF — pending your approval' : 'Proposal PDF');
    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: formData });
  }

  return { success: true };
}

function executeTool(name, args, ctx) {
  switch (name) {
    case 'render_proposal_pdf': return renderProposalPdf(args);
    case 'send_email':          return sendEmail(args, ctx.approvalMode, ctx.baseUrl, ctx.intakeData);
    case 'store_lead':          return storeLead(args);
    case 'alert_owner':         return alertOwner(args);
    default:                    return Promise.resolve({ error: `Unknown tool: ${name}` });
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(approvalMode, baseUrl) {
  const approvalSection = approvalMode ? `

## APPROVAL MODE IS ACTIVE
You are NOT sending the proposal to the visitor directly.

Required order:
1. Call store_lead first (sets status to pending_approval)
2. Call render_proposal_pdf
3. Call send_email — this queues the proposal. It returns { pending: true, proposal_id: "xxx" }
4. Call alert_owner with a message that:
   - Starts with "[ PENDING APPROVAL ]"
   - Includes: lead name, company, challenge summary, score
   - Includes the full approval URL: ${baseUrl}/api/approve-proposal?id=PROPOSAL_ID
     (replace PROPOSAL_ID with the actual proposal_id returned by send_email)

The visitor will only receive the proposal after the owner approves it at that URL.` : '';

  return `You are an AI agent acting on behalf of Sharma Group, a family-owned industrial and warehouse real estate company in Gurgaon. Operating since 1975, managing over 2 million sq ft across Haryana and Rajasthan. 70+ clients including Audi, Ford, L'Oreal, P&G, DHL, GSK, Pernod Ricard.

Director: Samridh Sharma (Engineer - DCE, MBA - ISB, ex-IBM). All land is owned — no sold parcels.

Services: Multi-client logistic parks (units from 20,000 sq ft), Built-to-suit (BTS) facilities, Automotive and industrial storage, Regional distribution centres, 24-hour facility management.

Available properties:
- Wazirpur: 1,00,000 sq ft, PEB, 6m clear height, Pataudi Road, NH8 access
- Sultanpur: 1,25,000 sq ft, 9.2m clear height, KMP Expressway, Gurgaon

Sectors served: FMCG, Automotive, 3PL/Logistics, Consumer Electronics, Pharma.

## LEAD TRIAGE RULES
HIGH: Space >= 50,000 sq ft + sector match + established company. Also HIGH if: BTS inquiry, regional distribution centre need, timeline < 3 months, or budget > INR 5L/month. 3PL companies default to HIGH. Automotive defaults to HIGH.
MEDIUM: 20,000-50,000 sq ft, relevant sector, Indian SME or growth-stage startup, timeline 3-9 months.
LOW: Under 20,000 sq ft (below minimum), non-relevant sector, individual inquiry, no company, geography mismatch.

## PROPOSAL STRUCTURE
Write 4-5 sections:
1. Understanding Your Requirement — show you listened to their specific situation
2. Why Sharma Group — relevant to their sector and scale, specific properties if applicable
3. Recommended Solution — which service/property, scope, why it fits
4. Commercial Framework — general range, note rates depend on final spec
5. Next Steps — site visit, call with Samridh, timeline to lease

## VOICE
Direct and professional. No fluff. Specific over generic. Reference actual properties (Wazirpur, Sultanpur) when relevant. Don't invent specs — stick to what's in the brief above.

## INSTRUCTIONS
- Score the lead using the triage rules above
- Call store_lead with all lead data and your score${approvalMode ? ' (status: pending_approval)' : ' (status: proposal_sent)'}
- Call render_proposal_pdf with the proposal sections
- Call send_email with the email for the visitor${approvalMode ? ' (will be queued, not sent directly)' : ' and attach the PDF'}
- Call alert_owner with lead summary and score${approvalMode ? ' (see APPROVAL MODE instructions above)' : ''}
- You decide the order of independent tool calls.${approvalSection}`;
}

// ── Agent pipeline — exported for use by approve-proposal.js ─────────────────

async function runAgentPipeline({ intakeData, baseUrl, initialMessages, revisionInstructions, apiKey }) {
  resetState();
  const approvalMode = process.env.APPROVAL_MODE === 'true';
  const key = apiKey || process.env.OPENROUTER_API_KEY;

  let messages;
  if (initialMessages && revisionInstructions) {
    // Revision: append revision request to prior conversation
    messages = [
      ...initialMessages,
      {
        role: 'user',
        content: `Please revise the proposal with these changes:\n\n${revisionInstructions}\n\nRe-render the PDF and re-queue for approval.`,
      },
    ];
  } else {
    messages = [
      { role: 'system', content: buildSystemPrompt(approvalMode, baseUrl) },
      {
        role: 'user',
        content: `VISITOR INTAKE DATA:\n${JSON.stringify(intakeData, null, 2)}\n\nPlease write a personalized proposal, score this lead, and use your tools to process everything.`,
      },
    ];
  }

  const tools = getTools(approvalMode);
  const results = { proposal: false, email: false, stored: false, alerted: false, pendingId: null };
  const ctx = { approvalMode, baseUrl, intakeData };

  console.log(`Agent starting — approval mode: ${approvalMode}, tools: ${tools.map(t => t.function.name).join(', ')}`);

  for (let turn = 1; turn <= 5; turn++) {
    console.log(`Agent turn ${turn}...`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': baseUrl || 'http://localhost:3000',
      },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.6', messages, tools, max_tokens: 4096 }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Agent API error:', err);
      throw new Error(`Agent API call failed: ${response.status}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) { console.error('Agent: no choice in response'); break; }

    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`Agent turn ${turn}: no tool calls — done.`);
      break;
    }

    const toolNames = msg.tool_calls.map(tc => tc.function.name);
    console.log(`Agent turn ${turn}: called ${toolNames.join(', ')}`);

    for (const tc of msg.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments); }
      catch (e) {
        console.error(`Failed to parse args for ${tc.function.name}:`, e.message);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Failed to parse arguments' }) });
        continue;
      }

      const result = await executeTool(tc.function.name, args, ctx);

      if (tc.function.name === 'render_proposal_pdf' && result.success) results.proposal = true;
      if (tc.function.name === 'send_email') {
        if (result.success)   results.email = true;
        if (result.pending_id) results.pendingId = result.pending_id;
        if (result.proposal_id) results.pendingId = result.proposal_id;
      }
      if (tc.function.name === 'store_lead'  && result.success) results.stored  = true;
      if (tc.function.name === 'alert_owner' && result.success) results.alerted = true;

      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  // Backfill agent messages into the pending proposal (needed for revision flow)
  if (_pendingId) {
    results.pendingId = _pendingId;
    await store.update(_pendingId, { agentMessages: messages });
  }

  console.log('Agent pipeline complete:', results);
  return { results, messages };
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { conversation, intakeData } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });
  if (!conversation && !intakeData) return res.status(400).json({ error: 'conversation or intakeData required' });

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://${req.headers.host}`;

  try {
    const { results } = await runAgentPipeline({ intakeData, baseUrl, apiKey });
    return res.json({ success: true, results });
  } catch (err) {
    console.error('Agent handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Named exports for approve-proposal.js
module.exports.runAgentPipeline = runAgentPipeline;
module.exports.sendEmailDirect  = sendEmailDirect;
