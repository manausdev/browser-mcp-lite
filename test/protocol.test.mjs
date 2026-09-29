import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createDispatcher, DEFAULT_PROTOCOL, SERVER_NAME } from '../server/mcp.js';

const fakeRegistry = {
  list: () => [
    {
      name: 'echo',
      description: 'Echoes its input.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
  ],
  call: async (name, args) => {
    if (name === 'boom') return { content: [{ type: 'text', text: 'kaboom' }], isError: true };
    if (name !== 'echo') return { content: [{ type: 'text', text: `unknown:${name}` }], isError: true };
    if (args.value == null) return { content: [{ type: 'text', text: 'missing value' }], isError: true };
    return { content: [{ type: 'text', text: args.value }] };
  },
};

const dispatcher = createDispatcher({ registry: fakeRegistry });
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('initialize', () => {
  it('advertises tool support', async () => {
    const { result } = await dispatcher.handle(rpc('initialize', { protocolVersion: '2024-11-05' }));
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.ok(result.capabilities.tools);
    assert.equal(result.serverInfo.name, SERVER_NAME);
    assert.match(result.instructions, /read_page/);
  });

  it('falls back to the default version for unknown protocols', async () => {
    const { result } = await dispatcher.handle(rpc('initialize', { protocolVersion: '1999-01-01' }));
    assert.equal(result.protocolVersion, DEFAULT_PROTOCOL);
  });
});

describe('notifications', () => {
  it('stays silent when there is no id', async () => {
    assert.equal(await dispatcher.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(await dispatcher.handle({ jsonrpc: '2.0', method: 'tools/list' }), null);
  });
});

describe('tools/list', () => {
  it('returns schemas without handlers', async () => {
    const { result } = await dispatcher.handle(rpc('tools/list'));
    assert.equal(result.tools.length, 1);
    assert.deepEqual(result.tools[0], fakeRegistry.list()[0]);
  });
});

describe('tools/call', () => {
  it('forwards arguments', async () => {
    const { result } = await dispatcher.handle(rpc('tools/call', { name: 'echo', arguments: { value: 'hi' } }));
    assert.deepEqual(result.content, [{ type: 'text', text: 'hi' }]);
    assert.equal(result.isError, undefined);
  });

  it('reports tool errors without throwing', async () => {
    const { result } = await dispatcher.handle(rpc('tools/call', { name: 'boom', arguments: {} }));
    assert.equal(result.isError, true);
  });

  it('surfaces validation failures', async () => {
    const { result } = await dispatcher.handle(rpc('tools/call', { name: 'echo', arguments: {} }));
    assert.equal(result.isError, true);
  });

  it('rejects a missing name', async () => {
    const { error } = await dispatcher.handle(rpc('tools/call', {}));
    assert.equal(error.code, -32602);
  });
});

describe('protocol errors', () => {
  it('reports unknown methods', async () => {
    const { error } = await dispatcher.handle(rpc('does/not/exist'));
    assert.equal(error.code, -32601);
  });

  it('reports malformed envelopes', async () => {
    const { error } = await dispatcher.handle({ jsonrpc: '2.0', id: 7 });
    assert.equal(error.code, -32600);
  });

  it('rejects batches of primitives', async () => {
    const { error } = await dispatcher.handle('nope');
    assert.equal(error.code, -32600);
  });
});

describe('batches', () => {
  it('answers each request in order', async () => {
    const responses = await dispatcher.handleMany([
      rpc('ping', {}, 1),
      rpc('tools/list', {}, 2),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      rpc('tools/call', { name: 'echo', arguments: { value: 'batch' } }, 3),
    ]);
    assert.deepEqual(responses.map((r) => r.id), [1, 2, 3]);
  });
});
