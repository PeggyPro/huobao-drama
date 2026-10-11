import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { getTextProviderBaseUrl, normalizeTextAPIFormat, type TextConnection } from './text-providers.js'

const officialHosts = new Set([
  'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com',
  'api.deepseek.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com', 'ark.cn-beijing.volces.com', 'api.moonshot.cn', 'api.moonshot.ai',
  'open.bigmodel.cn', 'api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io',
  'api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'qianfan.baidubce.com',
  'api.hunyuan.cloud.tencent.com', 'api.x.ai', 'api.mistral.ai', 'api.cohere.ai',
  'api.cohere.com', 'api.siliconflow.cn', 'api.siliconflow.com', 'openrouter.ai',
])

function thinkingPatch(config: TextConnection, host: string): Record<string, unknown> | undefined {
  if ((process.env.AI_DISABLE_THINKING ?? 'true').toLowerCase() === 'false') return
  // Native Messages never accepts the OpenAI proxy extensions below.
  if (normalizeTextAPIFormat(config.provider, config.apiFormat) === 'anthropic') return
  const official = officialHosts.has(host) || host.endsWith('.maas.aliyuncs.com')
  if (official) {
    if (['api.deepseek.com', 'ark.cn-beijing.volces.com', 'open.bigmodel.cn',
      'api.moonshot.cn', 'api.moonshot.ai', 'api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com'].includes(host)) {
      return { thinking: { type: 'disabled' } }
    }
    if (host.startsWith('dashscope') || host.endsWith('.maas.aliyuncs.com')) return { enable_thinking: false }
    return
  }
  if (config.provider.toLowerCase() === 'ollama') return
  // Preserve the established new-api proxy workaround without sending it to vendor APIs.
  const fallback = { thinking: { type: 'disabled' }, enable_thinking: false, reasoning_effort: 'none' }
  try {
    const patch = process.env.AI_THINKING_OFF_PATCH ? JSON.parse(process.env.AI_THINKING_OFF_PATCH) : fallback
    return patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : fallback
  } catch { return fallback }
}

export interface TextFetchOptions {
  fetch?: typeof fetch
  /** A probe must retain its small output limit rather than the generation limit. */
  probe?: boolean
}

/** The probe and actual agents share normalization and provider-specific request patches. */
export function createTextFetch(config: TextConnection, options: TextFetchOptions = {}): typeof fetch {
  const base = options.fetch || globalThis.fetch
  const format = normalizeTextAPIFormat(config.provider, config.apiFormat)
  const host = new URL(getTextProviderBaseUrl(config)).hostname
  const patch = thinkingPatch(config, host)
  const requestedMax = Number(process.env.AI_MAX_TOKENS || 16384)
  const maxTokens = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : 16384
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        if (format === 'google' && Array.isArray(body.contents)) {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (patch) {
            body.generationConfig = {
              ...body.generationConfig,
              thinkingConfig: /gemini-3/i.test(url)
                ? { thinkingLevel: 'low' }
                : { thinkingBudget: 0, includeThoughts: false },
            }
          }
          if (config.temperature != null) body.generationConfig = { ...body.generationConfig, temperature: config.temperature }
          if (!options.probe) body.generationConfig = { ...body.generationConfig, maxOutputTokens: maxTokens }
        } else if (Array.isArray(body.messages)) {
          if (patch) Object.assign(body, patch)
          if (format !== 'anthropic' && config.temperature != null) body.temperature = config.temperature
          // Claude's SDK selects a model-appropriate max_tokens; keep it intact.
          if (!options.probe && format === 'openai' && host !== 'api.openai.com') {
            if (body.max_completion_tokens == null) body.max_tokens = maxTokens
          }
        }
        init = { ...init, body: JSON.stringify(body) }
      } catch { /* Non-JSON bodies pass through unchanged. */ }
    }
    return base(input, init)
  }
}

export function createTextModel(config: TextConnection, options: TextFetchOptions = {}): ReturnType<ReturnType<typeof createAnthropic>> | ReturnType<ReturnType<typeof createGoogleGenerativeAI>> | ReturnType<ReturnType<typeof createOpenAI>['chat']> {
  const baseURL = getTextProviderBaseUrl(config)
  const format = normalizeTextAPIFormat(config.provider, config.apiFormat)
  const fetch = createTextFetch(config, options)
  if (format === 'anthropic') {
    if (config.temperature != null && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 1)) {
      throw new Error('Anthropic 原生接口的 Temperature 须为 0 到 1 之间的数字')
    }
    const model = createAnthropic({ baseURL, apiKey: config.apiKey, fetch })(config.model)
    // Pass settings before SDK serialization so it can enforce temperature/thinking and model token limits.
    const requestedMax = Number(process.env.AI_MAX_TOKENS || 16384)
    const maxOutputTokens = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : 16384
    return new Proxy(model, {
      get(target, property, receiver) {
        if (property === 'doGenerate' || property === 'doStream') {
          return (call: Parameters<typeof model.doGenerate>[0]) => target[property]({
            ...call,
            maxOutputTokens: call.maxOutputTokens ?? maxOutputTokens,
            ...(config.temperature != null ? { temperature: config.temperature } : {}),
          })
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }
  if (format === 'google') {
    return createGoogleGenerativeAI({ baseURL, apiKey: config.apiKey, fetch })(config.model)
  }
  return createOpenAI({
    baseURL,
    // Ollama's local OpenAI-compatible endpoint normally has no authentication.
    apiKey: config.apiKey || (config.provider.toLowerCase() === 'ollama' ? 'ollama' : ''),
    fetch,
  }).chat(config.model)
}
