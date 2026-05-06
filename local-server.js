import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Load .env.local into process.env (Node doesn't do this natively)
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8')
    .split('\n')
    .forEach((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        val = val.replace(/^["']|["']$/g, ''); // strip quotes
        if (!process.env[key]) process.env[key] = val;
      }
    });
}

const app = express();
const PORT = 54321;

const POE_API_KEY = process.env.POE_API_KEY || ''; // Load from .env.local

// Poe API via OpenAI-compatible endpoint
const poe = new OpenAI({
  apiKey: POE_API_KEY,
  baseURL: 'https://api.poe.com/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://adam-cad.com',
    'X-Title': 'Adam CAD',
  },
});

// Map frontend model IDs to Poe bot names
const MODEL_MAP = {
  'google/gemini-3.1-pro-preview': 'gemini-3.1-pro',
  'anthropic/claude-opus-4.7': 'claude-opus-4.7',
  'openai/gpt-5.5': 'gpt-5.5',
  'openai/gpt-5.5-pro': 'gpt-5.5-pro',
  'moonshotai/kimi-k2.6': 'gpt-5.5-pro', // fallback for legacy refs
  fast: 'gemini-3.1-pro',
  quality: 'claude-opus-4.7',
};

function mapModel(frontendModel) {
  return MODEL_MAP[frontendModel] || 'gemini-3.1-pro';
}

// In-memory stores
const conversations = new Map();
const messages = new Map();

// Fake user
const FAKE_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'local@adam-cad.com',
  aud: 'authenticated',
  role: 'authenticated',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  app_metadata: { provider: 'email' },
  user_metadata: { full_name: 'Local User' },
};

const FAKE_SESSION = {
  access_token: 'fake-access-token',
  token_type: 'bearer',
  expires_in: 86400,
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  refresh_token: 'fake-refresh-token',
  user: FAKE_USER,
};

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ['content-range', 'x-total-count', 'apikey'],
  }),
);
app.use(express.json({ limit: '50mb' }));

// Log all requests for debugging
app.use((req, res, next) => {
  if (!req.url.includes('/realtime/')) {
    console.log(`[${req.method}] ${req.url}`);
  }
  next();
});

// Helper: filter array by PostgREST query params (key=eq.value)
function filterByQuery(items, query) {
  let result = [...items];
  for (const [key, val] of Object.entries(query)) {
    if (
      key === 'select' ||
      key === 'order' ||
      key === 'limit' ||
      key === 'offset'
    )
      continue;
    const str = String(val);
    const eqMatch = str.match(/^eq\.(.+)/);
    if (eqMatch) {
      result = result.filter((item) => String(item[key]) === eqMatch[1]);
    }
  }
  return result;
}

// Helper: return single or array based on Accept header
function sendResult(req, res, items) {
  const accept = req.headers['accept'] || '';
  if (
    accept.includes('vnd.pgrst.object') ||
    accept.includes('application/vnd.pgrst.object+json')
  ) {
    return res.json(items[0] || null);
  }
  return res.json(items);
}

// -- Auth endpoints --
app.post('/auth/v1/token', (req, res) => {
  res.json(FAKE_SESSION);
});

app.get('/auth/v1/user', (req, res) => {
  res.json(FAKE_USER);
});

app.post('/auth/v1/signup', (req, res) => {
  res.json({ user: FAKE_USER, session: FAKE_SESSION });
});

app.post('/auth/v1/magiclink', (req, res) => {
  res.json({});
});

app.post('/auth/v1/otp', (req, res) => {
  res.json({});
});

app.post('/auth/v1/recover', (req, res) => {
  res.json({});
});

app.put('/auth/v1/user', (req, res) => {
  res.json(FAKE_USER);
});

app.post('/auth/v1/logout', (req, res) => {
  res.status(204).send();
});

// -- REST / PostgREST endpoints --

// RPC: user_extradata (legacy fallback)
app.post('/rest/v1/rpc/user_extradata', (req, res) => {
  res.json({
    sublevel: 'pro',
    hasTrialed: true,
    subscriptionTokens: 9999,
    purchasedTokens: 0,
    totalTokens: 9999,
    subscriptionTokenLimit: 10000,
    subscriptionExpiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
  });
});

// Conversations
app.get('/rest/v1/conversations', (req, res) => {
  let all = [...conversations.values()];
  all = filterByQuery(all, req.query);
  all.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  sendResult(req, res, all);
});

app.post('/rest/v1/conversations', (req, res) => {
  const conv = Array.isArray(req.body) ? req.body[0] : req.body;
  conv.created_at = conv.created_at || new Date().toISOString();
  conv.updated_at = conv.updated_at || new Date().toISOString();
  conversations.set(conv.id, conv);
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  res.status(201).json(conv);
});

app.patch('/rest/v1/conversations', (req, res) => {
  const idMatch = (req.query.id || '').match(/eq\.(.+)/);
  if (idMatch) {
    const conv = conversations.get(idMatch[1]);
    if (conv) {
      Object.assign(conv, req.body, { updated_at: new Date().toISOString() });
      return sendResult(req, res, [conv]);
    }
  }
  sendResult(req, res, [req.body]);
});

// Messages
app.get('/rest/v1/messages', (req, res) => {
  const cidMatch = (req.query.conversation_id || '').match(/eq\.(.+)/);
  if (cidMatch) {
    let msgs = messages.get(cidMatch[1]) || [];
    msgs = filterByQuery(msgs, req.query);
    return sendResult(req, res, msgs);
  }
  let all = [];
  for (const msgs of messages.values()) all.push(...msgs);
  all = filterByQuery(all, req.query);
  sendResult(req, res, all);
});

app.post('/rest/v1/messages', (req, res) => {
  const msg = Array.isArray(req.body) ? req.body[0] : req.body;
  msg.id = msg.id || crypto.randomUUID();
  msg.created_at = msg.created_at || new Date().toISOString();
  msg.rating = msg.rating ?? null;

  const convMsgs = messages.get(msg.conversation_id) || [];
  convMsgs.push(msg);
  messages.set(msg.conversation_id, convMsgs);

  console.log(
    `[DB] Stored message ${msg.id} (${msg.role}) in conv ${msg.conversation_id}`,
  );
  sendResult(req, res, [msg]);
});

app.patch('/rest/v1/messages', (req, res) => {
  const idMatch = (req.query.id || '').match(/eq\.(.+)/);
  const cidMatch = (req.query.conversation_id || '').match(/eq\.(.+)/);
  if (idMatch && cidMatch) {
    const convMsgs = messages.get(cidMatch[1]) || [];
    const idx = convMsgs.findIndex((m) => m.id === idMatch[1]);
    if (idx >= 0) {
      Object.assign(convMsgs[idx], req.body);
      return sendResult(req, res, [convMsgs[idx]]);
    }
  }
  sendResult(req, res, [req.body]);
});

// Images & Meshes (just acknowledge)
app.post('/rest/v1/images', (req, res) => res.status(201).json(req.body));
app.post('/rest/v1/meshes', (req, res) => res.status(201).json(req.body));

// Supabase Storage Mock
app.post('/storage/v1/object/images/:splat', (req, res) => {
  const fileName = req.params.splat || 'mock-image.png';
  res.status(200).json({ Key: 'images/' + fileName });
});

app.post('/storage/v1/object/sign/images/:splat', (req, res) => {
  const fileName = req.params.splat || 'mock-image.png';
  res
    .status(200)
    .json({
      signedURL: 'http://127.0.0.1:' + PORT + '/mock-storage/' + fileName,
    });
});

// Profiles
app.get('/rest/v1/profiles', (req, res) => {
  res.json({
    user_id: FAKE_USER.id,
    full_name: 'Local User',
    notifications_enabled: false,
  });
});

// -- Realtime (stub WebSocket) --
app.get('/realtime/v1/websocket', (req, res) => {
  res.status(200).send('OK');
});

// -- Edge Functions --

// OpenSCAD system prompt
const STRICT_CODE_PROMPT = `You are Adam, an AI CAD editor that creates and modifies OpenSCAD models.
Return ONLY raw OpenSCAD code. DO NOT wrap it in markdown code blocks.
Write code with changeable parameters. Never include parameters to adjust color.
Initialize and declare the variables at the start of the code.
Always ensure your responses are consistent with previous responses.
Make sure that the syntax is correct and all parts are connected as a 3D printable object.
IMPORTANT: Never use the text() function. Never use import(). Never use surface(). Use only primitive shapes (cube, sphere, cylinder, polyhedron) and boolean operations (union, difference, intersection) with translate, rotate, scale, mirror, and linear_extrude/rotate_extrude.`;

const AGENT_PROMPT = `You are Adam, an AI CAD editor that creates and modifies OpenSCAD models.
Speak back to the user briefly (one or two sentences), then produce OpenSCAD code.
Keep text concise and helpful.`;

// Extract raw OpenSCAD code from text (strip markdown fences)
function extractOpenSCADCodeFromText(text) {
  if (!text) return null;
  const fenceMatch = text.match(/```(?:openscad)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // No fence — assume the whole thing is code if it has SCAD-y syntax
  if (/(\bcube|\bcylinder|\btranslate|\bunion|\bdifference)\s*\(/.test(text)) {
    return text.trim();
  }
  return null;
}

// Parse OpenSCAD parameters from code
function parseParameters(code) {
  if (!code) return [];
  const params = [];
  const regex = /^\s*(\w+)\s*=\s*([^;]+);(?:\s*\/\/\s*(.*))?/gm;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const name = match[1];
    const rawValue = match[2].trim();
    const comment = match[3]?.trim() || '';

    if (['module', 'function', 'use', 'include'].includes(name)) continue;
    if (name.startsWith('$')) continue;

    let value, type;
    if (rawValue === 'true' || rawValue === 'false') {
      value = rawValue === 'true';
      type = 'boolean';
    } else if (!isNaN(Number(rawValue)) && rawValue !== '') {
      value = Number(rawValue);
      type = 'number';
    } else if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      value = rawValue.slice(1, -1);
      type = 'string';
    } else {
      continue;
    }

    params.push({
      name,
      displayName: name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      value,
      defaultValue: value,
      type,
      description: comment,
    });
  }
  return params;
}

// Title generator
app.post('/functions/v1/title-generator', async (req, res) => {
  try {
    const { content } = req.body;
    const text = content?.text || 'New Object';
    const response = await poe.chat.completions.create({
      model: mapModel('anthropic/claude-3.5-haiku'),
      max_tokens: 30,
      messages: [
        {
          role: 'system',
          content:
            'Generate a short title (max 25 chars) for a 3D object. Just the name, nothing else.',
        },
        { role: 'user', content: text },
      ],
    });
    let title =
      response.choices?.[0]?.message?.content?.trim() || 'Adam Object';
    title = title.replace(/^["']|["']$/g, '').replace(/^title:\s*/i, '');
    if (title.length > 27) title = title.substring(0, 24) + '...';
    res.json({ title });
  } catch (err) {
    console.error('Title generation error:', err.message);
    res.json({ title: 'Adam Object' });
  }
});

// Parametric chat - the main AI endpoint
// Emits NDJSON (newline-delimited JSON) Message objects, matching the real
// Supabase edge function contract that the client streaming parser expects.
app.post('/functions/v1/parametric-chat', async (req, res) => {
  const { conversationId, messageId, model, newMessageId } = req.body;
  const poeModel = mapModel(model);

  console.log(
    `[parametric-chat] model=${model} -> poe=${poeModel}, conv=${conversationId}`,
  );

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const convMsgs = messages.get(conversationId) || [];
    const userMsg = convMsgs.find((m) => m.id === messageId);
    const userText = userMsg?.content?.text || 'Hello';

    // Build chat history: for assistant messages, prefer content.artifact?.code
    // so the model sees clean OpenSCAD instead of markdown-wrapped text.
    const chatHistory = convMsgs
      .filter((m) => m.id !== messageId || m.role === 'user')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content:
          m.role === 'assistant'
            ? m.content?.artifact?.code || m.content?.text || ''
            : m.content?.text || '',
      }));

    // Safety filters
    const blockedTerms = ['text()', 'import(', 'surface('];
    if (blockedTerms.some((t) => userText.toLowerCase().includes(t))) {
      const errMsg = {
        id: newMessageId,
        conversation_id: conversationId,
        role: 'assistant',
        parent_message_id: messageId,
        content: {
          text: 'Error: Blocked term in prompt.',
          type: 'text',
          artifact: null,
          parameters: [],
        },
        created_at: new Date().toISOString(),
        rating: null,
      };
      res.write(JSON.stringify(errMsg) + '\n');
      res.end();
      return;
    }

    const systemPrompt =
      chatHistory.length <= 1 ? STRICT_CODE_PROMPT : AGENT_PROMPT;
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory.slice(0, -1),
      { role: 'user', content: userText },
    ];

    const baseMessage = {
      id: newMessageId,
      conversation_id: conversationId,
      role: 'assistant',
      parent_message_id: messageId,
      rating: null,
      created_at: new Date().toISOString(),
    };

    const stream = await poe.chat.completions.create({
      model: poeModel,
      messages: apiMessages,
      stream: true,
      max_tokens: 8192,
    });

    let fullText = '';
    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content || '';
      if (!text) continue;
      fullText += text;
      // Emit a full Message snapshot per delta
      const deltaMsg = {
        ...baseMessage,
        content: {
          text: fullText,
          type: 'openscad',
          artifact: {
            title: 'Generated Shape',
            version: '1.0.0',
            code: extractOpenSCADCodeFromText(fullText),
            parameters: [],
          },
          parameters: [],
        },
      };
      res.write(JSON.stringify(deltaMsg) + '\n');
    }

    // Final frame with parsed parameters
    const parameters = parseParameters(fullText);
    const finalMessage = {
      ...baseMessage,
      content: {
        text: fullText,
        type: 'openscad',
        artifact: {
          title: 'Generated Shape',
          version: '1.0.0',
          code: extractOpenSCADCodeFromText(fullText),
          parameters,
        },
        parameters,
      },
    };
    res.write(JSON.stringify(finalMessage) + '\n');

    // Persist the same object to the in-memory messages map so REST GETs match
    const convMsgs2 = messages.get(conversationId) || [];
    convMsgs2.push(finalMessage);
    messages.set(conversationId, convMsgs2);

    res.end();
  } catch (err) {
    console.error('[parametric-chat] Error:', err.message);
    const errMsg = {
      id: newMessageId,
      conversation_id: conversationId,
      role: 'assistant',
      parent_message_id: messageId,
      content: {
        text: `Error: ${err.message}`,
        type: 'text',
        artifact: null,
        parameters: [],
      },
      created_at: new Date().toISOString(),
      rating: null,
    };
    res.write(JSON.stringify(errMsg) + '\n');
    res.end();
  }
});

// NEW: billing-status
app.all('/functions/v1/billing-status', (req, res) => {
  res.json({
    user: { hasTrialed: true },
    subscription: {
      level: 'pro',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 365 * 86400000).toISOString(),
    },
    tokens: {
      free: 200,
      subscription: 9999,
      purchased: 0,
      total: 9999,
    },
  });
});

// NEW: billing-products
app.all('/functions/v1/billing-products', (req, res) => {
  res.json([]);
});

// NEW: billing-checkout / billing-portal
app.all('/functions/v1/billing-checkout', (req, res) => {
  res.json({ url: '#' });
});

app.all('/functions/v1/billing-portal', (req, res) => {
  res.json({ url: '#' });
});

// Fallback stubs
app.all('/storage/v1/:path', (req, res) => {
  console.log(`[stub] ${req.method} ${req.url}`);
  res.json([]);
});

app.all('/auth/v1/:path', (req, res) => {
  console.log(`[stub] ${req.method} ${req.url}`);
  res.json({});
});

// NEW: creative-chat — NDJSON streaming stub (same contract as parametric-chat)
app.post('/functions/v1/creative-chat', async (req, res) => {
  const { conversationId, messageId, newMessageId } = req.body;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const msg = {
    id: newMessageId,
    conversation_id: conversationId,
    role: 'assistant',
    parent_message_id: messageId,
    content: {
      text: 'Creative mesh generation is not available in local mode.',
      type: 'text',
    },
    created_at: new Date().toISOString(),
    rating: null,
  };
  res.write(JSON.stringify(msg) + '\n');
  res.end();
});

// NEW: mesh — stub for upscale/generative-mesh flows
app.all('/functions/v1/mesh', (req, res) => {
  res.json({
    status: 'not_implemented',
    message: 'Mesh generation is not available in local mode.',
  });
});

// NEW: jackson-pollock — PostHog no-op proxy (silences 404 console spam)
app.all('/functions/v1/jackson-pollock', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.all('/functions/v1/jackson-pollock/:path', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.all('/functions/v1/:path', (req, res) => {
  console.log(`[stub] ${req.method} ${req.url}`);
  res.json({});
});

// Start HTTP + WebSocket server
const server = http.createServer(app);

server.on('upgrade', (req, socket) => {
  if (!req.url || !req.url.startsWith('/realtime/v1/websocket')) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
  socket.on('error', () => {});
});

server.listen(PORT, () => {
  console.log('\nCADAM Local Server running on http://127.0.0.1:' + PORT);
  if (!POE_API_KEY) {
    console.log(
      '   WARNING: POE_API_KEY not set. Set it in .env.local or environment.',
    );
    console.log(
      '   The parametric-chat endpoint will fail without a valid key.',
    );
  } else {
    console.log(
      '   Using Poe API with key: ' + POE_API_KEY.slice(0, 8) + '...',
    );
  }
  console.log('   Default model: Gemini-3.1-Pro');
  console.log('   Mocking: Auth, Database, Edge Functions + Realtime WS\n');
});
