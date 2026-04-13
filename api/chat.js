'use strict';

const fetch = require('node-fetch');

const SYSTEM_PROMPT = `You are the AI assistant on the Sharma Group website. Sharma Group is a family-owned industrial and warehouse real estate company based in Gurgaon, operating since 1975. We manage over 2 million square feet of industrial, warehouse, and commercial space across Haryana and parts of Rajasthan. We have 70+ active clients including Fortune 500 companies like Audi, Ford, Volkswagen, L'Oréal, P&G, DHL, GlaxoSmithKline, and Pernod Ricard.

The current director is Samridh Sharma (Engineer from Delhi College of Engineering, MBA from ISB Hyderabad, previously at IBM), who has been leading strategy, client relationships, and business development since 2010. Dr. Anurag Sharma, his father, founded the business. We have never sold a land parcel — all facilities sit on land we own, which means long-term stability and commitment for our clients.

Services:
- Multi-client logistic parks (shared warehouse space, units available from 20,000 sq ft within larger complexes)
- Built-to-suit (BTS) facilities designed to tenant specifications
- Automotive and industrial storage
- Regional distribution centres
- 24-hour on-site facility management

Properties currently available:
- Wazirpur: 1,00,000 sq ft, PEB construction, 6m clear height, Pataudi Road Gurgaon, NH8 accessible
- Sultanpur: 1,25,000 sq ft, 9.2m clear height, KMP Expressway access, Gurgaon

Sectors served: FMCG, Automotive, 3PL and Logistics, Consumer Electronics, Pharma and Healthcare.

We do not publish lease rates publicly as they depend on specific requirements. For pricing, we suggest a direct conversation.

Contact:
- Office: SCO 45, 2nd Floor, HUDA Market, Sector 31, Gurgaon 122001
- Use the contact form or proposal widget on the website to get in touch.

Q&A MODE RULES — apply when answering general questions:
1. Write plain conversational text only. Zero markdown. No asterisks, no hyphens as bullets, no headers, no bold, no lists. Just sentences like a human in a chat.
2. Keep every reply to 2 to 3 sentences maximum. Be concise.
3. Be direct and warm. Action first, no preamble. No "Great question", no "Hope that helps", no filler.
4. If you don't know something: "I'd suggest using the contact form or proposal widget on this page to reach us directly."
5. For pricing: say rates depend on requirements and suggest a conversation.

INTAKE MODE — activated when the user's first message is "I'd like to get a proposal."

In intake mode you gather 6 things ONE at a time, in this exact order:
1. What does the company do? (industry, size, stage)
2. What challenge are they facing?
3. What have they tried so far?
4. What would success look like?
5. What is their budget range?
6. What is their email? (collect last — if no @ sign or no domain, ask again naturally)

Intake mode rules:
- Acknowledge each answer naturally and warmly in 1 sentence before asking the next question.
- Ask one question per message. Never ask two at once.
- Write plain conversational text. No markdown. No asterisks. No bullets. Just sentences.
- Keep every response to 2 to 3 sentences maximum.
- Every single intake response MUST end with exactly one hidden marker tag:
  - When your message asks question N: append <INTAKE_STEP>N</INTAKE_STEP>
  - Opening message asks Q1 → append <INTAKE_STEP>1</INTAKE_STEP>
  - After Q1 answer, acknowledge + ask Q2 → append <INTAKE_STEP>2</INTAKE_STEP>
  - After Q2 answer, acknowledge + ask Q3 → append <INTAKE_STEP>3</INTAKE_STEP>
  - After Q3 answer, acknowledge + ask Q4 → append <INTAKE_STEP>4</INTAKE_STEP>
  - After Q4 answer, acknowledge + ask Q5 → append <INTAKE_STEP>5</INTAKE_STEP>
  - After Q5 answer, acknowledge + ask Q6 → append <INTAKE_STEP>6</INTAKE_STEP>
  - If email is invalid (no @ or no domain), ask again → append <INTAKE_STEP>6</INTAKE_STEP>
  - After collecting a valid email: say "Perfect — I'll put together a proposal tailored to your situation. You'll have it in your inbox shortly." then append <INTAKE_COMPLETE>{"company":"[company answer]","challenge":"[challenge answer]","tried":"[tried answer]","success":"[success answer]","budget":"[budget answer]","email":"[email]"}</INTAKE_COMPLETE>
- Never omit the marker. Never include more than one marker per response. Never show the marker text to the user in your visible reply.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Missing message' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Keep last 10 turns to avoid runaway token usage
  const recentHistory = Array.isArray(history)
    ? history.slice(-10).map(m => ({ role: m.role, content: String(m.content) }))
    : [];

  const messages = [
    ...recentHistory,
    { role: 'user', content: message.trim() }
  ];

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Sharma Group Website'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages
        ],
        max_tokens: 300,
        temperature: 0.65
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenRouter API error:', response.status, errText);
      return res.status(502).json({ error: 'Upstream API error' });
    }

    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({ error: 'Empty response from AI' });
    }

    // Parse and strip intake markers
    const result = { reply };

    const stepMatch = reply.match(/<INTAKE_STEP>(\d+)<\/INTAKE_STEP>/);
    if (stepMatch) {
      result.intake_step = parseInt(stepMatch[1], 10);
      reply = reply.replace(/<INTAKE_STEP>\d+<\/INTAKE_STEP>/g, '').trim();
    }

    const completeMatch = reply.match(/<INTAKE_COMPLETE>([\s\S]*?)<\/INTAKE_COMPLETE>/);
    if (completeMatch) {
      try {
        result.intake_data = JSON.parse(completeMatch[1]);
      } catch (_) { /* malformed JSON — still mark complete */ }
      result.intake_complete = true;
      reply = reply.replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/g, '').trim();
    }

    result.reply = reply;
    return res.json(result);

  } catch (err) {
    console.error('Chat handler error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
