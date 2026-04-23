/**
 * CADAM Local Development Server
 *
 * A lightweight Express server that mocks the Supabase backend (Auth, PostgREST,
 * Edge Functions) and proxies AI generation requests to the Poe API.
 *
 * Usage:
 *   node local-server.js
 *
 * The server listens on port 54321 (the default Supabase local port).
 * The Vite frontend should be configured to send requests here via
 * VITE_SUPABASE_URL="http://127.0.0.1:54321" in .env.local.
 *
 * --- Poe API Key ---
 * Set the POE_API_KEY environment variable or edit the fallback below.
 */

import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = 54321;

// ---------------------------------------------------------------------------
// Poe API configuration
// ---------------------------------------------------------------------------
const POE_API_KEY = process.env.POE_API_KEY || 'YOUR_POE_API_KEY_HERE';
const POE_API_URL = 'https://api.poe.com/v1/chat/completions';

// Map frontend model IDs to Poe bot names.
// Update this object when Poe deprecates or renames bots.
const MODEL_MAP = {
  'google/gemini-3.1-pro-preview': 'gemini-3.1-pro',
  'anthropic/claude-opus-4.7': 'claude-opus-4.7',
  'anthropic/claude-3.5-haiku': 'claude-haiku-4.5',
  'openai/gpt-5.4': 'gpt-5.4',
  'z-ai/glm-5.1': 'glm-5.1',
};

// ---------------------------------------------------------------------------
// Fake user for auth mock
// ---------------------------------------------------------------------------
const FAKE_USER = {
  id: 'local-dev-user-00000000-0000-0000-0000-000000000000',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'localdev@cadam.local',
  email_confirmed_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Local Developer' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const FAKE_SESSION = {
  access_token: 'fake-access-token-for-local-dev',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'fake-refresh-token',
  user: FAKE_USER,
};

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------
let conversations = [];
let messages = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Supabase PostgREST query-string filter parser */
function filterByQuery(items, query) {
  let result = [...items];
  for (const [key, value] of Object.entries(query)) {
    if (
      key === 'select' ||
      key === 'order' ||
      key === 'limit' ||
      key === 'offset'
    )
      continue;
    const eqMatch = String(value).match(/^eq\.(.+)$/);
    if (eqMatch) {
      result = result.filter((item) => String(item[key]) === eqMatch[1]);
      continue;
    }
    const inMatch = String(value).match(/^in\.\((.+)\)$/);
    if (inMatch) {
      const vals = inMatch[1].split(',').map((v) => v.replace(/^"|"$/g, ''));
      result = result.filter((item) => vals.includes(String(item[key])));
      continue;
    }
    const neqMatch = String(value).match(/^neq\.(.+)$/);
    if (neqMatch) {
      result = result.filter((item) => String(item[key]) !== neqMatch[1]);
      continue;
    }
  }

  // Handle order
  if (query.order) {
    const parts = String(query.order).split('.');
    const field = parts[0];
    const dir = parts[1] === 'desc' ? -1 : 1;
    result.sort((a, b) => {
      if (a[field] < b[field]) return -1 * dir;
      if (a[field] > b[field]) return 1 * dir;
      return 0;
    });
  }

  return result;
}

function resolveModel(model) {
  return MODEL_MAP[model] || model;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  );
  res.header('Access-Control-Expose-Headers', 'Content-Range');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// Auth mock endpoints
// ---------------------------------------------------------------------------
app.get('/auth/v1/user', (_req, res) => res.json(FAKE_USER));
app.post('/auth/v1/token', (_req, res) => res.json(FAKE_SESSION));
app.get('/auth/v1/session', (_req, res) =>
  res.json({ data: { session: FAKE_SESSION } }),
);
app.post('/auth/v1/signup', (_req, res) =>
  res.json({ user: FAKE_USER, session: FAKE_SESSION }),
);
app.post('/auth/v1/logout', (_req, res) => res.json({}));

// ---------------------------------------------------------------------------
// PostgREST mock – conversations
// ---------------------------------------------------------------------------
app.get('/rest/v1/conversations', (req, res) => {
  const filtered = filterByQuery(conversations, req.query);
  const wantSingle = req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  if (wantSingle) {
    return res.json(filtered[0] || null);
  }
  res.json(filtered);
});

app.post('/rest/v1/conversations', (req, res) => {
  const conv = {
    id: req.body.id || crypto.randomUUID(),
    user_id: FAKE_USER.id,
    title: req.body.title || 'New Conversation',
    type: req.body.type || 'parametric',
    current_message_leaf_id: req.body.current_message_leaf_id || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...req.body,
  };
  conversations.push(conv);

  const wantReturn = req.headers.prefer?.includes('return=representation');
  const wantSingle = req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  if (wantReturn) {
    return res.status(201).json(wantSingle ? conv : [conv]);
  }
  res.status(201).json(conv);
});

app.patch('/rest/v1/conversations', (req, res) => {
  const filtered = filterByQuery(conversations, req.query);
  filtered.forEach((c) =>
    Object.assign(c, req.body, { updated_at: new Date().toISOString() }),
  );

  const wantReturn = req.headers.prefer?.includes('return=representation');
  const wantSingle = req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  if (wantReturn) {
    return res.json(wantSingle ? filtered[0] : filtered);
  }
  res.sendStatus(204);
});

app.delete('/rest/v1/conversations', (req, res) => {
  const toDelete = filterByQuery(conversations, req.query);
  const ids = new Set(toDelete.map((c) => c.id));
  conversations = conversations.filter((c) => !ids.has(c.id));
  messages = messages.filter((m) => !ids.has(m.conversation_id));
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// PostgREST mock – messages
// ---------------------------------------------------------------------------
app.get('/rest/v1/messages', (req, res) => {
  const filtered = filterByQuery(messages, req.query);
  const wantSingle = req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  if (wantSingle) {
    return res.json(filtered[0] || null);
  }
  res.json(filtered);
});

app.post('/rest/v1/messages', (req, res) => {
  const msg = {
    id: req.body.id || crypto.randomUUID(),
    conversation_id: req.body.conversation_id,
    role: req.body.role || 'user',
    content: req.body.content || {},
    parent_message_id: req.body.parent_message_id || null,
    created_at: new Date().toISOString(),
    ...req.body,
  };
  messages.push(msg);

  const wantReturn = req.headers.prefer?.includes('return=representation');
  const wantSingle = req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  if (wantReturn) {
    return res.status(201).json(wantSingle ? msg : [msg]);
  }
  res.status(201).json(msg);
});

app.patch('/rest/v1/messages', (req, res) => {
  const filtered = filterByQuery(messages, req.query);
  filtered.forEach((m) => Object.assign(m, req.body));

  const wantReturn = req.headers.prefer?.includes('return=representation');
  const wantSingle = req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  if (wantReturn) {
    return res.json(wantSingle ? filtered[0] : filtered);
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// PostgREST mock – profiles (stub)
// ---------------------------------------------------------------------------
app.get('/rest/v1/profiles', (_req, res) => {
  const profile = {
    user_id: FAKE_USER.id,
    full_name: 'Local Developer',
    notifications_enabled: false,
  };
  const wantSingle = _req.headers.accept?.includes(
    'application/vnd.pgrst.object',
  );
  res.json(wantSingle ? profile : [profile]);
});

// ---------------------------------------------------------------------------
// Edge Functions mock – billing (stub, always allows)
// ---------------------------------------------------------------------------
app.post('/functions/v1/billing-status', (_req, res) => {
  res.json({
    user: {
      email: FAKE_USER.email,
      hasTrialed: true,
      subscription: null,
    },
    tokens: { balance: 9999, used: 0 },
    subscription: { status: 'active', plan: 'local-dev' },
  });
});

app.post('/functions/v1/billing-checkout', (_req, res) => {
  res.json({ url: 'http://localhost:3004' });
});

app.post('/functions/v1/billing-portal', (_req, res) => {
  res.json({ url: 'http://localhost:3004' });
});

app.get('/functions/v1/billing-products', (_req, res) => {
  res.json({ products: [] });
});

// ---------------------------------------------------------------------------
// Edge Functions mock – title-generator (proxied to Poe)
// ---------------------------------------------------------------------------
app.post('/functions/v1/title-generator', async (req, res) => {
  const { content } = req.body;
  const userText = content?.text || 'New Conversation';

  try {
    const poeRes = await fetch(POE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POE_API_KEY}`,
      },
      body: JSON.stringify({
        model: resolveModel('anthropic/claude-3.5-haiku'),
        messages: [
          {
            role: 'system',
            content:
              'Generate a concise, descriptive title (under 80 characters) for this conversation. Return only the title, no formatting.',
          },
          { role: 'user', content: userText },
        ],
        max_tokens: 100,
        stream: false,
      }),
    });

    const data = await poeRes.json();
    const title =
      data.choices?.[0]?.message?.content?.trim() || 'New Conversation';
    res.json({ title });
  } catch (err) {
    console.error('[title-generator] Error:', err.message);
    res.json({ title: 'New Conversation' });
  }
});

// ---------------------------------------------------------------------------
// Edge Functions mock – parametric-chat (proxied to Poe, streaming)
// ---------------------------------------------------------------------------
app.post('/functions/v1/parametric-chat', async (req, res) => {
  const { conversationId, messageId, model, newMessageId } = req.body;

  // Fetch conversation messages from in-memory store
  const convMessages = messages
    .filter((m) => m.conversation_id === conversationId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // Build message list for Poe API
  const systemPrompt = `You are Adam, an AI CAD editor that creates and modifies OpenSCAD models.
Speak back to the user briefly (one or two sentences), then provide OpenSCAD code.
When a user requests a new part, generate complete OpenSCAD code.
Write code with changeable parameters. Use descriptive snake_case variable names.
When the model has distinct parts, wrap each in a color() call.
Initialize and declare variables at the start of the code.
Return ONLY raw OpenSCAD code after your brief response. Do NOT wrap it in markdown code blocks.`;

  const poeMessages = [{ role: 'system', content: systemPrompt }];

  for (const m of convMessages) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    let text = '';
    if (m.content?.text) text = m.content.text;
    else if (m.content?.artifact?.code) text = m.content.artifact.code;
    else if (typeof m.content === 'string') text = m.content;
    if (text) poeMessages.push({ role, content: text });
  }

  // Insert placeholder assistant message
  const assistantMsg = {
    id: newMessageId || crypto.randomUUID(),
    conversation_id: conversationId,
    role: 'assistant',
    content: { model: model || 'google/gemini-3.1-pro-preview' },
    parent_message_id: messageId,
    created_at: new Date().toISOString(),
  };
  messages.push(assistantMsg);

  const poeModel = resolveModel(model || 'google/gemini-3.1-pro-preview');

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const poeRes = await fetch(POE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POE_API_KEY}`,
      },
      body: JSON.stringify({
        model: poeModel,
        messages: poeMessages,
        stream: true,
        max_tokens: 4096,
      }),
    });

    if (!poeRes.ok) {
      const errText = await poeRes.text();
      console.error('[parametric-chat] Poe API error:', poeRes.status, errText);
      assistantMsg.content.text = `Error: Poe API returned ${poeRes.status}`;
      assistantMsg.content.done = true;
      res.write(JSON.stringify(assistantMsg) + '\n');
      return res.end();
    }

    let fullText = '';
    const reader = poeRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            assistantMsg.content.text = fullText;
            res.write(JSON.stringify(assistantMsg) + '\n');
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }

    // Finalize the message
    assistantMsg.content.text = fullText;
    assistantMsg.content.done = true;
    res.write(JSON.stringify(assistantMsg) + '\n');
    res.end();
  } catch (err) {
    console.error('[parametric-chat] Error:', err.message);
    assistantMsg.content.text = `Error: ${err.message}`;
    assistantMsg.content.done = true;
    res.write(JSON.stringify(assistantMsg) + '\n');
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Edge Functions mock – creative-chat (proxied to Poe, streaming)
// ---------------------------------------------------------------------------
app.post('/functions/v1/creative-chat', async (req, res) => {
  const { conversationId, messageId, model, newMessageId } = req.body;

  const convMessages = messages
    .filter((m) => m.conversation_id === conversationId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const poeMessages = [
    {
      role: 'system',
      content:
        'You are Adam, an AI assistant for 3D modeling. Help the user with their creative modeling requests. Be concise and helpful.',
    },
  ];

  for (const m of convMessages) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    let text = '';
    if (m.content?.text) text = m.content.text;
    else if (typeof m.content === 'string') text = m.content;
    if (text) poeMessages.push({ role, content: text });
  }

  const assistantMsg = {
    id: newMessageId || crypto.randomUUID(),
    conversation_id: conversationId,
    role: 'assistant',
    content: { model: model || 'quality' },
    parent_message_id: messageId,
    created_at: new Date().toISOString(),
  };
  messages.push(assistantMsg);

  const poeModel = resolveModel(model || 'anthropic/claude-3.5-haiku');

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const poeRes = await fetch(POE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POE_API_KEY}`,
      },
      body: JSON.stringify({
        model: poeModel,
        messages: poeMessages,
        stream: true,
        max_tokens: 4096,
      }),
    });

    if (!poeRes.ok) {
      const errText = await poeRes.text();
      console.error('[creative-chat] Poe API error:', poeRes.status, errText);
      assistantMsg.content.text = `Error: Poe API returned ${poeRes.status}`;
      assistantMsg.content.done = true;
      res.write(JSON.stringify(assistantMsg) + '\n');
      return res.end();
    }

    let fullText = '';
    const reader = poeRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            assistantMsg.content.text = fullText;
            res.write(JSON.stringify(assistantMsg) + '\n');
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }

    assistantMsg.content.text = fullText;
    assistantMsg.content.done = true;
    res.write(JSON.stringify(assistantMsg) + '\n');
    res.end();
  } catch (err) {
    console.error('[creative-chat] Error:', err.message);
    assistantMsg.content.text = `Error: ${err.message}`;
    assistantMsg.content.done = true;
    res.write(JSON.stringify(assistantMsg) + '\n');
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Edge Functions mock – prompt-generator (stub)
// ---------------------------------------------------------------------------
app.post('/functions/v1/prompt-generator', async (req, res) => {
  const { prompt } = req.body;
  res.json({
    generated_prompt: prompt || 'A 3D printable object',
  });
});

// ---------------------------------------------------------------------------
// Edge Functions mock – jackson-pollock / posthog proxy (stub)
// ---------------------------------------------------------------------------
app.all('/functions/v1/jackson-pollock', (_req, res) => {
  res.json({ status: 'ok' });
});
app.all('/functions/v1/jackson-pollock/*', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Edge Functions mock – delete-user (stub)
// ---------------------------------------------------------------------------
app.post('/functions/v1/delete-user', (_req, res) => {
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Edge Functions mock – mesh (stub)
// ---------------------------------------------------------------------------
app.post('/functions/v1/mesh', (_req, res) => {
  res.json({ id: crypto.randomUUID(), status: 'pending' });
});

// ---------------------------------------------------------------------------
// Catch-all for any other Supabase requests
// ---------------------------------------------------------------------------
app.all('/rest/v1/*', (req, res) => {
  console.warn(
    `[mock] Unhandled PostgREST request: ${req.method} ${req.originalUrl}`,
  );
  res.json([]);
});

app.all('/functions/v1/*', (req, res) => {
  console.warn(
    `[mock] Unhandled Edge Function: ${req.method} ${req.originalUrl}`,
  );
  res.json({ status: 'ok' });
});

app.all('/storage/v1/*', (req, res) => {
  console.warn(
    `[mock] Unhandled Storage request: ${req.method} ${req.originalUrl}`,
  );
  res.json({});
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `\n  CADAM Local Mock Server running on http://127.0.0.1:${PORT}`,
  );
  console.log(
    '  Poe API Key:',
    POE_API_KEY === 'YOUR_POE_API_KEY_HERE' ? '(not set)' : 'configured',
  );
  console.log('  MODEL_MAP:', JSON.stringify(MODEL_MAP, null, 2));
  console.log('\n  Endpoints:');
  console.log('    Auth:       /auth/v1/*');
  console.log('    Database:   /rest/v1/conversations, /rest/v1/messages');
  console.log('    Functions:  /functions/v1/parametric-chat');
  console.log('                /functions/v1/creative-chat');
  console.log('                /functions/v1/title-generator');
  console.log('');
});
