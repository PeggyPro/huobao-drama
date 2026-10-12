import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
const cacheDir = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
mkdirSync(cacheDir, { recursive: true })
const workspace = mkdtempSync(join(cacheDir, 'continuity-analysis-test-'))
process.env.WORKSPACE_PATH = workspace
const { db } = await import('../src/db/index.js')
const { analyzeEpisodeContinuity } = await import('../src/services/continuity-analysis.js')
const sqlite = db.$client
const originalFetch = globalThis.fetch
const ts = '2026-01-01T00:00:00Z'

after(() => {
  globalThis.fetch = originalFetch
  sqlite.close()
  // Verify the precise test-created path before removing it; never use a user workspace.
  assert.equal(dirname(workspace), cacheDir.replace(/[\\/]$/, ''))
  rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  globalThis.fetch = async () => { throw new Error('Unexpected network request: every model response must be mocked') }
  for (const table of ['sys_task', 'storyboard_characters', 'storyboard_props', 'storyboards', 'episode_characters', 'episode_scenes', 'episode_props', 'characters', 'scenes', 'props', 'episodes', 'dramas', 'ai_service_configs']) sqlite.prepare(`DELETE FROM ${table}`).run()
  sqlite.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (2,?,?,?)').run('test', ts, ts)
  sqlite.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,script_content,video_config_id,created_at,updated_at) VALUES (9,2,1,\'test\',?,12,?,?)').run('主角展开信纸，然后抬头。', ts, ts)
  sqlite.prepare('INSERT INTO storyboards (id,episode_id,storyboard_number,description,video_prompt,video_url,video_task_id,created_at,updated_at) VALUES (100,9,1,?,?,?,?,?,?),(101,9,2,?,?,?,?,?,?)').run('first description', 'first prompt', 'static/first.mp4', 500, ts, ts, 'second description', 'second prompt', 'static/second.mp4', 501, ts, ts)
  sqlite.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,is_active,priority,created_at,updated_at)
    VALUES (11,'text','openai','test','https://gateway.example/v1','test-only-key','["qwen3.8-max"]',1,1,?,?),
    (12,'video','comfyui','h3','http://model.invalid','','["minimax_h3"]',1,1,?,?),
    (13,'video','comfyui','wan','http://model.invalid','','["wan2.2_5b"]',0,2,?,?)`).run(ts, ts, ts, ts, ts, ts)
})

function sse(delta: unknown, finishReason = 'stop') {
  const chunk = (value: unknown, finish: string | null) => ({ id: 'continuity-test', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-max', choices: [{ index: 0, delta: value, finish_reason: finish }] })
  return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, finishReason))}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}
function toolResponse(name: string, input: unknown, id = name) { return sse({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls') }
const finish = () => sse({ role: 'assistant', content: '已保存所有建议。' })
const independent = { mode: 'independent', relation: 'same_scene_cut', source_storyboard_id: null, reason: 'new camera angle', needs_review: false, start_state: 'holding letter', end_state: 'letter unfolded' }
const continuation = { ...independent, mode: 'motion_context', relation: 'continuous_action', source_storyboard_id: 100 }
const item = (id: number, continuity_plan: object = independent, revision = 0) => ({ storyboard_id: id, continuity_revision: revision, continuity_plan })
const rows = () => sqlite.prepare('SELECT * FROM storyboards ORDER BY id').all() as Record<string, any>[]
const content = () => rows().map(row => ({ id: row.id, description: row.description, video_prompt: row.video_prompt, video_url: row.video_url, video_task_id: row.video_task_id }))

test('analysis offers only read and metadata-save tools and succeeds only after all IDs are saved', async () => {
  const manual = { ...independent, version: 1, origin: 'manual', suggestion: null, reason: 'manual close-up' }
  sqlite.prepare('UPDATE storyboards SET continuity_plan=? WHERE id=101').run(JSON.stringify(manual))
  const before = content()
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), ['readStoryboardContext', 'saveContinuity'])
    calls++
    if (calls === 1) return toolResponse('readStoryboardContext', {})
    if (calls === 2) return toolResponse('saveContinuity', { items: [item(100), item(101, continuation)] })
    assert.equal(calls, 3)
    return finish()
  }
  const result = await analyzeEpisodeContinuity(9)
  assert.deepEqual(result, { count: 2, storyboard_ids: [100, 101] })
  assert.deepEqual(content(), before)
  const plan = JSON.parse(rows()[1].continuity_plan)
  assert.equal(plan.origin, 'manual')
  assert.equal(plan.reason, 'manual close-up')
  assert.equal(plan.mode, 'independent')
  assert.equal(plan.suggestion.mode, 'motion_context')
})

test('a model claiming completion without any successful save is rejected', async () => {
  globalThis.fetch = async () => finish()
  const before = rows()
  await assert.rejects(analyzeEpisodeContinuity(9), /0\/2/)
  assert.deepEqual(rows(), before)
})

test('partial saves remain inspectable but cannot report full success', async () => {
  let calls = 0
  globalThis.fetch = async () => ++calls === 1 ? toolResponse('saveContinuity', { items: [item(100)] }) : finish()
  await assert.rejects(analyzeEpisodeContinuity(9), /1\/2/)
  assert.equal(rows()[0].continuity_revision, 1)
  assert.equal(rows()[1].continuity_revision, 0)
})

test('two invalid tool schemas stop without a third model request or metadata writes', async () => {
  let calls = 0
  const before = rows()
  globalThis.fetch = async () => {
    assert.ok(++calls <= 2, 'validation failure loop must stop after two calls')
    return toolResponse('saveContinuity', { items: [item(100, { ...independent, mode: 'invented_mode' })] }, `bad-${calls}`)
  }
  await assert.rejects(analyzeEpisodeContinuity(9), /0\/2/)
  assert.equal(calls, 2)
  assert.deepEqual(rows(), before)
})

test('two invalid semantic sources also stop early and do not partially save a batch', async () => {
  let calls = 0
  const before = rows()
  globalThis.fetch = async () => {
    assert.ok(++calls <= 2)
    return toolResponse('saveContinuity', { items: [item(100), item(101, { ...continuation, source_storyboard_id: 999 })] }, `bad-source-${calls}`)
  }
  await assert.rejects(analyzeEpisodeContinuity(9), /0\/2/)
  assert.equal(calls, 2)
  assert.deepEqual(rows(), before)
})

test('one validation failure can recover with a complete corrected batch', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return toolResponse('saveContinuity', { items: [item(100, { ...independent, mode: 'bad' })] }, 'bad')
    if (calls === 2) return toolResponse('saveContinuity', { items: [item(100), item(101, continuation)] }, 'fixed')
    return finish()
  }
  assert.equal((await analyzeEpisodeContinuity(9)).count, 2)
})

test('a concurrent manual revision rejects the whole AI batch and preserves that manual edit', async () => {
  let calls = 0
  const beforeFirst = rows()[0]
  const manual = { ...independent, version: 1, origin: 'manual', suggestion: null, reason: 'edited during analysis' }
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      sqlite.prepare('UPDATE storyboards SET continuity_plan=?,continuity_revision=1 WHERE id=101').run(JSON.stringify(manual))
      return toolResponse('saveContinuity', { items: [item(100), item(101, continuation)] })
    }
    return finish()
  }
  await assert.rejects(analyzeEpisodeContinuity(9), /0\/2/)
  assert.deepEqual(rows()[0], beforeFirst)
  assert.equal(rows()[1].continuity_revision, 1)
  assert.deepEqual(JSON.parse(rows()[1].continuity_plan), manual)
})

test('repeating a saved ID cannot inflate completion count or overwrite an earlier save', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls <= 2) return toolResponse('saveContinuity', { items: [item(100)] }, `repeat-${calls}`)
    return finish()
  }
  await assert.rejects(analyzeEpisodeContinuity(9), /1\/2/)
  assert.equal(rows()[0].continuity_revision, 1)
  assert.equal(rows()[1].continuity_revision, 0)
})

test('read context reports the explicitly selected model capabilities rather than the old episode model', async () => {
  sqlite.prepare('UPDATE episodes SET video_config_id=13 WHERE id=9').run()
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    if (calls === 1) return toolResponse('readStoryboardContext', {})
    if (calls === 2) {
      const body = JSON.parse(String(init?.body))
      const payload = JSON.parse(body.messages.findLast((message: any) => message.role === 'tool').content)
      assert.deepEqual(payload.video_model, { provider: 'comfyui', model: 'minimax_h3', supported_modes: ['independent', 'tail_frame', 'motion_context'] })
      return toolResponse('saveContinuity', { items: [item(100), item(101, continuation)] })
    }
    return finish()
  }
  assert.equal((await analyzeEpisodeContinuity(9, { videoConfigId: 12, videoModel: 'minimax_h3' })).count, 2)
})

test('failure releases the per-episode analysis lock so another analysis can run', async () => {
  globalThis.fetch = async () => finish()
  await assert.rejects(analyzeEpisodeContinuity(9), /0\/2/)
  let calls = 0
  globalThis.fetch = async () => ++calls === 1 ? toolResponse('saveContinuity', { items: [item(100), item(101)] }) : finish()
  assert.equal((await analyzeEpisodeContinuity(9)).count, 2)
})
