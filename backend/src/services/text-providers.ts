import { joinProviderUrl } from './adapters/url.js'
import type { TextReasoningEffort } from './text-reasoning.js'

export type TextAPIFormat = 'openai' | 'anthropic' | 'google'

/** Provider identities are independent of the wire format (Claude proxies may use OpenAI). */
export const textProviderPrefixes = {
  claude: '/v1',
  openai: '/v1',
  gemini: '/v1beta',
  deepseek: '/v1',
  aliyun: '/compatible-mode/v1',
  volcengine: '/api/v3',
  moonshot: '/v1',
  zhipu: '/api/paas/v4',
  minimax: '/v1',
  'xiaomi-token-plan-cn': '/v1',
  xiaomi: '/v1',
  baidu: '/v2',
  hunyuan: '/v1',
  xai: '/v1',
  mistral: '/v1',
  cohere: '/compatibility/v1',
  siliconflow: '/v1',
  openrouter: '/api/v1',
  ollama: '/v1',
} as const

export const textProviders = Object.keys(textProviderPrefixes)

export interface TextConnection {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: TextAPIFormat
  temperature?: number | null
  /** Explicit effort overrides legacy thinking patches; default preserves them. */
  reasoningEffort?: TextReasoningEffort
}

export function defaultTextAPIFormat(provider: string): TextAPIFormat {
  if (provider.toLowerCase() === 'claude') return 'anthropic'
  if (provider.toLowerCase() === 'gemini') return 'google'
  return 'openai'
}

export function normalizeTextAPIFormat(provider: string, value?: unknown): TextAPIFormat {
  const fallback = defaultTextAPIFormat(provider)
  if (value == null || value === '') return fallback
  if (value === fallback) return fallback
  if (provider.toLowerCase() === 'claude' && value === 'openai') return 'openai'
  throw new Error('服务商与接口格式不匹配')
}

export function parseConfigAPIFormat(provider: string, settingsRaw?: string | null): TextAPIFormat {
  try {
    return normalizeTextAPIFormat(provider, settingsRaw ? JSON.parse(settingsRaw)?.api_format : undefined)
  } catch {
    return defaultTextAPIFormat(provider)
  }
}

/** Preserve explicit versioned paths and gateway prefixes; append the provider's prefix only once. */
export function getTextProviderBaseUrl(config: Pick<TextConnection, 'provider' | 'baseUrl' | 'apiFormat'>): string {
  const provider = config.provider.toLowerCase()
  const format = normalizeTextAPIFormat(provider, config.apiFormat)
  const url = new URL(config.baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  if (url.search || url.hash || url.username || url.password) throw new Error('Base URL 请勿包含查询参数、锚点或凭据；密钥请填在 API Key 中')
  let path = url.pathname.replace(/\/+$/, '')
  if (/\/(?:chat\/completions|messages|responses|models)$/.test(path) || /:generateContent$/.test(path)) {
    throw new Error('Base URL 请填写接口基础地址，无需追加 messages、chat/completions 或模型名')
  }
  if (!/\/v\d+(?:beta\d*|alpha\d*)?$/.test(path)) {
    const prefix = provider === 'claude' && format === 'openai'
      ? '/v1'
      : textProviderPrefixes[provider as keyof typeof textProviderPrefixes] || '/v1'
    const parts = prefix.split('/').filter(Boolean)
    // e.g. /gateway/compatible-mode + /compatible-mode/v1 → /gateway/compatible-mode/v1
    let overlap = 0
    for (let i = 1; i < parts.length; i++) {
      if (path.endsWith(`/${parts.slice(0, i).join('/')}`)) overlap = i
    }
    path += `/${parts.slice(overlap).join('/')}`
  }
  url.pathname = path
  url.hash = ''
  return url.toString()
}

export function textRequestUrl(config: Pick<TextConnection, 'provider' | 'baseUrl' | 'apiFormat'>, path: string): string {
  return joinProviderUrl(getTextProviderBaseUrl(config), '', path)
}
