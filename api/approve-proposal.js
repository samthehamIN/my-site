'use strict';

// ============================================================================
// PROPOSAL APPROVAL ENDPOINT
// ============================================================================
// GET  /api/approve-proposal?id=xxx         — show approval page
// GET  /api/approve-proposal?id=xxx&dl=pdf  — download the proposal PDF
// POST /api/approve-proposal                — approve or request revisions
//   body: { id, action: 'approve' }
//   body: { id, action: 'revise', instructions: '...' }
// ============================================================================

const store = require('./_store');
const { runAgentPipeline, sendEmailDirect } = require('./generate-proposal');

const SCORE_COLOR = { HIGH: '#4ade80', MEDIUM: '#facc15', LOW: '#f87171' };

function approvalPage({ id, proposal, message, newId }) {
  const score      = proposal?.score    || '—';
  const name       = proposal?.prospectName || '—';
  const company    = proposal?.company  || '—';
  const challenge  = proposal?.challenge || '—';
  const status     = proposal?.status   || 'pending';
  const scoreColor = SCORE_COLOR[score] || '#94a3b8';
  const approved   = status === 'approved';
  const displayId  = newId || id;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Proposal Review — ${company}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'IBM Plex Mono', 'Courier New', monospace;
      background: #0C0F10; color: #EDE8DF;
      min-height: 100vh; padding: 2rem 1rem;
    }
    .wrap { max-width: 600px; margin: 0 auto; }
    .header { margin-bottom: 2rem; }
    .header h1 { font-size: 1.1rem; letter-spacing: .12em; text-transform: uppercase; color: #C8903A; }
    .header p  { font-size: .8rem; color: #8A9BAC; margin-top: .25rem; }
    .card {
      background: #161B1F; border: 1px solid #252D32;
      border-radius: 12px; padding: 1.5rem; margin-bottom: 1.25rem;
    }
    .card-label { font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; color: #8A9BAC; margin-bottom: .2rem; }
    .card-value { font-size: .95rem; color: #EDE8DF; line-height: 1.5; }
    .score-badge {
      display: inline-block; padding: .25rem .75rem;
      border-radius: 100px; font-size: .75rem; font-weight: 700;
      letter-spacing: .08em; text-transform: uppercase;
      color: #0C0F10; background: ${scoreColor};
    }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.25rem; }
    .flash {
      padding: 1rem 1.25rem; border-radius: 8px; margin-bottom: 1.5rem;
      font-size: .875rem; line-height: 1.5;
    }
    .flash.success { background: rgba(74,222,128,.12); border: 1px solid rgba(74,222,128,.3); color: #4ade80; }
    .flash.info    { background: rgba(200,144,58,.10); border: 1px solid rgba(200,144,58,.3); color: #C8903A; }
    .actions { display: flex; flex-direction: column; gap: 1rem; }
    .btn {
      width: 100%; padding: .875rem 1.5rem; border: none; border-radius: 8px;
      font-family: inherit; font-size: .9rem; font-weight: 600;
      letter-spacing: .05em; text-transform: uppercase; cursor: pointer;
    }
    .btn-approve { background: #C8903A; color: #0C0F10; }
    .btn-approve:hover { background: #D9A84B; }
    .btn-approve:disabled { opacity: .5; cursor: not-allowed; }
    .btn-pdf {
      display: block; width: 100%; padding: .75rem 1.5rem;
      background: #161B1F; border: 1px solid #252D32; border-radius: 8px;
      font-family: inherit; font-size: .85rem; letter-spacing: .05em;
      text-transform: uppercase; text-align: center; text-decoration: none;
      color: #8A9BAC; margin-bottom: 1rem;
    }
    .btn-pdf:hover { border-color: #C8903A; color: #C8903A; }
    .revise-section { margin-top: .5rem; }
    .revise-section summary {
      cursor: pointer; font-size: .85rem; color: #8A9BAC; letter-spacing: .04em;
      padding: .5rem 0; list-style: none;
    }
    .revise-section summary:hover { color: #EDE8DF; }
    textarea {
      width: 100%; margin-top: .75rem; padding: .875rem 1rem;
      background: #0C0F10; border: 1px solid #252D32; border-radius: 8px;
      font-family: inherit; font-size: .875rem; color: #EDE8DF;
      resize: vertical; min-height: 100px; outline: none;
    }
    textarea:focus { border-color: rgba(200,144,58,.45); }
    .btn-revise {
      margin-top: .75rem; width: 100%; padding: .75rem;
      background: transparent; border: 1px solid #252D32; border-radius: 8px;
      font-family: inherit; font-size: .85rem; color: #8A9BAC;
      letter-spacing: .05em; text-transform: uppercase; cursor: pointer;
    }
    .btn-revise:hover { border-color: #C8903A; color: #C8903A; }
    .approved-label {
      text-align: center; padding: 1.5rem;
      font-size: .85rem; letter-spacing: .1em; color: #4ade80; text-transform: uppercase;
    }
  </style>
</head>
<body>
<div class="wrap">

  <div class="header">
    <h1>Proposal Review</h1>
    <p>Review the proposal before it's sent to the visitor.</p>
  </div>

  ${message ? `<div class="flash ${message.type}">${message.text}</div>` : ''}

  <div class="row">
    <div class="card">
      <div class="card-label">Lead</div>
      <div class="card-value">${name}</div>
    </div>
    <div class="card">
      <div class="card-label">Company</div>
      <div class="card-value">${company}</div>
    </div>
  </div>

  <div class="card" style="margin-bottom:1.25rem;">
    <div class="card-label">Challenge</div>
    <div class="card-value">${challenge}</div>
  </div>

  <div class="card" style="margin-bottom:1.75rem; display:inline-flex; gap:1rem; align-items:center; width:100%;">
    <div>
      <div class="card-label">Score</div>
      <div style="margin-top:.35rem;"><span class="score-badge">${score}</span></div>
    </div>
  </div>

  <a class="btn-pdf" href="/api/approve-proposal?id=${displayId}&dl=pdf">
    Download Proposal PDF
  </a>

  ${approved ? `<div class="approved-label">Proposal approved and sent.</div>` : `
  <div class="actions">
    <form method="POST" action="/api/approve-proposal">
      <input type="hidden" name="id" value="${displayId}"/>
      <input type="hidden" name="action" value="approve"/>
      <button type="submit" class="btn btn-approve">Approve &amp; Send to Visitor</button>
    </form>

    <details class="revise-section">
      <summary>Request changes instead &rsaquo;</summary>
      <form method="POST" action="/api/approve-proposal">
        <input type="hidden" name="id" value="${displayId}"/>
        <input type="hidden" name="action" value="revise"/>
        <textarea name="instructions" placeholder="Describe what should change in the proposal…" required></textarea>
        <button type="submit" class="btn-revise">Send for Revision</button>
      </form>
    </details>
  </div>
  `}

</div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const rawUrl = req.url || '';
  const qIdx   = rawUrl.indexOf('?');
  const params  = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : new URLSearchParams();

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const id = params.get('id');
    if (!id) return res.status(400).send('Missing proposal id');

    const proposal = await store.get(id);
    if (!proposal) return res.status(404).send('Proposal not found. It may have expired (in-memory store resets on server restart).');

    // PDF download
    if (params.get('dl') === 'pdf') {
      if (!proposal.pdfBase64) return res.status(404).send('PDF not available');
      const buf = Buffer.from(proposal.pdfBase64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="proposal-${id}.pdf"`);
      return res.end(buf);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.end(approvalPage({ id, proposal }));
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { id, action, instructions } = body;

    if (!id || !action) return res.status(400).json({ error: 'id and action required' });

    const proposal = await store.get(id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    // ── Approve ───────────────────────────────────────────────────────────────
    if (action === 'approve') {
      if (proposal.status === 'approved') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(approvalPage({ id, proposal, message: { type: 'info', text: 'Already approved.' } }));
      }

      const result = await sendEmailDirect({
        to:        proposal.prospectEmail,
        subject:   proposal.emailSubject,
        body:      proposal.emailBody,
        pdfBase64: proposal.pdfBase64,
      });

      if (!result.success) {
        res.setHeader('Content-Type', 'text/html');
        return res.end(approvalPage({ id, proposal, message: { type: 'info', text: `Failed to send email: ${result.error}` } }));
      }

      await store.update(id, { status: 'approved' });

      // Telegram confirmation
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId   = process.env.TELEGRAM_USER_ID;
      if (botToken && chatId) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `Proposal APPROVED and sent to ${proposal.prospectEmail} (${proposal.company} — ${proposal.score})`,
          }),
        });
      }

      res.setHeader('Content-Type', 'text/html');
      return res.end(approvalPage({
        id,
        proposal: { ...proposal, status: 'approved' },
        message: { type: 'success', text: `Proposal sent to ${proposal.prospectEmail}.` },
      }));
    }

    // ── Revise ────────────────────────────────────────────────────────────────
    if (action === 'revise') {
      if (!instructions || !instructions.trim()) {
        res.setHeader('Content-Type', 'text/html');
        return res.end(approvalPage({ id, proposal, message: { type: 'info', text: 'Please provide revision instructions.' } }));
      }

      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `http://${req.headers.host}`;

      let newId;
      try {
        const { results } = await runAgentPipeline({
          baseUrl,
          initialMessages:      proposal.agentMessages,
          revisionInstructions: instructions.trim(),
          apiKey:               process.env.OPENROUTER_API_KEY,
        });
        newId = results.pendingId;
      } catch (err) {
        console.error('Revision agent error:', err.message);
        res.setHeader('Content-Type', 'text/html');
        return res.end(approvalPage({ id, proposal, message: { type: 'info', text: `Revision failed: ${err.message}` } }));
      }

      if (!newId) {
        res.setHeader('Content-Type', 'text/html');
        return res.end(approvalPage({ id, proposal, message: { type: 'info', text: 'Revision complete but no new proposal ID — check server logs.' } }));
      }

      // Redirect to the new proposal's approval page
      res.setHeader('Location', `/api/approve-proposal?id=${newId}`);
      return res.status(302).end();
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
