import { AppError } from './errors.mjs';
import { validateObject } from './aiOwnerAssist.mjs';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 60000;

export class AiGatewayError extends AppError {
  constructor(status, code, message, details = {}) {
    super(status, code, message);
    this.details = details;
  }
}

export function readAiConfig(env = process.env, overrides = {}) {
  const enabled = parseBoolean(overrides.enabled ?? env.DECKBRIDGE_AI_ENABLED, false);
  return {
    enabled,
    baseUrl: cleanBaseUrl(overrides.baseUrl ?? env.NINEROUTER_URL ?? ''),
    key: stringOrNull(overrides.key ?? env.NINEROUTER_KEY),
    chatModel: stringOrNull(overrides.chatModel ?? env.NINEROUTER_CHAT_MODEL),
    embeddingModel: stringOrNull(overrides.embeddingModel ?? env.NINEROUTER_EMBEDDING_MODEL),
    timeoutMs: boundedInt(overrides.timeoutMs ?? env.DECKBRIDGE_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1, 120000),
    modelCacheTtlMs: boundedInt(overrides.modelCacheTtlMs ?? env.DECKBRIDGE_AI_MODEL_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 0, 3600000)
  };
}

export function createAiGateway(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const config = readAiConfig(options.env || process.env, options.config || {});
  const now = options.now || (() => Date.now());
  let cachedCapabilities = null;

  if (typeof fetchImpl !== 'function') {
    throw new AiGatewayError(500, 'ai_fetch_unavailable', 'Fetch is not available for AI gateway calls');
  }

  function disabledStatus() {
    return {
      state: 'disabled',
      chatModel: null,
      embeddingModel: null,
      checkedAt: null,
      message: 'DeckBridge AI is disabled.'
    };
  }

  async function capabilities({ force = false } = {}) {
    if (!config.enabled) return disabledStatus();
    const cacheHit = cachedCapabilities && !force && now() - cachedCapabilities.cachedAt < config.modelCacheTtlMs;
    if (cacheHit) return cachedCapabilities.status;

    const checkedAt = new Date(now()).toISOString();
    const status = await discoverCapabilities(checkedAt);
    cachedCapabilities = { cachedAt: now(), status };
    return status;
  }

  async function discoverCapabilities(checkedAt) {
    if (!config.baseUrl) {
      return status('gateway-unreachable', null, null, checkedAt, '9Router URL is not configured.');
    }

    try {
      await requestJson('/api/health', { method: 'GET' });
      const [chatPayload, embeddingPayload] = await Promise.all([
        requestJson('/v1/models', { method: 'GET' }),
        requestJson('/v1/models/embedding', { method: 'GET' })
      ]);
      const chatModels = extractModelIds(chatPayload);
      const embeddingModels = extractModelIds(embeddingPayload);
      const chatModel = selectModel(chatModels, config.chatModel);
      const embeddingModel = selectModel(embeddingModels, config.embeddingModel);
      if (!chatModels.length || !chatModel) {
        return status('no-chat-model', null, embeddingModel, checkedAt, 'No compatible 9Router chat model is available.');
      }
      if (!embeddingModels.length || !embeddingModel) {
        return status('no-embedding-model', chatModel, null, checkedAt, 'No compatible 9Router embedding model is available.');
      }
      return status('ready', chatModel, embeddingModel, checkedAt, '9Router AI is ready.');
    } catch (error) {
      if (error?.code === 'ai_unauthorized') {
        return status('auth-required', null, null, checkedAt, '9Router rejected the configured key.');
      }
      return status('gateway-unreachable', null, null, checkedAt, error.message || '9Router is unreachable.');
    }
  }

  async function chatJson({ messages, validate = validateObject, model, temperature = 0, maxTokens = 800 } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AiGatewayError(400, 'ai_invalid_request', 'AI chat requires at least one message');
    }
    const capability = await capabilities();
    ensureChatReady(capability);
    const selectedModel = model || capability.chatModel || config.chatModel;
    const body = {
      model: selectedModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      stream: false
    };

    try {
      return await parseChatJson(await requestJson('/v1/chat/completions', {
        method: 'POST',
        body
      }), validate, selectedModel);
    } catch (error) {
      if (!isRepairableJsonError(error)) throw error;
      const repairPayload = await requestJson('/v1/chat/completions', {
        method: 'POST',
        body: {
          ...body,
          messages: [
            ...messages,
            {
              role: 'user',
              content: `Return only valid JSON matching the requested shape. Previous response failed: ${error.message}`
            }
          ]
        }
      });
      return parseChatJson(repairPayload, validate, selectedModel);
    }
  }

  async function embed(input, { model } = {}) {
    const values = Array.isArray(input) ? input : [input];
    if (!values.length || values.some((value) => typeof value !== 'string')) {
      throw new AiGatewayError(400, 'ai_invalid_request', 'AI embeddings require text input');
    }
    const capability = await capabilities();
    ensureEmbeddingReady(capability);
    const selectedModel = model || capability.embeddingModel || config.embeddingModel;
    const payload = await requestJson('/v1/embeddings', {
      method: 'POST',
      body: { model: selectedModel, input: Array.isArray(input) ? values : values[0] }
    });
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const embeddings = data.map((item) => item?.embedding).filter((embedding) => Array.isArray(embedding));
    if (!embeddings.length) {
      throw new AiGatewayError(503, 'ai_embedding_unavailable', '9Router did not return embeddings');
    }
    return {
      model: payload?.model || selectedModel,
      dimensions: embeddings[0].length,
      embeddings,
      inputCount: values.length
    };
  }

  async function health() {
    if (!config.enabled) return disabledStatus();
    try {
      return await requestJson('/api/health', { method: 'GET' });
    } catch (error) {
      throw mapGatewayError(error);
    }
  }

  async function requestJson(pathname, { method = 'GET', body } = {}) {
    if (!config.baseUrl) {
      throw new AiGatewayError(503, 'ai_gateway_unreachable', '9Router URL is not configured.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const headers = {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(config.key ? { Authorization: `Bearer ${config.key}` } : {})
      };
      const response = await fetchImpl(urlFor(config.baseUrl, pathname), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw statusError(response.status, payload);
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AiGatewayError(503, 'ai_timeout', `9Router request timed out after ${config.timeoutMs}ms`);
      }
      throw mapGatewayError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    config: publicConfig(config),
    health,
    capabilities,
    chatJson,
    embed,
    clearCache() {
      cachedCapabilities = null;
    }
  };
}

function status(state, chatModel, embeddingModel, checkedAt, message) {
  return { state, chatModel, embeddingModel, checkedAt, message };
}

function ensureChatReady(capability) {
  if (capability.state === 'ready' || capability.state === 'no-embedding-model') return;
  throw new AiGatewayError(503, 'ai_unavailable', capability.message, { state: capability.state });
}

function ensureEmbeddingReady(capability) {
  if (capability.state === 'ready' || capability.state === 'no-chat-model') return;
  throw new AiGatewayError(503, 'ai_unavailable', capability.message, { state: capability.state });
}

function isRepairableJsonError(error) {
  return error?.code === 'ai_malformed_json' || error?.code === 'ai_validation_failed';
}

function parseChatJson(payload, validate, model) {
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseJsonContent(content);
  const result = validate(parsed);
  if (result !== true && result?.ok !== true) {
    throw new AiGatewayError(502, 'ai_validation_failed', result?.message || 'AI response failed validation');
  }
  return {
    value: parsed,
    model: payload?.model || model,
    raw: payload
  };
}

function parseJsonContent(content) {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new AiGatewayError(502, 'ai_malformed_json', 'AI response did not include JSON content');
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new AiGatewayError(502, 'ai_malformed_json', `AI response was not valid JSON: ${error.message}`);
  }
}

function extractModelIds(payload) {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return raw.map((model) => {
    if (typeof model === 'string') return model;
    return model?.id || model?.name || model?.model;
  }).filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim());
}

function selectModel(models, preferred) {
  if (!models.length) return null;
  if (!preferred) return models[0];
  return models.includes(preferred) ? preferred : null;
}

function statusError(status, payload) {
  const message = payload?.error?.message || payload?.message || `9Router returned HTTP ${status}`;
  if (status === 401 || status === 403) return new AiGatewayError(401, 'ai_unauthorized', message);
  if (status === 503) return new AiGatewayError(503, 'ai_provider_unavailable', message);
  return new AiGatewayError(status >= 400 && status < 600 ? status : 502, 'ai_gateway_error', message);
}

function mapGatewayError(error) {
  if (error instanceof AiGatewayError) return error;
  if (error?.cause instanceof AiGatewayError) return error.cause;
  return new AiGatewayError(503, 'ai_gateway_unreachable', error?.message || '9Router is unreachable');
}

function urlFor(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function cleanBaseUrl(value) {
  const text = stringOrNull(value);
  return text ? text.replace(/\/+$/, '') : '';
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function publicConfig(config) {
  return {
    enabled: config.enabled,
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
    timeoutMs: config.timeoutMs,
    modelCacheTtlMs: config.modelCacheTtlMs
  };
}
