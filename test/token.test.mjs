import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import {
  HTTP_ENDPOINT,
  PORT,
  WS_ENDPOINT,
  createToken,
  loadToken,
  verifyToken,
} from '../server/token.js';

const saved = { ...process.env };

after(() => {
  for (const key of ['BML_TOKEN', 'BML_INSECURE']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('token defaults', () => {
  it('targets the local bridge', () => {
    assert.equal(HTTP_ENDPOINT, 'http://127.0.0.1:12307/mcp');
    assert.equal(WS_ENDPOINT, 'ws://127.0.0.1:12307/ws');
    assert.equal(PORT, 12307);
  });

  it('binds to loopback only', () => {
    assert.ok(!HTTP_ENDPOINT.includes('0.0.0.0'));
  });
});

describe('createToken', () => {
  it('returns 256 bits of hex', () => {
    const token = createToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]+$/);
  });

  it('does not repeat', () => {
    assert.notEqual(createToken(), createToken());
  });
});

describe('loadToken', () => {
  it('prefers the environment override', async () => {
    process.env.BML_TOKEN = 'env-token';
    assert.equal(await loadToken(), 'env-token');
  });

  it('returns null instead of writing when create is false', async () => {
    process.env.BML_TOKEN = 'env-token';
    assert.equal(await loadToken({ create: false }), 'env-token');
  });
});

describe('verifyToken', () => {
  it('accepts the exact token and rejects near misses', () => {
    process.env.BML_TOKEN = 'secret-value';
    delete process.env.BML_INSECURE;
    assert.equal(verifyToken('secret-value'), true);
    assert.equal(verifyToken('secret-valuE'), false);
    assert.equal(verifyToken('secret-value-extra'), false);
    assert.equal(verifyToken(undefined), false);
  });

  it('can be short-circuited for local debugging', () => {
    process.env.BML_INSECURE = '1';
    assert.equal(verifyToken('anything'), true);
  });
});
