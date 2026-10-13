import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { Hono } from 'hono'

process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
const { db } = await import('../src/db/index.js')
const { default: configs } = await import('../src/routes/aiConfigs.js')
const { getActiveConfig, getConfigById } = await import('../src/services/ai.js')
const { createTextModel } = await import('../src/services/text-model.js')
const app = new Hono().route('/api/v1/ai-configs', configs)
const sqlite = db.$client
const realFetch = globalThis.fetch
const base = { service_type: 'text', provider: 'openai', name: 'test relay', base_url: 'https://relay.example', api_key: 'test-only-key', model: ['gpt-5.6-sol', 'gpt-6-astra'] }
const completion = () => new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  sqlite.prepare('DELETE FROM ai_service_configs').run()
  globalThis.fetch = async () => { throw new Error('Real network forbidden in reasoning config tests') }
})
after(() => { globalThis.fetch = realFetch; sqlite.close() })
const request = (method: string, path: string, body?: unknown) => app.request(`/api/v1/ai-configs${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
async function ok(method: string, path: string, body?: unknown) {
  const response = await request(method, path, body)
  const payload = await response.json()
  assert.ok(response.ok, JSON.stringify(payload))
  return payload.data
}
function settings(id: number) {
  return JSON.parse((sqlite.prepare('SELECT settings FROM ai_service_configs WHERE id=?').get(id) as { settings: string | null }).settings || '{}')
}

test('saved grade round trips through CRUD and selected/default runtime configuration', async () => {
  const selected = await ok('POST', '', { ...base, reasoning_effort: 'max', priority: 1 })
  const defaultRow = await ok('POST', '', { ...base, reasoning_effort: 'low', priority: 9 })
  assert.equal(selected.reasoning_effort, 'max')
  assert.equal(settings(selected.id).reasoning_effort, 'max')
  const rows = await ok('GET', '?service_type=text')
  assert.equal(rows.find((row: { id: number }) => row.id === selected.id).reasoning_effort, 'max')
  assert.equal((await getActiveConfig('text'))?.reasoningEffort, 'low')
  assert.equal((await getConfigById(defaultRow.id))?.reasoningEffort, 'low')
  const runtime = await getConfigById(selected.id)
  assert.equal(runtime?.reasoningEffort, 'max')
  let requests = 0
  const model = createTextModel({ ...runtime!, model: 'gpt-6-astra' }, { fetch: async (_url, init) => {
    requests++
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'gpt-6-astra')
    assert.equal(body.reasoning_effort, 'max')
    return completion()
  } })
  await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }] })
  assert.equal(requests, 1)
})

test('partial edits preserve effort and unrelated settings; default removes only the explicit grade', async () => {
  const row = await ok('POST', '', { ...base, reasoning_effort: 'high', temperature: 0.5 })
  sqlite.prepare('UPDATE ai_service_configs SET settings=? WHERE id=?').run(JSON.stringify({ ...settings(row.id), unrelated: { keep: true } }), row.id)
  await ok('PUT', `/${row.id}`, { name: 'renamed', is_active: true })
  await ok('PUT', `/${row.id}`, { temperature: 0.3, model: ['gpt-6-astra'] })
  assert.deepEqual(settings(row.id), { api_format: 'openai', reasoning_effort: 'high', temperature: 0.3, unrelated: { keep: true } })
  for (const value of ['default', null, '']) {
    await ok('PUT', `/${row.id}`, { reasoning_effort: 'max' })
    await ok('PUT', `/${row.id}`, { reasoning_effort: value })
    assert.equal('reasoning_effort' in settings(row.id), false)
    assert.deepEqual(settings(row.id).unrelated, { keep: true })
    assert.equal((await getConfigById(row.id))?.reasoningEffort, 'default')
  }
  const legacy = await ok('POST', '', base)
  assert.equal(legacy.reasoning_effort, 'default')
  assert.equal('reasoning_effort' in settings(legacy.id), false)
})

test('test endpoint uses the unsaved grade without modifying any persisted configuration', async () => {
  const row = await ok('POST', '', { ...base, reasoning_effort: 'low' })
  let requests = 0
  globalThis.fetch = async (url, init) => {
    requests++
    assert.equal(String(url), 'https://relay.example/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.reasoning_effort, 'max')
    assert.equal(body.max_completion_tokens ?? body.max_tokens, 4096)
    assert.equal(body.model, base.model[0])
    return completion()
  }
  const probe = await ok('POST', '/test', { ...base, reasoning_effort: 'max' })
  assert.equal(probe.ok, true)
  assert.equal(requests, 1)
  assert.equal(settings(row.id).reasoning_effort, 'low')
})

test('invalid grades fail before model requests or database writes', async () => {
  const row = await ok('POST', '', { ...base, reasoning_effort: 'high' })
  const before = settings(row.id)
  for (const reasoning_effort of ['off', 'typo', false, 4, { level: 'max' }]) {
    for (const [method, path] of [['POST', ''], ['PUT', `/${row.id}`], ['POST', '/test']]) {
      const response = await request(method, path, { ...base, reasoning_effort })
      assert.equal(response.status, 400)
      assert.match((await response.text()), /推理等级/)
    }
  }
  assert.deepEqual(settings(row.id), before)
  assert.equal((await ok('GET', '')).length, 1)
  for (const [provider, api_format, reasoning_effort] of [['gemini', 'google', 'max'], ['claude', 'anthropic', 'minimal']]) {
    assert.equal((await request('POST', '', { ...base, provider, api_format, reasoning_effort })).status, 400)
  }
})

test('provider/protocol switches reset omitted grade and media never inherits text options', async () => {
  const row = await ok('POST', '', { ...base, reasoning_effort: 'max' })
  await ok('PUT', `/${row.id}`, { provider: 'gemini', api_format: 'google', model: ['gemini-3-flash-preview'], base_url: 'https://generativelanguage.googleapis.com' })
  assert.equal('reasoning_effort' in settings(row.id), false)
  await ok('PUT', `/${row.id}`, { reasoning_effort: 'high' })
  await ok('PUT', `/${row.id}`, { service_type: 'image', provider: 'openai' })
  assert.equal('reasoning_effort' in settings(row.id), false)
  assert.equal('api_format' in settings(row.id), false)
  const media = await ok('POST', '', { ...base, service_type: 'image', reasoning_effort: 'max' })
  assert.equal('reasoning_effort' in media, false)
  assert.equal('reasoning_effort' in settings(media.id), false)
})
