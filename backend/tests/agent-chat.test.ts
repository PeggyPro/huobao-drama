import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { runAgentChat } from '../src/agents/chat.js'
import type { AgentRequestContextValues } from '../src/agents/context.js'
import { createTextModel } from '../src/services/text-model.js'

const connection = {
  provider: 'openai', baseUrl: 'https://gateway.example/v1',
  apiKey: 'test-only-key', model: 'qwen3.8-max',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
const completion = { id: 'chat-test', object: 'chat.completion', created: 1, model: connection.model }

function sse(deltas: unknown[], finishReason: string) {
  const chunks = deltas.map(delta => ({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }))
  chunks.push({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
  const bytes = new TextEncoder().encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Split transport frames, including UTF-8 characters, independently of tool argument deltas.
      for (let offset = 0; offset < bytes.length; offset += 37) controller.enqueue(bytes.slice(offset, offset + 37))
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

function toolResponse(id: string, name: string, input: unknown) {
  const args = JSON.stringify(input)
  const middle = Math.floor(args.length / 2)
  return sse([
    { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args.slice(0, middle) } }] },
    { tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] },
  ], 'tool_calls')
}

function context() {
  const requestContext = new RequestContext<AgentRequestContextValues>()
  requestContext.set('episodeId', 9)
  requestContext.set('dramaId', 2)
  return requestContext
}

test('storyboard chat streams fragmented tool calls, saves every batch, and returns the full result', async () => {
  const saved: Array<{ shot_number: number; description: string; video_prompt: string }> = []
  const replacements: Array<boolean | undefined> = []
  let requests = 0
  const model = createTextModel(connection, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, true, 'long storyboard responses must not use buffered completions')
    requests++
    if (requests === 1) return toolResponse('read-1', 'read_storyboard_context', {})
    if (requests === 2) {
      assert.ok(body.messages.some((message: { role: string; content: string }) => message.role === 'tool' && message.content.includes('测试剧本')))
      return toolResponse('save-1', 'save_storyboards', { replace_existing: true, storyboards: [{ shot_number: 1, description: '【镜头1】角色走进庭院。', video_prompt: '0-3秒：@主角走进@庭院。' }] })
    }
    if (requests === 3) {
      assert.equal(saved.length, 1, 'the first tool must execute before requesting the next batch')
      return toolResponse('save-2', 'save_storyboards', { storyboards: [{ shot_number: 2, description: '【镜头1】角色抬头望天。', video_prompt: '0-3秒：@主角抬头。' }] })
    }
    assert.equal(requests, 4)
    assert.equal(saved.length, 2)
    return sse([{ role: 'assistant', content: '已保存两个分镜。' }], 'stop')
  } })
  const agent = new Agent({
    id: 'storyboard_breaker', name: 'Storyboard test', instructions: 'Read and save both storyboard batches.', model,
    tools: {
      read_storyboard_context: createTool({
        id: 'read_storyboard_context', description: 'Read the script', inputSchema: z.object({}),
        execute: async (_input, toolContext) => {
          assert.equal(toolContext?.requestContext?.get('episodeId'), 9)
          return { script: '测试剧本', characters: [], scenes: [] }
        },
      }),
      save_storyboards: createTool({
        id: 'save_storyboards', description: 'Save a batch',
        inputSchema: z.object({ replace_existing: z.boolean().optional(), storyboards: z.array(z.object({ shot_number: z.number(), description: z.string(), video_prompt: z.string() })) }),
        execute: async (input, toolContext) => {
          assert.equal(toolContext?.requestContext?.get('dramaId'), 2)
          replacements.push(input.replace_existing)
          if (input.replace_existing) saved.length = 0
          saved.push(...input.storyboards)
          return { count: input.storyboards.length }
        },
      }),
    },
  })

  const result = await runAgentChat(agent, '拆分镜头', context())
  assert.equal(requests, 4)
  assert.equal(result.text, '已保存两个分镜。')
  assert.equal(result.error, undefined)
  assert.equal(result.toolCalls.length, 3)
  assert.equal(result.toolResults.length, 3)
  assert.deepEqual(replacements, [true, undefined])
  assert.deepEqual(saved.map(item => item.shot_number), [1, 2])
  assert.equal(saved[0].video_prompt, '0-3秒：@主角走进@庭院。')
})

test('upstream timeout rejects storyboard chat with its status and URL', async () => {
  const model = createTextModel(connection, { fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true)
    return json({ error: { message: '请求处理失败: 请求超时，请重试', type: 'timeout_error' } }, 400)
  } })
  const agent = new Agent({ id: 'storyboard_breaker', name: 'Timeout test', instructions: 'Split the script.', model })
  await assert.rejects(runAgentChat(agent, '拆分镜头', context()), (error: any) => {
    assert.match(error.message, /请求超时/)
    assert.equal(error.statusCode, 400)
    assert.equal(error.url, 'https://gateway.example/v1/chat/completions')
    return true
  })
})

test('an error inside the stream fails without replaying an already executed save', async () => {
  let requests = 0
  let saves = 0
  const model = createTextModel(connection, { fetch: async () => {
    requests++
    if (requests === 1) return toolResponse('save-once', 'save_storyboards', {})
    const partial = { ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '处理中' }, finish_reason: null }] }
    return new Response(`data: ${JSON.stringify(partial)}\n\ndata: {"error":{"message":"upstream stream interrupted","type":"server_error"}}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  } })
  const agent = new Agent({
    id: 'storyboard_breaker', name: 'Interrupted test', instructions: 'Save the script.', model,
    tools: { save_storyboards: { description: 'Save once', inputSchema: z.object({}), execute: async () => { saves++; return { saved: true } } } },
  })
  await assert.rejects(runAgentChat(agent, '拆分镜头', context()), /upstream stream interrupted|流式响应异常/)
  assert.equal(saves, 1)
  assert.equal(requests, 2)
})

test('script rewriting streams long tool arguments, saves once and returns the complete result', async () => {
  const content = '## S1 | 外景 · 庭院 | 清晨\n' + '主角走进庭院，展开信纸。\n主角：（抬头）终于找到你了。\n'.repeat(300)
  let stored = ''
  let saves = 0
  let requests = 0
  const model = createTextModel(connection, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, true, 'long screenplay responses must not use buffered completions')
    requests++
    if (requests === 1) return toolResponse('read-script', 'readEpisodeScript', {})
    if (requests === 2) {
      assert.ok(body.messages.some((message: { role: string; content: string }) => message.role === 'tool' && message.content.includes('待改写的原文')))
      return toolResponse('save-script', 'saveScript', { content })
    }
    assert.equal(requests, 3)
    assert.equal(stored, content, 'the complete script must be saved before the final model request')
    return sse([{ role: 'assistant', content: '已改写并保存。' }], 'stop')
  } })
  const agent = new Agent({
    id: 'script_rewriter', name: 'Rewrite test', instructions: 'Read, rewrite and save the script.', model,
    tools: {
      readEpisodeScript: createTool({
        id: 'read_episode_script', description: 'Read the script', inputSchema: z.object({}),
        execute: async (_input, toolContext) => {
          assert.equal(toolContext?.requestContext?.get('episodeId'), 9)
          return { content: '待改写的原文' }
        },
      }),
      saveScript: createTool({
        id: 'save_script', description: 'Save the script', inputSchema: z.object({ content: z.string() }),
        execute: async (input, toolContext) => {
          assert.equal(toolContext?.requestContext?.get('episodeId'), 9)
          stored = input.content
          saves++
          return { message: 'Script saved', word_count: stored.length }
        },
      }),
    },
  })
  const result = await runAgentChat(agent, '改写剧本', context())
  assert.equal(result.text, '已改写并保存。')
  assert.equal(result.error, undefined)
  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.toolResults.length, 2)
  assert.equal(stored, content)
  assert.equal(saves, 1)
  assert.equal(requests, 3)
})

test('a rewrite headers timeout propagates the upstream error instead of reporting success', async () => {
  let requests = 0
  const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
  const model = createTextModel(connection, { fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true)
    requests++
    throw new TypeError('fetch failed', { cause })
  } })
  const agent = new Agent({ id: 'script_rewriter', name: 'Rewrite timeout test', instructions: 'Rewrite the script.', model })
  await assert.rejects(runAgentChat(agent, '改写剧本', context()), (error: any) => {
    assert.match(error.message, /Headers Timeout Error/)
    assert.equal(error.url, 'https://gateway.example/v1/chat/completions')
    assert.equal(error.cause.code, 'UND_ERR_HEADERS_TIMEOUT')
    return true
  })
  assert.equal(requests, 1)
})

for (const savedBeforeFailure of [false, true]) {
  test(`a rewrite stream failure keeps ${savedBeforeFailure ? 'the saved script without replaying it' : 'an incomplete script out of the save tool'}`, async () => {
    let requests = 0
    let saves = 0
    const model = createTextModel(connection, { fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, true)
      requests++
      if (savedBeforeFailure && requests === 1) return toolResponse('saved', 'saveScript', { content: '完整剧本' })
      const partial = { ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {
        role: 'assistant', tool_calls: [{ index: 0, id: 'incomplete', type: 'function', function: { name: 'saveScript', arguments: '{"content":"未完成的剧本' } }],
      }, finish_reason: null }] }
      return new Response(`data: ${JSON.stringify(partial)}\n\ndata: {"error":{"message":"upstream stream interrupted","type":"server_error"}}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    } })
    const agent = new Agent({
      id: 'script_rewriter', name: 'Interrupted rewrite test', instructions: 'Rewrite and save the script.', model,
      tools: { saveScript: { description: 'Save once', inputSchema: z.object({ content: z.string() }), execute: async ({ content }) => {
        assert.equal(content, '完整剧本', 'partial output must never reach the save tool')
        saves++
        return { message: 'Script saved' }
      } } },
    })
    await assert.rejects(runAgentChat(agent, '改写剧本', context()), /upstream stream interrupted|流式响应异常/)
    assert.equal(saves, savedBeforeFailure ? 1 : 0)
    assert.equal(requests, savedBeforeFailure ? 2 : 1)
  })
}

for (const id of ['extractor', 'prompt_generator']) {
  test(`${id} retains its non-streaming provider behavior`, async () => {
    let requests = 0
    const model = createTextModel(connection, { fetch: async (_url, init) => {
      requests++
      assert.notEqual(JSON.parse(String(init?.body)).stream, true)
      return json({ ...completion, choices: [{ index: 0, message: { role: 'assistant', content: '已完成。' }, finish_reason: 'stop' }] })
    } })
    const agent = new Agent({ id, name: 'Other chat test', instructions: 'Complete the task.', model })
    const result = await runAgentChat(agent, '执行任务', context())
    assert.equal(result.text, '已完成。')
    assert.equal(requests, 1)
  })
}
