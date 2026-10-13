import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, reactive, ref } from 'vue'
import { loadTs } from './helpers/load-ts.mjs'

const catalog = loadTs('app/utils/textProviderCatalog.ts')
const reasoning = loadTs('app/utils/textReasoning.ts')
const { createAIConfigDraft, applyTextProvider, applyTextFormat, changeDraftBaseUrl, aiConfigPayload, useAIConfigForm, useConfigProbe } = loadTs('app/composables/useAIConfigForm.ts', { '../utils/textProviderCatalog': catalog, '../utils/textReasoning': reasoning })
const saved = () => ({ id: 12, service_type: 'text', name: 'My relay', provider: 'claude', base_url: 'https://custom.example/v9', api_key: 'existing-key', api_format: 'openai', model: ['custom-claude', 'backup'], priority: 12, temperature: 1.7 })
function harness() {
  const scope = effectScope()
  const form = reactive(createAIConfigDraft(saved(), 'text'))
  const modelInput = ref('')
  const pending = []
  const probe = scope.run(() => useConfigProbe(form, modelInput, payload => new Promise((resolve, reject) => pending.push({ payload, resolve, reject }))))
  return { scope, form, modelInput, pending, ...probe, start: () => probe.run(aiConfigPayload(form)) }
}
const ok = { ok: true, reachable: true, status: 200, message: 'Model responded' }

test('opening and reopening saved configs never applies defaults or mutates persisted data', () => {
  const original = saved()
  const draft = createAIConfigDraft(original, 'text')
  assert.equal(draft.base_url, original.base_url)
  assert.equal(draft.api_key, original.api_key)
  assert.equal(draft.api_format, 'openai')
  assert.deepEqual(draft.models, original.model)
  assert.equal(draft.temperature, 1.7)
  draft.models.push('draft-only')
  draft.api_key = 'unsaved-key'
  const reopened = createAIConfigDraft(original, 'text')
  assert.deepEqual(reopened.models, ['custom-claude', 'backup'])
  assert.equal(reopened.api_key, 'existing-key')
  assert.equal(reopened.base_url, 'https://custom.example/v9')
  for (const provider of ['claude', 'gemini', 'deepseek']) {
    const legacy = { ...original, provider, api_format: undefined }
    const loaded = createAIConfigDraft(legacy, 'text')
    assert.equal(loaded.api_format, catalog.defaultTextApiFormat(provider))
    assert.equal(loaded.base_url, legacy.base_url)
    assert.equal(loaded.api_key, legacy.api_key)
    assert.deepEqual(loaded.models, legacy.model)
  }
  const empty = createAIConfigDraft({ ...original, base_url: '', api_key: '', model: [] }, 'text')
  assert.equal(empty.base_url, '')
  assert.deepEqual(empty.models, [])
})

test('provider changes apply reviewed examples and clear old keys, while reselecting is a no-op', () => {
  const draft = createAIConfigDraft(saved(), 'text')
  assert.equal(applyTextProvider(draft, 'claude'), false)
  assert.equal(draft.api_key, 'existing-key')
  assert.equal(draft.base_url, 'https://custom.example/v9')
  assert.equal(applyTextProvider(draft, 'openai'), true)
  assert.equal(draft.api_key, '')
  assert.equal(draft.api_format, 'openai')
  assert.equal(draft.base_url, 'https://api.openai.com/v1')
  assert.deepEqual(draft.models, ['gpt-4.1-mini'])
  assert.equal(draft.name, 'My relay')
  draft.models.push('custom')
  assert.deepEqual(catalog.textProviderById('openai').models, ['gpt-4.1-mini'])
})

test('Claude compatibility changes clear URL, models and credentials but preserve temperature', () => {
  const draft = createAIConfigDraft({ ...saved(), api_format: 'anthropic', base_url: 'https://api.anthropic.com' }, 'text')
  assert.equal(applyTextFormat(draft, 'openai'), true)
  assert.equal(draft.base_url, '')
  assert.equal(draft.api_key, '')
  assert.deepEqual(draft.models, [])
  assert.equal(draft.temperature, 1.7)
  draft.base_url = 'https://new-relay.example/v1'
  draft.models = ['relay-model']
  draft.api_key = 'relay-key'
  assert.equal(applyTextFormat(draft, 'openai'), false)
  assert.equal(draft.api_key, 'relay-key')
  assert.equal(applyTextFormat(draft, 'anthropic'), true)
  assert.equal(draft.api_key, '')
  assert.equal(draft.base_url, 'https://api.anthropic.com')
  assert.deepEqual(draft.models, ['claude-sonnet-4-6'])
  assert.equal(draft.temperature, 1.7)
})

test('editing the endpoint cannot carry a saved key to another origin', () => {
  const draft = createAIConfigDraft(saved(), 'text')
  assert.equal(changeDraftBaseUrl(draft, 'https://custom.example/v1'), false)
  assert.equal(draft.api_key, 'existing-key')
  assert.equal(changeDraftBaseUrl(draft, 'https://another.example/v1'), true)
  assert.equal(draft.api_key, '')
  draft.api_key = 'replacement-key'
  assert.equal(changeDraftBaseUrl(draft, 'http://another.example/v1'), true, 'scheme changes also clear the key')
  draft.api_key = 'replacement-key'
  assert.equal(changeDraftBaseUrl(draft, ''), true, 'partial/empty URL edits invalidate the old origin')
})

test('shared test/create/update payload carries format and temperature only where appropriate', () => {
  const draft = createAIConfigDraft(saved(), 'text')
  const payload = aiConfigPayload(draft)
  assert.equal(payload.api_format, 'openai')
  assert.equal(payload.temperature, 1.7)
  assert.deepEqual(payload.model, ['custom-claude', 'backup'])
  draft.temperature = 0
  assert.equal(aiConfigPayload(draft).temperature, 0)
  draft.temperature = ''
  assert.equal(aiConfigPayload(draft).temperature, null)
  draft.service_type = 'image'
  assert.equal('api_format' in aiConfigPayload(draft), false)
  draft.service_type = 'video'
  assert.equal('api_format' in aiConfigPayload(draft), false)
})

test('reasoning selection survives edit/test/save while legacy and media configs keep defaults', async () => {
  for (const grade of reasoning.reasoningEfforts) {
    const original = { ...saved(), reasoning_effort: grade }
    const draft = createAIConfigDraft(original, 'text')
    assert.equal(draft.reasoning_effort, grade)
    assert.equal(aiConfigPayload(draft).reasoning_effort, grade)
    assert.deepEqual(aiConfigPayload(draft).model, original.model, 'display suffix must never enter model IDs')
    draft.reasoning_effort = 'low'
    assert.equal(createAIConfigDraft(original, 'text').reasoning_effort, grade, 'cancel/reopen preserves saved choice')
  }
  for (const value of [undefined, null, '', 'unrecognized']) {
    assert.equal(createAIConfigDraft({ ...saved(), reasoning_effort: value }, 'text').reasoning_effort, 'default')
  }
  const h = harness()
  h.form.reasoning_effort = 'max'
  const active = h.start()
  assert.equal(h.pending[0].payload.reasoning_effort, 'max')
  h.pending[0].resolve(ok)
  await active
  assert.equal(h.result.value.ok, true)
  h.form.reasoning_effort = 'default'
  assert.equal(h.result.value, null, 'old probe must not appear valid for a different grade')
  for (const service of ['image', 'video']) {
    h.form.service_type = service
    assert.equal('reasoning_effort' in aiConfigPayload(h.form), false)
  }
  h.scope.stop()
})

test('switching provider or protocol resets reasoning but reselecting preserves it', () => {
  const draft = createAIConfigDraft({ ...saved(), reasoning_effort: 'max' }, 'text')
  assert.equal(applyTextProvider(draft, 'claude'), false)
  assert.equal(draft.reasoning_effort, 'max')
  assert.equal(applyTextProvider(draft, 'gemini'), true)
  assert.equal(draft.reasoning_effort, 'default')
  draft.reasoning_effort = 'high'
  assert.equal(applyTextFormat(draft, 'google'), false)
  assert.equal(draft.reasoning_effort, 'high')
  assert.equal(applyTextFormat(draft, 'openai'), true)
  assert.equal(draft.reasoning_effort, 'default')
})

test('reasoning display hides default and offers only protocol-compatible levels', () => {
  for (const value of [undefined, null, 'default', '', 'invalid']) assert.equal(reasoning.reasoningSuffix(value), '')
  for (const grade of reasoning.reasoningEfforts.filter(value => value !== 'default')) assert.equal(reasoning.reasoningSuffix(grade), `(${grade})`)
  assert.deepEqual(reasoning.reasoningEffortsFor('openai'), reasoning.reasoningEfforts)
  assert.equal(reasoning.reasoningEffortsFor('anthropic').includes('minimal'), false)
  assert.equal(reasoning.reasoningEffortsFor('anthropic').includes('max'), true)
  assert.deepEqual(reasoning.reasoningEffortsFor('google'), ['default', 'none', 'minimal', 'low', 'medium', 'high'])
})

test('model editing deduplicates IDs and moves a selected default without mutating saved arrays', () => {
  const original = saved()
  const scope = effectScope()
  const editor = scope.run(() => useAIConfigForm(original, 'text'))
  editor.addModels('custom-claude, new-model\nnew-model，third')
  assert.deepEqual([...editor.form.models], ['custom-claude', 'backup', 'new-model', 'third'])
  editor.pinModel(2)
  assert.deepEqual([...editor.form.models], ['new-model', 'custom-claude', 'backup', 'third'])
  assert.deepEqual(original.model, ['custom-claude', 'backup'])
  scope.stop()
})

test('changes immediately discard success and invalidate an in-flight response even after reverting', async () => {
  const h = harness()
  const first = h.start()
  h.pending[0].resolve(ok)
  await first
  assert.equal(h.result.value.ok, true)
  for (const field of ['provider', 'api_format', 'base_url', 'api_key', 'temperature', 'reasoning_effort', 'name', 'priority']) {
    const original = h.form[field]
    const active = h.start()
    h.form[field] = field === 'temperature' || field === 'priority' ? 0 : 'changed'
    h.form[field] = original
    assert.equal(h.result.value, null, field)
    h.pending.at(-1).resolve(ok)
    assert.equal(await active, null, field)
    assert.equal(h.result.value, null, field)
  }
  const modelRun = h.start()
  h.form.models.push('new-model')
  h.pending.at(-1).resolve(ok)
  assert.equal(await modelRun, null)
  const inputRun = h.start()
  h.modelInput.value = 'uncommitted-model'
  h.pending.at(-1).resolve(ok)
  assert.equal(await inputRun, null)
  h.scope.stop()
})

test('an older request cannot end loading or overwrite a newer request', async () => {
  const h = harness()
  const first = h.start()
  h.form.api_key = 'new-key'
  const second = h.start()
  h.pending[0].resolve(ok)
  assert.equal(await first, null)
  assert.equal(h.testing.value, true)
  const reachable = { ok: false, reachable: true, status: 401, message: 'Invalid key' }
  h.pending[1].resolve(reachable)
  assert.deepEqual(await second, reachable)
  assert.equal(h.result.value.ok, false)
  assert.equal(h.result.value.reachable, true)
  assert.equal(h.testing.value, false)
  h.scope.stop()
})

test('closing a dialog suppresses both late successes and late errors', async () => {
  for (const rejected of [false, true]) {
    const h = harness()
    const pending = h.start()
    h.scope.stop()
    if (rejected) h.pending[0].reject(new Error('late network failure'))
    else h.pending[0].resolve(ok)
    assert.equal(await pending, null)
    assert.equal(h.result.value, null)
    assert.equal(h.testing.value, false)
  }
})
