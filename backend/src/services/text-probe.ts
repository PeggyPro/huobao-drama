import { createTextModel } from './text-model.js'
import { textRequestUrl, normalizeTextAPIFormat, type TextConnection } from './text-providers.js'
import { redactUrl } from '../utils/task-logger.js'

function cleanPreview(value: string, key: string) {
  return (key ? value.split(key).join('[REDACTED]') : value).slice(0, 500)
}

function generatedText(result: unknown) {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { content?: unknown }).content)) return ''
  return (result as { content: unknown[] }).content
    .filter((part): part is { type: 'text'; text: string } => {
      return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        && typeof (part as { text?: unknown }).text === 'string'
    })
    .map(part => part.text)
    .join('')
    .trim()
}

function hasProviderError(responsePreview: string) {
  return /(?:[,{])\s*\"error\"\s*:/i.test(responsePreview)
}

function emptyResultMessage(result: unknown, responsePreview: string) {
  const finishReason = result && typeof result === 'object'
    ? String((result as { finishReason?: unknown }).finishReason || '').toLowerCase()
    : ''
  if (finishReason.includes('content-filter') || finishReason.includes('content_filter') || /blockreason|safety/i.test(responsePreview)) {
    return '服务商已响应，但内容被安全策略过滤，未生成可验证文本'
  }
  if (hasProviderError(responsePreview)) {
    return '服务商返回了错误响应，请检查 API Key、模型 ID 与接口格式'
  }
  if (finishReason === 'length') {
    return '服务商已响应，但输出在生成文本前达到上限，请检查模型与输出限制'
  }
  return '端点已响应，但未生成可验证文本，请检查 API Key、模型 ID、接口格式或套餐状态'
}

/** Exercise the very same SDK, model and auth as the agents, using a short completion. */
export async function probeTextConnection(config: TextConnection, fetchImpl: typeof fetch = globalThis.fetch) {
  const format = normalizeTextAPIFormat(config.provider, config.apiFormat)
  const path = format === 'anthropic' ? '/messages' : format === 'google'
    ? `/models/${config.model}:generateContent` : '/chat/completions'
  let url = redactUrl(textRequestUrl(config, path))
  let status: number | undefined
  let statusText = ''
  let responsePreview = ''
  const probeFetch: typeof fetch = async (input, init) => {
    url = redactUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const response = await fetchImpl(input, init)
    status = response.status
    statusText = response.statusText
    responsePreview = cleanPreview(await response.clone().text(), config.apiKey)
    return response
  }
  try {
    const model = createTextModel(config, { fetch: probeFetch, probe: true })
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
      maxOutputTokens: 64,
      abortSignal: AbortSignal.timeout(30_000),
    })
    if (!generatedText(result)) {
      return {
        ok: false, reachable: status !== undefined, status, status_text: statusText, method: 'POST', url,
        message: emptyResultMessage(result, responsePreview), response_preview: responsePreview,
      }
    }
    return {
      ok: true, reachable: true, status, status_text: statusText, method: 'POST', url,
      message: '模型调用成功，接口格式、认证与模型已验证', response_preview: responsePreview,
    }
  } catch (error) {
    const messages: Record<number, string> = {
      400: '服务商拒绝了请求，请检查模型、接口格式和 Temperature',
      401: 'API Key 无效或已过期，请检查密钥是否属于当前服务商或套餐',
      403: '没有访问权限，请检查模型权限、地域或套餐状态',
      404: '接口或模型不存在，请检查 Base URL、接口格式与模型 ID',
      429: '请求受限，请检查余额、套餐额度或稍后重试',
    }
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false, reachable: status !== undefined, status, status_text: statusText, method: 'POST', url,
      message: status && messages[status] ? messages[status]
        : status && status >= 200 && status < 300 ? hasProviderError(responsePreview)
          ? '服务商返回了错误响应，请检查 API Key、模型 ID 与接口格式'
          : '端点已响应，但响应不符合所选模型接口格式'
        : cleanPreview(detail || '请求失败或超时，请检查网络和 Base URL', config.apiKey),
      response_preview: responsePreview,
    }
  }
}
