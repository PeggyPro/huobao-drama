import { reactive, ref, watch, onScopeDispose, type Ref } from 'vue'
import { defaultTextApiFormat, resolveTextApiFormat, textProviderById, type TextApiFormat } from '../utils/textProviderCatalog'
import { savedReasoningEffort, type ReasoningEffort } from '../utils/textReasoning'

export type ServiceType = 'text' | 'image' | 'video'
export interface SavedAIConfig {
  id?: number
  name?: string
  provider: string
  service_type: ServiceType
  base_url?: string
  api_key?: string
  api_format?: string | null
  model?: string[] | string
  priority?: number
  temperature?: number | null
  reasoning_effort?: string | null
}
export interface AIConfigDraft {
  name: string
  provider: string
  service_type: ServiceType
  base_url: string
  api_key: string
  api_format: TextApiFormat
  models: string[]
  priority: number
  temperature: string | number | null
  reasoning_effort: ReasoningEffort
}
export interface ConfigProbeResult {
  ok: boolean
  reachable: boolean
  status?: number
  message?: string
  method?: string
  url?: string
  response_preview?: string
}

export function createAIConfigDraft(saved: SavedAIConfig | null, serviceType: ServiceType): AIConfigDraft {
  // Loading is deliberately separate from applying a preset: old/custom data is
  // copied verbatim, with only a missing format inferred from the provider.
  return {
    name: saved?.name ?? '',
    provider: saved?.provider ?? '',
    service_type: saved?.service_type ?? serviceType,
    base_url: saved?.base_url ?? '',
    api_key: saved?.api_key ?? '',
    api_format: resolveTextApiFormat(saved?.provider ?? '', saved?.api_format),
    models: Array.isArray(saved?.model) ? [...saved.model] : String(saved?.model ?? '').split(',').map(s => s.trim()).filter(Boolean),
    priority: saved?.priority ?? 0,
    temperature: saved?.temperature ?? '',
    reasoning_effort: savedReasoningEffort(saved?.reasoning_effort),
  }
}

export function applyTextProvider(draft: AIConfigDraft, id: string): boolean {
  const provider = textProviderById(id)
  if (!provider || id === draft.provider) return false
  draft.provider = id
  draft.api_format = provider.apiFormat
  draft.base_url = provider.baseUrl
  draft.models = [...provider.models]
  draft.api_key = ''
  draft.temperature = ''
  draft.reasoning_effort = 'default'
  if (!draft.name) draft.name = `${provider.label}-text`
  return true
}

export function applyTextFormat(draft: AIConfigDraft, format: TextApiFormat): boolean {
  if (draft.api_format === format) return false
  draft.api_format = format
  draft.reasoning_effort = 'default'
  draft.api_key = ''
  const provider = textProviderById(draft.provider)
  const native = format === defaultTextApiFormat(draft.provider)
  draft.base_url = native ? provider?.baseUrl ?? '' : ''
  draft.models = native ? [...(provider?.models ?? [])] : []
  return true
}

function originOf(value: string): string {
  try { return new URL(value).origin } catch { return '' }
}
export function changeDraftBaseUrl(draft: AIConfigDraft, value: string): boolean {
  // A key already present belongs to the previous origin. This also clears it
  // when an in-progress edit temporarily makes the URL invalid.
  const clearKey = !!draft.api_key && originOf(draft.base_url) !== originOf(value)
  if (clearKey) draft.api_key = ''
  draft.base_url = value
  return clearKey
}

export function aiConfigPayload(draft: AIConfigDraft) {
  return {
    service_type: draft.service_type,
    name: draft.name || `${draft.provider}-${draft.service_type}`,
    provider: draft.provider,
    base_url: draft.base_url,
    api_key: draft.api_key,
    model: [...draft.models],
    priority: draft.priority,
    temperature: draft.temperature === '' || draft.temperature === null ? null : Number(draft.temperature),
    ...(draft.service_type === 'text' ? { api_format: draft.api_format, reasoning_effort: draft.reasoning_effort } : {}),
  }
}

export function useAIConfigForm(saved: SavedAIConfig | null, serviceType: ServiceType) {
  const form = reactive(createAIConfigDraft(saved, serviceType))
  const modelInput = ref('')
  function addModels(text = modelInput.value) {
    for (const model of text.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)) {
      if (!form.models.includes(model)) form.models.push(model)
    }
    modelInput.value = ''
  }
  function pinModel(index: number) {
    if (index <= 0 || index >= form.models.length) return
    const [model] = form.models.splice(index, 1)
    if (model) form.models.unshift(model)
  }
  return { form, modelInput, addModels, pinModel }
}

export function useConfigProbe(
  form: AIConfigDraft,
  modelInput: Ref<string>,
  request: (payload: ReturnType<typeof aiConfigPayload>) => Promise<ConfigProbeResult>,
) {
  const testing = ref(false)
  const result = ref<ConfigProbeResult | null>(null)
  let version = 0
  function invalidate() {
    version += 1
    result.value = null
    testing.value = false
  }
  // Flush synchronously: even a change and reversal before nextTick invalidates
  // a response. A newer request must never inherit an older request's finally.
  watch([form, modelInput], invalidate, { deep: true, flush: 'sync' })
  onScopeDispose(invalidate)
  async function run(payload: ReturnType<typeof aiConfigPayload>) {
    const current = ++version
    result.value = null
    testing.value = true
    try {
      const response = await request(payload)
      if (current !== version) return null
      result.value = response
      return response
    } catch (error) {
      if (current !== version) return null
      throw error
    } finally {
      if (current === version) testing.value = false
    }
  }
  return { testing, result, run, invalidate }
}
