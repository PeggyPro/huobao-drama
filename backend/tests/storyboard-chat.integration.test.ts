import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Load the real route, agent and tools only AFTER isolating their database and workspace.
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
const cacheDir = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
mkdirSync(cacheDir, { recursive: true })
const workspace = mkdtempSync(join(cacheDir, 'storyboard-test-'))
process.env.WORKSPACE_PATH = workspace
const { db } = await import('../src/db/index.js')
const { default: agentRoute } = await import('../src/routes/agent.js')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.js')
const sqlite = db.$client
const originalFetch = globalThis.fetch

after(() => {
  globalThis.fetch = originalFetch
  sqlite.close()
  // workspace is the exact directory created by mkdtempSync above, never a user path.
  rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  globalThis.fetch = originalFetch
  for (const table of ['storyboard_characters', 'storyboard_props', 'storyboards', 'episode_characters', 'episode_scenes', 'episode_props', 'characters', 'scenes', 'props', 'episodes', 'dramas', 'ai_service_configs']) {
    sqlite.prepare(`DELETE FROM ${table}`).run()
  }
  const ts = '2026-01-01T00:00:00Z'
  sqlite.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (2, ?, ?, ?)').run('测试剧', ts, ts)
  sqlite.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, script_content, created_at, updated_at) VALUES (9, 2, 1, ?, ?, ?, ?)').run('测试集', '主角走入庭院，展开信纸。', ts, ts)
  sqlite.prepare('INSERT INTO characters (id, drama_id, name, created_at, updated_at) VALUES (15, 2, ?, ?, ?)').run('主角', ts, ts)
  sqlite.prepare('INSERT INTO scenes (id, drama_id, location, time, prompt, created_at, updated_at) VALUES (20, 2, ?, ?, ?, ?, ?)').run('庭院', '清晨', '清晨庭院', ts, ts)
  sqlite.prepare('INSERT INTO props (id, drama_id, name, created_at, updated_at) VALUES (10, 2, ?, ?, ?)').run('信纸', ts, ts)
  sqlite.prepare('INSERT INTO episode_characters (episode_id, character_id, created_at) VALUES (9, 15, ?)').run(ts)
  sqlite.prepare('INSERT INTO episode_scenes (episode_id, scene_id, created_at) VALUES (9, 20, ?)').run(ts)
  sqlite.prepare('INSERT INTO episode_props (episode_id, prop_id, created_at) VALUES (9, 10, ?)').run(ts)
  sqlite.prepare('INSERT INTO storyboards (episode_id, storyboard_number, description, created_at, updated_at) VALUES (9, 99, ?, ?, ?)').run('旧分镜', ts, ts)
  sqlite.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name, base_url, api_key, model, is_active, priority, created_at, updated_at)
    VALUES (11, 'text', 'openai', 'test', 'https://gateway.example/v1', 'test-only-key', '["qwen3.8-max"]', 1, 1, ?, ?)`).run(ts, ts)
})

function sse(delta: unknown, finishReason: string) {
  const chunk = (value: unknown, finish: string | null) => ({ id: 'integration-test', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-max', choices: [{ index: 0, delta: value, finish_reason: finish }] })
  return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, finishReason))}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}

function toolResponse(name: string, input: unknown, id = name) {
  return sse({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls')
}

function shot(shot_number: number) {
  return { shot_number, description: `【镜头1】主角展开信纸，分镜${shot_number}。`, video_prompt: '0-3秒：@主角在@庭院展开信纸。', duration: 12, scene_id: 20, character_ids: [15], prop_ids: [10] }
}

function chat() {
  return agentRoute.request('/storyboard_breaker/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drama_id: 2, episode_id: 9, message: '拆分剧本并保存全部分镜和视频提示词。' }),
  })
}

function savedShots() {
  return sqlite.prepare('SELECT storyboard_number, description, video_prompt, scene_id FROM storyboards WHERE episode_id = 9 ORDER BY storyboard_number').all() as Array<{ storyboard_number: number; description: string; video_prompt: string; scene_id: number }>
}

test('real route saves string booleans through the real tool, appends batches and persists all bindings', async () => {
  let requests = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, true)
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    assert.ok(names.includes('saveStoryboards'))
    assert.ok(names.every((name: string) => !name.startsWith('mastra_workspace_')), 'storyboard runs must not fall back to saving files')
    requests++
    if (requests === 1) return toolResponse('readStoryboardContext', {}, 'read')
    if (requests === 2) return toolResponse('saveStoryboards', { replace_existing: 'true', storyboards: [shot(1)] }, 'first')
    if (requests === 3) {
      assert.deepEqual(savedShots().map(row => row.storyboard_number), [1], 'string true must actually replace old rows')
      return toolResponse('saveStoryboards', { replace_existing: 'false', storyboards: [shot(2)] }, 'second')
    }
    if (requests === 4) {
      assert.deepEqual(savedShots().map(row => row.storyboard_number), [1, 2], 'string false must never clear earlier batches')
      return toolResponse('saveStoryboards', { storyboards: [shot(3)] }, 'third')
    }
    if (requests === 5) return toolResponse('saveStoryboards', { replace_existing: false, storyboards: [shot(4)] }, 'fourth')
    assert.equal(requests, 6)
    return sse({ role: 'assistant', content: '已保存全部分镜。' }, 'stop')
  }
  const response = await chat()
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.equal(requests, 6)
  const rows = savedShots()
  assert.deepEqual(rows.map(row => row.storyboard_number), [1, 2, 3, 4])
  assert.ok(rows.every(row => row.video_prompt && row.scene_id === 20))
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM storyboard_characters').get() as { n: number }).n, 4)
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM storyboard_props').get() as { n: number }).n, 4)
  assert.equal((sqlite.prepare('SELECT duration FROM episodes WHERE id = 9').get() as { duration: number }).duration, 1)
})

test('boolean input compatibility rejects ambiguous values and empty replacement before any write', () => {
  const schema = storyboardTools.saveStoryboards.inputSchema!
  for (const [value, expected] of [[true, true], [false, false], ['true', true], ['false', false]] as const) {
    const result = schema.parse({ replace_existing: value, storyboards: [shot(1)] })
    assert.equal(result.replace_existing, expected)
  }
  for (const value of ['yes', 'no', '0', '1', '', 'null', 0, 1, null, {}]) {
    assert.equal(schema.safeParse({ replace_existing: value, storyboards: [shot(1)] }).success, false)
  }
  assert.equal(schema.safeParse({ replace_existing: true, storyboards: [] }).success, false)
})

test('two invalid saves stop early and return HTTP failure without deleting existing storyboards', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    assert.ok(requests <= 2, 'must stop repeated validation failures without another model request')
    return toolResponse('saveStoryboards', { replace_existing: 'not-a-boolean', storyboards: [shot(1)] }, `invalid-${requests}`)
  }
  const response = await chat()
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /分镜.*失败|未.*保存/)
  assert.equal(requests, 2)
  assert.deepEqual(savedShots().map(row => row.storyboard_number), [99])
})

test('a model completion without a successful save is an HTTP error even if old storyboards exist', async () => {
  globalThis.fetch = async () => sse({ role: 'assistant', content: '已完成全部分镜。' }, 'stop')
  const response = await chat()
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /未.*保存/)
  assert.deepEqual(savedShots().map(row => row.storyboard_number), [99])
})

test('a corrected validation error can recover and successfully save', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    if (requests === 1) return toolResponse('saveStoryboards', { replace_existing: 'bad', storyboards: [shot(1)] }, 'bad')
    if (requests === 2) return toolResponse('saveStoryboards', { replace_existing: true, storyboards: [shot(1)] }, 'fixed')
    assert.equal(requests, 3)
    return sse({ role: 'assistant', content: '已保存。' }, 'stop')
  }
  const response = await chat()
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.deepEqual(savedShots().map(row => row.storyboard_number), [1])
})

test('a successful later batch cannot hide a failed earlier batch', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    if (requests === 1) return toolResponse('saveStoryboards', { replace_existing: 'bad', storyboards: [shot(1)] }, 'missing-first')
    if (requests === 2) return toolResponse('saveStoryboards', { replace_existing: true, storyboards: [shot(2)] }, 'unrelated-success')
    assert.equal(requests, 3)
    return sse({ role: 'assistant', content: '已经全部完成。' }, 'stop')
  }
  const response = await chat()
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /部分分镜已保存，整集生成未完成/)
  assert.deepEqual(savedShots().map(row => row.storyboard_number), [2])
})

test('a failed batch is recovered only after every shot in that batch is saved', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    if (requests === 1) return toolResponse('saveStoryboards', { replace_existing: 'bad', storyboards: [shot(1), shot(2)] }, 'missing-batch')
    if (requests === 2) return toolResponse('saveStoryboards', { replace_existing: true, storyboards: [shot(1)] }, 'only-first-repaired')
    assert.equal(requests, 3)
    return sse({ role: 'assistant', content: '已经全部完成。' }, 'stop')
  }
  const response = await chat()
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /部分分镜已保存，整集生成未完成/)
  assert.deepEqual(savedShots().map(row => row.storyboard_number), [1])
})

test('failure after a saved batch cannot report full success and keeps that batch', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    if (requests === 1) return toolResponse('saveStoryboards', { replace_existing: true, storyboards: [shot(1)] }, 'saved')
    if (requests === 2) return toolResponse('saveStoryboards', { replace_existing: 'bad', storyboards: [shot(2)] }, 'failed')
    return sse({ role: 'assistant', content: '已经全部完成。' }, 'stop')
  }
  const response = await chat()
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(await response.json()), /失败/)
  assert.deepEqual(savedShots().map(row => row.storyboard_number), [1])
})
