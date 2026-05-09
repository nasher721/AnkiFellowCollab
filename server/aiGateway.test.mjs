import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createAiGateway } from './aiGateway.mjs';
import { createApp } from './app.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createQueuedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch call to ${url}`);
    if (typeof next === 'function') return next(url, options);
    return jsonResponse(next.body, next.status || 200);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const enabledConfig = {
  enabled: true,
  baseUrl: 'http://router.test',
  key: 'secret',
  chatModel: 'chat-ready',
  embeddingModel: 'embed-ready',
  timeoutMs: 25,
  modelCacheTtlMs: 60000
};

const healthyDiscovery = [
  { body: { ok: true } },
  { body: { data: [{ id: 'chat-ready' }] } },
  { body: { data: [{ id: 'embed-ready' }] } }
];

test('status endpoint returns disabled when AI is not enabled', async () => {
  const app = createApp({
    production: false,
    repositoryMode: 'local',
    rateLimits: { disabled: true },
    aiGatewayOptions: {
      config: { enabled: false },
      fetchImpl: async () => {
        throw new Error('AI gateway should not be called when disabled');
      }
    }
  });

  const response = await request(app).get('/api/ai/status').expect(200);
  assert.deepEqual(response.body, {
    state: 'disabled',
    chatModel: null,
    embeddingModel: null,
    checkedAt: null,
    message: 'DeckBridge AI is disabled.'
  });
});

test('capability discovery omits authorization when no key is configured', async () => {
  const fetchImpl = createQueuedFetch(healthyDiscovery.map((item) => ({ ...item })));
  const gateway = createAiGateway({
    fetchImpl,
    config: { ...enabledConfig, key: null }
  });

  const status = await gateway.capabilities();

  assert.equal(status.state, 'ready');
  assert.equal(fetchImpl.calls.length, 3);
  for (const call of fetchImpl.calls) {
    assert.equal(call.options.headers.Authorization, undefined);
  }
});

test('capability discovery reports auth-required on 401', async () => {
  const gateway = createAiGateway({
    fetchImpl: createQueuedFetch([
      { body: { error: { message: 'bad token' } }, status: 401 }
    ]),
    config: enabledConfig
  });

  const status = await gateway.capabilities();

  assert.equal(status.state, 'auth-required');
  assert.equal(status.chatModel, null);
  assert.equal(status.embeddingModel, null);
  assert.match(status.message, /rejected/i);
});

test('capability discovery reports no-chat-model on empty models', async () => {
  const gateway = createAiGateway({
    fetchImpl: createQueuedFetch([
      { body: { ok: true } },
      { body: { data: [] } },
      { body: { data: [{ id: 'embed-ready' }] } }
    ]),
    config: enabledConfig
  });

  const status = await gateway.capabilities();

  assert.equal(status.state, 'no-chat-model');
  assert.equal(status.chatModel, null);
  assert.equal(status.embeddingModel, 'embed-ready');
});

test('capability discovery caches gateway status', async () => {
  const fetchImpl = createQueuedFetch(healthyDiscovery.map((item) => ({ ...item })));
  const gateway = createAiGateway({
    fetchImpl,
    config: enabledConfig,
    now: () => 1000
  });

  assert.equal((await gateway.capabilities()).state, 'ready');
  assert.equal((await gateway.capabilities()).state, 'ready');
  assert.equal(fetchImpl.calls.length, 3);
});

test('timeout is reported as an unavailable capability without escaping', async () => {
  const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const gateway = createAiGateway({
    fetchImpl,
    config: { ...enabledConfig, timeoutMs: 5 }
  });

  const status = await gateway.capabilities();

  assert.equal(status.state, 'gateway-unreachable');
  assert.match(status.message, /timed out/i);
});

test('chatJson maps provider 503 into a typed recoverable error', async () => {
  const gateway = createAiGateway({
    fetchImpl: createQueuedFetch([
      ...healthyDiscovery.map((item) => ({ ...item })),
      { body: { error: { message: 'provider exhausted' } }, status: 503 }
    ]),
    config: enabledConfig
  });

  await assert.rejects(
    () => gateway.chatJson({
      messages: [{ role: 'user', content: 'Return JSON' }],
      validate: () => true
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'ai_provider_unavailable');
      assert.match(error.message, /provider exhausted/);
      return true;
    }
  );
});

test('chatJson repairs malformed JSON once and validates the repaired object', async () => {
  const fetchImpl = createQueuedFetch([
    ...healthyDiscovery.map((item) => ({ ...item })),
    {
      body: {
        model: 'chat-ready',
        choices: [{ message: { content: '{not json' } }]
      }
    },
    {
      body: {
        model: 'chat-ready',
        choices: [{ message: { content: '{"ok":true}' } }]
      }
    }
  ]);
  const gateway = createAiGateway({ fetchImpl, config: enabledConfig });

  const result = await gateway.chatJson({
    messages: [{ role: 'user', content: 'Return JSON' }],
    validate: (value) => value?.ok === true ? { ok: true } : { ok: false, message: 'missing ok' }
  });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(fetchImpl.calls.length, 5);
  const repairBody = JSON.parse(fetchImpl.calls[4].options.body);
  assert.match(repairBody.messages.at(-1).content, /Return only valid JSON/);
});

test('embed returns model and dimension metadata', async () => {
  const gateway = createAiGateway({
    fetchImpl: createQueuedFetch([
      ...healthyDiscovery.map((item) => ({ ...item })),
      {
        body: {
          model: 'embed-ready',
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        }
      }
    ]),
    config: enabledConfig
  });

  const result = await gateway.embed('front back');

  assert.equal(result.model, 'embed-ready');
  assert.equal(result.dimensions, 3);
  assert.equal(result.inputCount, 1);
  assert.deepEqual(result.embeddings, [[0.1, 0.2, 0.3]]);
});
