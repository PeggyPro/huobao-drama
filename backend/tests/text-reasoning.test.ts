import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createTextModel } from '../src/services/text-model.js'
import { probeTextConnection } from '../src/services/text-probe.js'
import { normalizeReasoningEffort, parseConfigReasoningEffort, textReasoningEfforts, validateReasoningEffort } from '../src/services/text-reasoning.js'
import type { TextConnection } from '../src/services/text-providers.js'

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Reply OK' }] }]
const connection: TextConnection = { provider: 'openai', baseUrl: 'https://relay.example', apiKey: 'test-only-key', model: 'gpt-5.6-sol' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const completion = () => json({ id: 'test', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })
function thinkingEnv(t: TestContext) {
  for (const name of ['AI_DISABLE_THINKING', 'AI_THINKING_OFF_PATCH']) {
    const saved = process.env[name]
    t.after(() => { if (saved === undefined) delete process.env[name]; else process.env[name] = saved })
    delete process.env[name]
  }
}

test('missing/default settings preserve compatibility and malformed levels are rejected', () => {
  for (const value of [undefined, null, '', 'default']) assert.equal(normalizeReasoningEffort(value), 'default')
  for (const value of ['off', 'strong', 3, {}, ['max']]) assert.throws(() => normalizeReasoningEffort(value), /推理等级/)
  for (const raw of [undefined, null, '{bad', '{}', '{"reasoning_effort":"unsupported"}']) assert.equal(parseConfigReasoningEffort(raw), 'default')
  assert.equal(parseConfigReasoningEffort('{"reasoning_effort":"max"}'), 'max')
  assert.throws(() => validateReasoningEffort('anthropic', 'minimal'), /不支持/)
  assert.throws(() => validateReasoningEffort('google', 'max'), /不支持/)
})

for (const effort of textReasoningEfforts) {
  test(`OpenAI ${effort} is identical in probe, generation and streaming and keeps the bare model ID`, async t => {
    thinkingEnv(t)
    const config = { ...connection, reasoningEffort: effort }
    let requests = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, 'gpt-5.6-sol')
      assert.equal(body.reasoning_effort, effort === 'default' ? undefined : effort)
      assert.equal(body.thinking, undefined)
      assert.equal(body.enable_thinking, undefined)
      if (requests === 1) assert.equal(body.max_completion_tokens ?? body.max_tokens, ['default', 'none'].includes(effort) ? 64 : 4096)
      if (!body.stream) return completion()
      const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    assert.equal((await probeTextConnection(config, fetchImpl)).ok, true)
    const model = createTextModel(config, { fetch: fetchImpl })
    await model.doGenerate({ prompt })
    const { stream } = await model.doStream({ prompt })
    for await (const part of stream) assert.notEqual(part.type, 'error')
    assert.equal(requests, 3)
  })
}

test('explicit effort wins over legacy env patches while default retains them exactly', async t => {
  thinkingEnv(t)
  process.env.AI_THINKING_OFF_PATCH = '{"reasoning_effort":"none","thinking":{"type":"disabled"},"enable_thinking":false}'
  for (const effort of ['default', 'max'] as const) {
    for (const disable of ['true', 'false']) {
      process.env.AI_DISABLE_THINKING = disable
      const result = await probeTextConnection({ ...connection, reasoningEffort: effort }, async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.equal(body.reasoning_effort, effort === 'max' ? 'max' : disable === 'true' ? 'none' : undefined)
        assert.equal(body.enable_thinking, effort === 'default' && disable === 'true' ? false : undefined)
        return completion()
      })
      assert.equal(result.ok, true)
    }
  }
})

test('official Qwen and DeepSeek explicit choices enable their native thinking flags', async () => {
  for (const [provider, baseUrl, flag] of [['aliyun', 'https://dashscope.aliyuncs.com', 'enable_thinking'], ['deepseek', 'https://api.deepseek.com', 'thinking']]) {
    for (const effort of ['none', 'high'] as const) {
      const result = await probeTextConnection({ ...connection, provider, baseUrl, reasoningEffort: effort }, async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.equal(body.reasoning_effort, effort)
        assert.deepEqual(body[flag], flag === 'enable_thinking' ? effort !== 'none' : { type: effort === 'none' ? 'disabled' : 'enabled' })
        return completion()
      })
      assert.equal(result.ok, true)
    }
  }
})

test('Anthropic uses adaptive thinking and effort in native output_config, never OpenAI fields', async () => {
  for (const effort of ['none', 'low', 'high', 'xhigh', 'max'] as const) {
    const result = await probeTextConnection({ ...connection, provider: 'claude', model: 'claude-opus-4-6', baseUrl: 'https://api.anthropic.com', temperature: 0.5, reasoningEffort: effort }, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(body.thinking, { type: effort === 'none' ? 'disabled' : 'adaptive' })
      assert.equal(body.output_config?.effort, effort === 'none' ? undefined : effort)
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.enable_thinking, undefined)
      if (effort !== 'none') assert.equal(body.temperature, undefined)
      return json({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 2 } })
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
})

test('Gemini uses native thinkingConfig and replaces conflicting legacy budgets', async () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high'] as const) {
    const result = await probeTextConnection({ ...connection, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3-flash-preview', reasoningEffort: effort }, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(body.generationConfig.thinkingConfig, effort === 'none' ? { thinkingBudget: 0, includeThoughts: false } : { thinkingLevel: effort })
      assert.equal(body.reasoning_effort, undefined)
      return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } })
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
})

test('provider rejection stays visible and never silently retries without the selected grade', async () => {
  let requests = 0
  const result = await probeTextConnection({ ...connection, reasoningEffort: 'max' }, async (_url, init) => {
    requests++
    assert.equal(JSON.parse(String(init?.body)).reasoning_effort, 'max')
    return json({ error: { message: 'max is unsupported for this model', type: 'invalid_request_error' } }, 400)
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.match(result.message, /推理等级/)
  assert.equal(requests, 1)
})
