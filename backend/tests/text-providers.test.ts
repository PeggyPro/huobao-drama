import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createTextModel } from '../src/services/text-model.js'
import { probeTextConnection } from '../src/services/text-probe.js'
import { defaultTextAPIFormat, getTextProviderBaseUrl, normalizeTextAPIFormat, parseConfigAPIFormat, textProviders, type TextConnection } from '../src/services/text-providers.js'

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Reply OK' }] }]
const anthropicResponse = (content: unknown[] = [{ type: 'text', text: 'OK' }], stop_reason = 'end_turn') => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content, stop_reason,
  stop_sequence: null, usage: { input_tokens: 2, output_tokens: 2 },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const config: TextConnection = { provider: 'claude', baseUrl: 'https://api.anthropic.com', apiKey: 'fake-key', model: 'claude-sonnet-4-6', temperature: 0 }

function openaiResponse() {
  return { id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }
}

function thinkingEnv(t: TestContext) {
  for (const name of ['AI_DISABLE_THINKING', 'AI_THINKING_OFF_PATCH']) {
    const saved = process.env[name]
    t.after(() => { if (saved === undefined) delete process.env[name]; else process.env[name] = saved })
    delete process.env[name]
  }
}

function anthropicStream(block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }) {
  const tool = block.type === 'tool_use'
  const events = [
    { type: 'message_start', message: anthropicResponse([], null as unknown as string) },
    { type: 'content_block_start', index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}

test('provider URLs preserve explicit versions and reverse proxy prefixes without duplication', () => {
  const examples = [
    ['xiaomi-token-plan-cn', 'https://token-plan-cn.xiaomimimo.com', 'https://token-plan-cn.xiaomimimo.com/v1'],
    ['xiaomi', 'https://api.xiaomimimo.com/v1/', 'https://api.xiaomimimo.com/v1'],
    ['claude', 'https://proxy.example/claude', 'https://proxy.example/claude/v1'],
    ['aliyun', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'],
    ['aliyun', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['volcengine', 'https://proxy.example/volcengine', 'https://proxy.example/volcengine/api/v3'],
    ['zhipu', 'https://open.bigmodel.cn', 'https://open.bigmodel.cn/api/paas/v4'],
    ['zhipu', 'https://open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    ['baidu', 'https://qianfan.baidubce.com/v2', 'https://qianfan.baidubce.com/v2'],
    ['cohere', 'https://api.cohere.ai/compatibility/v1', 'https://api.cohere.ai/compatibility/v1'],
    ['openrouter', 'https://openrouter.ai', 'https://openrouter.ai/api/v1'],
    ['gemini', 'https://proxy.example/gemini/v1beta', 'https://proxy.example/gemini/v1beta'],
  ]
  for (const [provider, baseUrl, expected] of examples) assert.equal(getTextProviderBaseUrl({ provider, baseUrl }), expected)
  for (const baseUrl of ['https://example.com?key=secret', 'https://user:secret@example.com', 'ftp://example.com', 'https://example.com/v1/messages']) {
    assert.throws(() => getTextProviderBaseUrl({ provider: 'claude', baseUrl }))
  }
})

test('legacy settings select the native protocol and explicit Claude compatibility survives serialization', () => {
  assert.equal(textProviders.length, 19)
  assert.equal(parseConfigAPIFormat('claude', null), 'anthropic')
  assert.equal(parseConfigAPIFormat('gemini', '{broken'), 'google')
  assert.equal(parseConfigAPIFormat('claude', '{"api_format":"openai","temperature":0}'), 'openai')
  assert.throws(() => normalizeTextAPIFormat('gemini', 'anthropic'))
  assert.throws(() => normalizeTextAPIFormat('openai', 'anthropic'))
})

test('native Claude uses Messages headers and SDK token limits without OpenAI proxy parameters', async () => {
  const model = createTextModel(config, { fetch: async (url, init) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-api-key'), 'fake-key')
    assert.equal(headers.get('anthropic-version'), '2023-06-01')
    assert.equal(headers.get('authorization'), null)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.temperature, 0)
    assert.ok(body.max_tokens > 0)
    for (const field of ['enable_thinking', 'reasoning_effort', 'max_completion_tokens']) assert.equal(body[field], undefined)
    return json(anthropicResponse())
  } })
  const result = await model.doGenerate({ prompt })
  assert.deepEqual(result.content, [{ type: 'text', text: 'OK' }])
  assert.throws(() => createTextModel({ ...config, temperature: 1.5 }), /0 到 1/)
})

test('SDK handles native streaming and fragmented tool input', async () => {
  const model = createTextModel(config, { fetch: async () => anthropicStream({ type: 'tool_use', id: 'tool_1', name: 'save_script', input: { text: '已改写的剧本' } }) })
  const { stream } = await model.doStream({ prompt, tools: [{ type: 'function', name: 'save_script', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] })
  const parts = []
  for await (const part of stream) parts.push(part)
  const tool = parts.find(part => part.type === 'tool-call')
  assert.equal(tool?.toolName, 'save_script')
  assert.deepEqual(JSON.parse(tool?.input || '{}'), { text: '已改写的剧本' })
  assert.ok(!parts.some(part => part.type === 'error'))
})

test('all 19 providers test the same text protocol used by generation', async () => {
  for (const provider of textProviders) {
    const format = defaultTextAPIFormat(provider)
    const result = await probeTextConnection({ ...config, provider, baseUrl: 'https://mock.example/gateway', apiFormat: format }, async (url, init) => {
      assert.equal(init?.method, 'POST', provider)
      const body = JSON.parse(String(init?.body))
      if (format === 'anthropic') {
        assert.match(String(url), /\/v1\/messages$/)
        assert.equal(body.max_tokens, 64)
        return json(anthropicResponse())
      }
      if (format === 'google') {
        assert.match(String(url), /\/v1beta\/models\/claude-sonnet-4-6:generateContent/)
        assert.equal(body.generationConfig.maxOutputTokens, 64)
        return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } })
      }
      assert.match(String(url), /\/chat\/completions$/)
      assert.equal(body.max_tokens, 64)
      return json(openaiResponse())
    })
    assert.equal(result.ok, true, `${provider}: ${result.message}`)
  }
})

test('Claude compatibility uses Bearer/chat and vendor APIs avoid generic proxy-only fields', async () => {
  for (const connection of [
    { ...config, apiFormat: 'openai' as const, baseUrl: 'https://proxy.example/claude/v1' },
    { ...config, provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1' },
  ]) {
    const result = await probeTextConnection(connection, async (url, init) => {
      assert.match(String(url), /\/chat\/completions$/)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer fake-key')
      assert.equal(headers.get('x-api-key'), null)
      if (connection.provider === 'mistral') {
        const body = JSON.parse(String(init?.body))
        assert.equal(body.enable_thinking, undefined)
        assert.equal(body.reasoning_effort, undefined)
      }
      return json(openaiResponse())
    })
    assert.equal(result.ok, true, result.message)
  }
})

test('OpenAI relay probes, generation and streaming keep model thinking defaults', async t => {
  thinkingEnv(t)
  for (const modelName of ['gpt-6.1-sol', 'o3', 'gpt-4.1-mini']) {
    const connection: TextConnection = { provider: 'openai', baseUrl: 'http://relay.example:8080', apiKey: 'fake-key', model: modelName }
    let requests = 0
    const fetchImpl: typeof fetch = async (url, init) => {
      requests++
      assert.equal(String(url), 'http://relay.example:8080/v1/chat/completions')
      const body = JSON.parse(String(init?.body))
      if (body.reasoning_effort === 'none') {
        return json({ error: { message: `${modelName} does not support reasoning effort "none"; use low, medium, high or max`, type: 'invalid_request_error' } }, 400)
      }
      for (const field of ['thinking', 'enable_thinking', 'reasoning_effort']) assert.equal(body[field], undefined, `${modelName}: ${field}`)
      if (requests === 1) assert.equal(body.max_completion_tokens ?? body.max_tokens, 64)
      if (body.stream) {
        const chunk = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: modelName, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return json(openaiResponse())
    }
    const probe = await probeTextConnection(connection, fetchImpl)
    assert.equal(probe.ok, true, `${modelName}: ${probe.response_preview || probe.message}`)
    const model = createTextModel(connection, { fetch: fetchImpl })
    assert.deepEqual((await model.doGenerate({ prompt })).content, [{ type: 'text', text: 'OK' }])
    const { stream } = await model.doStream({ prompt })
    let text = ''
    for await (const part of stream) {
      assert.notEqual(part.type, 'error')
      if (part.type === 'text-delta') text += part.delta
    }
    assert.equal(text, 'OK')
    assert.equal(requests, 3)
  }
})

test('OpenAI relay thinking overrides remain opt-in and invalid overrides keep safe defaults', async t => {
  thinkingEnv(t)
  const connection: TextConnection = { provider: 'openai', baseUrl: 'https://relay.example', apiKey: 'fake-key', model: 'gpt-6.1-sol' }
  for (const patch of ['{"reasoning_effort":"low"}', '{invalid', 'null', '[]']) {
    process.env.AI_THINKING_OFF_PATCH = patch
    const result = await probeTextConnection(connection, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.reasoning_effort, patch.startsWith('{"') ? 'low' : undefined)
      assert.equal(body.thinking, undefined)
      assert.equal(body.enable_thinking, undefined)
      return json(openaiResponse())
    })
    assert.equal(result.ok, true, result.message)
  }
  process.env.AI_THINKING_OFF_PATCH = '{"reasoning_effort":"low"}'
  process.env.AI_DISABLE_THINKING = 'false'
  const result = await probeTextConnection(connection, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).reasoning_effort, undefined)
    return json(openaiResponse())
  })
  assert.equal(result.ok, true, result.message)
})

test('other compatible relays retain the existing thinking workaround', async t => {
  thinkingEnv(t)
  const result = await probeTextConnection({ provider: 'deepseek', baseUrl: 'https://relay.example', apiKey: 'fake-key', model: 'deepseek-chat' }, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal(body.enable_thinking, false)
    assert.equal(body.reasoning_effort, 'none')
    return json(openaiResponse())
  })
  assert.equal(result.ok, true, result.message)
})

test('auth, model/path, rate limit and invalid successful responses never pass the probe', async () => {
  for (const status of [401, 403, 404, 429]) {
    const result = await probeTextConnection(config, async () => json({ type: 'error', error: { type: 'authentication_error', message: 'fake-key rejected' } }, status))
    assert.equal(result.ok, false)
    assert.equal(result.reachable, true)
    assert.equal(result.status, status)
    assert.ok(!result.response_preview.includes('fake-key'))
  }
  const invalid = await probeTextConnection(config, async () => new Response('<html>proxy login</html>', { status: 200 }))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.reachable, true)

  const jsonError = await probeTextConnection(config, async () => json({ error: { type: 'authentication_error', message: 'invalid api key' } }))
  assert.equal(jsonError.ok, false)
  assert.equal(jsonError.reachable, true)
  assert.match(jsonError.message, /错误响应|未生成可验证文本/)

  const emptyAnthropic = await probeTextConnection(config, async () => json(anthropicResponse([])))
  assert.equal(emptyAnthropic.ok, false)
  assert.equal(emptyAnthropic.reachable, true)
  assert.match(emptyAnthropic.message, /未生成可验证文本/)

  const emptyOpenAI = await probeTextConnection({ ...config, apiFormat: 'openai', baseUrl: 'https://proxy.example/v1' }, async () => json({
    id: 'chatcmpl-empty', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
  }))
  assert.equal(emptyOpenAI.ok, false)
  assert.equal(emptyOpenAI.reachable, true)
  assert.match(emptyOpenAI.message, /过滤|未生成可验证文本/)

  const failed = await probeTextConnection(config, async () => { throw new Error('network unavailable') })
  assert.equal(failed.ok, false)
  assert.equal(failed.reachable, false)
})

test('Mastra executes native Claude tool_use and sends the tool result in the next turn', async () => {
  const { Agent } = await import('@mastra/core/agent')
  const { z } = await import('zod')
  let stored = ''
  let requests = 0
  const model = createTextModel(config, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    requests++
    if (requests === 1) {
      assert.equal(body.tools[0].name, 'save_script')
      const block = { type: 'tool_use' as const, id: 'tool_saved', name: 'save_script', input: { text: '已保存的测试剧本' } }
      return body.stream ? anthropicStream(block) : json(anthropicResponse([block], 'tool_use'))
    }
    assert.ok(body.messages.some((message: { content: unknown }) => JSON.stringify(message.content).includes('tool_result')))
    const block = { type: 'text' as const, text: 'saved' }
    return body.stream ? anthropicStream(block) : json(anthropicResponse([block]))
  } })
  const agent = new Agent({ id: 'claude-test', name: 'Claude integration test', instructions: 'Save the script.', model, tools: {
    save_script: { description: 'Save a script', inputSchema: z.object({ text: z.string() }), execute: async ({ text }: { text: string }) => { stored = text; return { saved: true } } },
  } })
  const result = await agent.generate('Save the script.', { maxSteps: 3 })
  assert.equal(stored, '已保存的测试剧本')
  assert.equal(result.text, 'saved')
  assert.equal(requests, 2)
})
