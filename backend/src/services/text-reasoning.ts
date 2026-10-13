import type { TextAPIFormat } from './text-providers.js'

export const textReasoningEfforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type TextReasoningEffort = typeof textReasoningEfforts[number]

/** default deliberately leaves the existing model/provider behavior untouched. */
export function normalizeReasoningEffort(value: unknown): TextReasoningEffort {
  if (value == null || value === '') return 'default'
  if (typeof value === 'string' && textReasoningEfforts.includes(value as TextReasoningEffort)) return value as TextReasoningEffort
  throw new Error(`推理等级须为 ${textReasoningEfforts.join('、')} 之一`)
}

export function validateReasoningEffort(format: TextAPIFormat, value: unknown): TextReasoningEffort {
  const effort = normalizeReasoningEffort(value)
  if ((format === 'anthropic' && effort === 'minimal') || (format === 'google' && ['xhigh', 'max'].includes(effort))) {
    throw new Error(`${format} 接口不支持推理等级 ${effort}，请选择该接口支持的等级`)
  }
  return effort
}

export function parseConfigReasoningEffort(settingsRaw?: string | null): TextReasoningEffort {
  try { return normalizeReasoningEffort(settingsRaw ? JSON.parse(settingsRaw)?.reasoning_effort : undefined) }
  catch { return 'default' }
}
