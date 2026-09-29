import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolRegistry } from './tools.js';

export const SERVER_NAME = 'browser-mcp-lite';
export const SERVER_VERSION = '0.1.0';
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL = PROTOCOL_VERSIONS[0];

const INSTRUCTIONS = [
  'Drive a real Chrome over the DevTools Protocol. Workflow that works best:',
  '1. open_tab (or navigate_tab) to load a page.',
  '2. read_page to get a YAML outline with ref=<id> on every interactive node.',
  '3. click / type_text / scroll_page using those refs.',
  '4. screenshot to see the result; audit_page to check overflow and WCAG AA contrast.',
  'Prefer refs over CSS selectors: they are re-generated on every read_page call.',
].join('\n');

export const METHOD_NOT_FOUND = -32601;
export const INVALID_REQUEST = -32600;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function createDispatcher({ registry = createToolRegistry() } = {}) {
  async function handle(request) {
    if (request == null || typeof request !== 'object' || Array.isArray(request)) {
      return errorResponse(null, INVALID_REQUEST, 'Expected a single JSON-RPC object');
    }
    const { method, id } = request;
    if (typeof method !== 'string') {
      return errorResponse(id, INVALID_REQUEST, 'Missing "method"');
    }

    const isNotification = id === undefined || id === null;
    if (isNotification) return null;

    switch (method) {
      case 'initialize': {
        const requested = request.params?.protocolVersion;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case 'notifications/initialized':
      case 'initialized':
      case 'ping':
      case 'shutdown':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: registry.list() } };
      case 'tools/call': {
        const name = request.params?.name;
        if (typeof name !== 'string') {
          return errorResponse(id, INVALID_PARAMS, 'tools/call requires params.name');
        }
        const result = await registry.call(name, request.params?.arguments ?? {});
        return { jsonrpc: '2.0', id, result };
      }
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function handleMany(requests) {
    const responses = [];
    for (const request of requests) {
      try {
        const response = await handle(request);
        if (response) responses.push(response);
      } catch (err) {
        responses.push(errorResponse(request?.id ?? null, INTERNAL_ERROR, err.message));
      }
    }
    return responses;
  }

  return { handle, handleMany, registry };
}

export function startStdioServer({ registry = createToolRegistry() } = {}) {
  const dispatcher = createDispatcher({ registry });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

  let queue = Promise.resolve();
  let inFlight = 0;
  let closed = false;

  const process_line = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    inFlight += 1;
    queue = queue.then(async () => {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        write(errorResponse(null, -32700, `Parse error: ${err.message}`));
        return;
      }
      try {
        const responses = Array.isArray(parsed)
          ? await dispatcher.handleMany(parsed)
          : [await dispatcher.handle(parsed)].filter(Boolean);
        for (const response of responses) write(response);
      } catch (err) {
        write(errorResponse(parsed?.id ?? null, INTERNAL_ERROR, err.message));
      } finally {
        inFlight -= 1;
        maybeExit();
      }
    });
  };

  let exiting = false;
  const maybeExit = () => {
    if (!exiting && closed && inFlight === 0) {
      exiting = true;
      registry.close().finally(() => process.exit(0));
    }
  };

  const requestClose = () => {
    closed = true;
    maybeExit();
  };

  rl.on('line', process_line);
  process.on('SIGINT', requestClose);
  process.on('SIGTERM', requestClose);
  process.stdin.on('end', requestClose);
  process.stdin.on('close', requestClose);

  return { dispatcher, registry, close: requestClose };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startStdioServer();
}
