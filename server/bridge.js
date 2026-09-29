import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDispatcher } from './mcp.js';
import { createToolRegistry } from './tools.js';
import { HOST, PORT, loadToken, verifyToken } from './token.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendSse(res, payloads, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    ...headers,
  });
  for (const payload of payloads) {
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const provided = bearer || req.headers['x-bml-token'] || null;
  return provided ? verifyToken(String(provided)) : false;
}

export function createBridge({ registry = createToolRegistry() } = {}) {
  const dispatcher = createDispatcher({ registry });
  const sessions = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': 'null',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, accept, mcp-session-id, x-bml-token',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      sendJson(res, 200, {
        ok: true,
        server: 'browser-mcp-lite',
        endpoint: '/mcp',
        transport: ['http-json', 'sse'],
        tools: registry.list().map((t) => t.name),
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: `Unknown path: ${url.pathname}` });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST for /mcp' }, { allow: 'POST, OPTIONS' });
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { error: 'Missing or invalid bearer token' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] || null;
    if (sessionId && !sessions.has(sessionId)) {
      sendJson(res, 404, { error: 'Unknown session; call initialize first' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
      return;
    }

    let responses;
    try {
      responses = Array.isArray(payload)
        ? await dispatcher.handleMany(payload)
        : [await dispatcher.handle(payload)].filter(Boolean);
    } catch (err) {
      responses = [{ jsonrpc: '2.0', id: payload?.id ?? null, error: { code: -32603, message: err.message } }];
    }

    const headers = {};
    if (!sessionId && Array.isArray(payload)) {
      const init = payload.find((p) => p?.method === 'initialize');
      if (init) headers['mcp-session-id'] = randomUUID();
    } else if (!sessionId && payload?.method === 'initialize') {
      headers['mcp-session-id'] = randomUUID();
    }
    if (headers['mcp-session-id']) sessions.add(headers['mcp-session-id']);

    const accept = String(req.headers.accept || '');
    if (accept.includes('text/event-stream')) {
      sendSse(res, responses, headers);
    } else {
      sendJson(res, 200, Array.isArray(payload) ? responses : (responses[0] ?? {}), headers);
    }
  });

  return { server, dispatcher, registry, sessions };
}

export async function startBridge({ host = HOST, port = PORT, token, registry } = {}) {
  const bridge = createBridge({ registry });
  const bearer = token || (await loadToken());

  await new Promise((resolve, reject) => {
    bridge.server.once('error', reject);
    bridge.server.listen(port, host, resolve);
  });

  const address = bridge.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    ...bridge,
    bearer,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/mcp`,
    async close() {
      await new Promise((resolve) => bridge.server.close(resolve));
      await bridge.registry.close();
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('bridge.js')) {
  const bridge = await startBridge();
  process.stderr.write(
    [
      `browser-mcp-lite bridge listening on ${bridge.url}`,
      `health: http://${bridge.host}:${bridge.port}/health`,
      `bearer token: ${bridge.bearer}`,
      '',
    ].join('\n'),
  );
  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
