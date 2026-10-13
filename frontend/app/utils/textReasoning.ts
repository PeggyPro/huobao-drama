import type { TextApiFormat } from './textProviderCatalog'

export const reasoningEfforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

export function savedReasoningEffort(value: unknown): ReasoningEffort {
  return typeof value === 'string' && reasoningEfforts.includes(value as ReasoningEffort) ? value as ReasoningEffort : 'default'
}

export function reasoningEffortsFor(format: TextApiFormat): readonly ReasoningEffort[] {
  return reasoningEfforts.filter(effort => !(format === 'anthropic' && effort === 'minimal')
    && !(format === 'google' && (effort === 'xhigh' || effort === 'max')))
}

/** Display metadata only. Never append this suffix to the model ID sent to the API. */
export function reasoningSuffix(value: unknown): string {
  const effort = savedReasoningEffort(value)
  return effort === 'default' ? '' : `(${effort})`
}
