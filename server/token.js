import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HTTP_ENDPOINT = process.env.BML_ENDPOINT || 'http://127.0.0.1:12307/mcp';
export const WS_ENDPOINT = process.env.BML_WS_ENDPOINT || 'ws://127.0.0.1:12307/ws';
export const HOST = process.env.BML_HOST || '127.0.0.1';
export const PORT = Number(process.env.BML_PORT || 12307);

const SECRETS_JSON = join(homedir(), '.browser-mcp-secrets.json');
const SECRETS_TOKEN = join(homedir(), '.browser-mcp-secrets.token');

export function createToken() {
  return randomBytes(32).toString('hex');
}

function readJsonToken() {
  if (!existsSync(SECRETS_JSON)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_JSON, 'utf8'));
    const value = parsed.bearerToken || parsed.token || parsed.mcpBearerToken;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readPlainToken() {
  if (!existsSync(SECRETS_TOKEN)) return null;
  const value = readFileSync(SECRETS_TOKEN, 'utf8').trim();
  return value.length > 0 ? value : null;
}

function persist(token) {
  try {
    mkdirSync(homedir(), { recursive: true });
    writeFileSync(SECRETS_JSON, JSON.stringify({ bearerToken: token }, null, 2), { mode: 0o600 });
    try {
      chmodSync(SECRETS_JSON, 0o600);
    } catch {
      void 0;
    }
    return SECRETS_JSON;
  } catch {
    try {
      writeFileSync(SECRETS_TOKEN, token, { mode: 0o600 });
      return SECRETS_TOKEN;
    } catch {
      return null;
    }
  }
}

export async function loadToken({ create = true } = {}) {
  if (process.env.BML_TOKEN) return process.env.BML_TOKEN;
  const existing = readJsonToken() || readPlainToken();
  if (existing) return existing;
  if (!create) return null;
  const token = createToken();
  persist(token);
  return token;
}

export function tokenPath() {
  if (readJsonToken()) return SECRETS_JSON;
  if (readPlainToken()) return SECRETS_TOKEN;
  return null;
}

export function verifyToken(provided) {
  if (process.env.BML_INSECURE === '1') return true;
  return matches(process.env.BML_TOKEN, provided) || matches(loadTokenSync(), provided);
}

function loadTokenSync() {
  if (process.env.BML_TOKEN) return process.env.BML_TOKEN;
  return readJsonToken() || readPlainToken();
}

function matches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { startBridge } from './bridge.js';
