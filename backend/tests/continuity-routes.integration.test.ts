import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { Hono } from 'hono'

// Set every persistent boundary before importing routes or their database/services.
const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'huobao-continuity-routes-'))
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
process.env.HUOBAO_DATA_DIR = tempDir
process.env.STORAGE_PATH = path.join(tempDir, 'static')
process.env.WORKSPACE_PATH = path.join(tempDir, 'workspace')
process.env.COMFYUI_VIDEO_WORKFLOW = path.join(tempDir, 'workflow.json')
fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'videos'), { recursive: true })
const originalFetch = globalThis.fetch
const networkCalls: string[] = []
globalThis.fetch = async () => { throw new Error('Unmocked network is forbidden in continuity route tests') }
const { db, dbPath } = await import('../src/db/index.js')
const { default: storyboards } = await import('../src/routes/storyboards.js')
const { default: tasks } = await import('../src/routes/tasks.js')
const { stopVideoQueue } = await import('../src/services/video-queue.js')
const { STORAGE_ROOT } = await import('../src/utils/paths.js')
const sqlite = db.$client
const app = new Hono().route('/api/v1/storyboards', storyboards).route('/api/v1/tasks', tasks)
const timestamp = '2026-01-01T00:00:00.000Z'
const model = 'MiniMax_H3_route_fixture'
type Json = Record<string, any>
assert.equal(dbPath, ':memory:')
assert.equal(STORAGE_ROOT, process.env.STORAGE_PATH)
assert.equal((sqlite.pragma('database_list') as Json[]).find(row => row.name === 'main')?.file, '')

// A local workflow is used only for input validation; no worker, ffmpeg or model runs.
const workflow = {
  model: { class_type: 'UNETLoader', inputs: { unet_name: 'h3.safetensors', weight_dtype: 'default' } },
  vae: { class_type: 'VAELoader', inputs: { vae_name: 'h3-video.safetensors' } },
  audioVae: { class_type: 'VAELoader', inputs: { vae_name: 'h3-audio.safetensors' } },
  clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors', type: 'minimax' } },
  root: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: ['text', 0], width: 32, height: 32, length: 124, clip: ['clip', 0], vae: ['vae', 0], audio_vae: ['audioVae', 0] } },
  guider: { class_type: 'BasicGuider', inputs: { model: ['model', 0], conditioning: ['root', 0] } },
  noise: { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  sampler: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], latent_image: ['root', 1], guider: ['guider', 0] } },
  decode: { class_type: 'VAEDecode', inputs: { vae: ['vae', 0], samples: ['sampler', 0] } },
  audio: { class_type: 'VAEDecodeAudio', inputs: { vae: ['audioVae', 0], samples: ['sampler', 0] } },
  video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], audio: ['audio', 0], fps: 24 } },
  save: { class_type: 'SaveVideo', inputs: { video: ['video', 0] } },
  text: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'template' } },
  duration: { class_type: 'PrimitiveFloat', inputs: { value: 5 }, _meta: { title: 'duration' } },
}
fs.writeFileSync(process.env.COMFYUI_VIDEO_WORKFLOW, JSON.stringify(workflow))
const objectInfo = Object.fromEntries([
  ...Object.values(workflow).map(node => [node.class_type, {}]),
  ...['LoadImage', 'MiniMaxH3AddGuide', 'MiniMaxH3MotionContext', 'MiniMaxH3MotionContextSaveLatent', 'MiniMaxH3MotionContextTrim'].map(name => [name, {}]),
  ['MiniMaxH3MotionContextLoadLatent', { input: { required: { latent_path: ['STRING'], clip_index: ['INT'] } } }],
])
const independent = { version: 1, mode: 'independent', relation: 'same_scene_cut', source_storyboard_id: null, reason: 'new angle', needs_review: false, start_state: 'holding letter', end_state: 'letter unfolded', origin: 'ai', suggestion: null }
const continuation = (source: number, mode = 'motion_context') => ({ ...independent, mode, relation: 'continuous_action', source_storyboard_id: source })
const row = (id: number) => sqlite.prepare('SELECT * FROM storyboards WHERE id=?').get(id) as Json
const task = (id: number) => sqlite.prepare('SELECT * FROM sys_task WHERE id=?').get(id) as Json
const allTasks = () => sqlite.prepare('SELECT * FROM sys_task ORDER BY id').all() as Json[]
function snapshot() {
  return Object.fromEntries(['storyboards', 'storyboard_characters', 'storyboard_props', 'sys_task'].map(table => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
function plan(id: number, value: object) { sqlite.prepare('UPDATE storyboards SET continuity_plan=? WHERE id=?').run(JSON.stringify(value), id) }
function addTask(id: number, storyboardId: number, status = 'completed', extra: Json = {}) {
  sqlite.prepare(`INSERT INTO sys_task (id,type,storyboard_id,drama_id,provider,status,phase,local_path,batch_id,params,deleted_at,created_at,updated_at)
    VALUES (?,'video',?,2,'comfyui',?,?,?,?,?,?,?,?)`).run(id, storyboardId, status, extra.phase ?? status,
      extra.local_path ?? `/static/videos/history-${id}.mp4`, extra.batch_id ?? 'old-batch', JSON.stringify(extra.params ?? {}), extra.deleted_at ?? null, timestamp, timestamp)
}
const videoInput = (id: number, extra: Json = {}) => ({ type: 'video', storyboard_id: id, drama_id: 2, prompt: `shot ${id}`, model, config_id: 12, seed: 42, continuity_revision: row(id).continuity_revision, ...extra })
async function request(method: string, route: string, body?: unknown) {
  const response = await app.request(`/api/v1${route}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const json = await response.json() as Json
  assert.equal(json.code, response.status, JSON.stringify(json))
  return { status: response.status, ...json } as Json
}

beforeEach(() => {
  stopVideoQueue()
  networkCalls.length = 0
  // Fetch never delegates to the real implementation, including unrecognized URLs.
  globalThis.fetch = async (input, options) => {
    const url = String(input instanceof Request ? input.url : input)
    networkCalls.push(url)
    assert.equal(url, 'http://routes.invalid/object_info', 'only mocked capability queries may leave the route')
    assert.equal(options?.method || 'GET', 'GET', 'generation submission is forbidden')
    return Response.json(objectInfo)
  }
  for (const table of ['sys_task', 'storyboard_characters', 'storyboard_props', 'storyboards', 'episode_characters', 'episode_scenes', 'episode_props', 'characters', 'scenes', 'props', 'episodes', 'dramas', 'ai_service_configs']) sqlite.prepare(`DELETE FROM ${table}`).run()
  sqlite.prepare('INSERT INTO dramas (id,title,style,created_at,updated_at) VALUES (2,?,\'\',?,?)').run('isolated route test', timestamp, timestamp)
  sqlite.prepare(`INSERT INTO episodes (id,drama_id,episode_number,title,video_config_id,created_at,updated_at)
    VALUES (9,2,1,'test',12,?,?),(10,2,2,'other',12,?,?)`).run(timestamp, timestamp, timestamp, timestamp)
  sqlite.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,is_active,priority,created_at,updated_at)
    VALUES (12,'video','comfyui','route fixture','http://routes.invalid','',?,1,1,?,?)`).run(JSON.stringify([model]), timestamp, timestamp)
  sqlite.prepare('INSERT INTO characters (id,drama_id,name,created_at,updated_at) VALUES (15,2,?,?,?)').run('actor', timestamp, timestamp)
  sqlite.prepare('INSERT INTO episode_characters (episode_id,character_id,created_at) VALUES (9,15,?)').run(timestamp)
  for (const [id, episodeId, number, taskId] of [[100, 9, 1, 500], [101, 9, 2, 501], [102, 9, 3, 502], [110, 10, 1, 510]]) {
    const videoUrl = `/static/videos/history-${taskId}.mp4`
    sqlite.prepare(`INSERT INTO storyboards (id,episode_id,storyboard_number,title,description,video_prompt,video_url,video_task_id,continuity_plan,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, episodeId, number, `title ${id}`, `description ${id}`, `prompt ${id}`, videoUrl, taskId, JSON.stringify(independent), timestamp, timestamp)
    addTask(taskId, id)
  }
  sqlite.prepare('INSERT INTO storyboard_characters (storyboard_id,character_id) VALUES (100,15),(101,15)').run()
})
after(() => {
  stopVideoQueue()
  globalThis.fetch = originalFetch
  sqlite.close()
  assert.equal(path.dirname(tempDir), tempParent)
  assert.ok(path.basename(tempDir).startsWith('huobao-continuity-routes-'))
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('PUT persists a real manual continuity choice while retaining completed video and AI suggestion', async () => {
  const suggestion = { ...continuation(100), reason: 'AI suggestion' }
  plan(101, { ...independent, suggestion })
  const before = row(101)
  const result = await request('PUT', '/storyboards/101', { continuity_plan: { ...continuation(100, 'tail_frame'), origin: 'ai' }, continuity_revision: 0 })
  assert.equal(result.status, 200)
  assert.equal(result.data.continuity_revision, 1)
  assert.equal('continuityRevision' in result.data, false)
  const saved = JSON.parse(result.data.continuity_plan)
  assert.equal(saved.origin, 'manual')
  assert.equal(saved.mode, 'tail_frame')
  assert.equal(saved.source_storyboard_id, 100)
  assert.equal(saved.suggestion.reason, 'AI suggestion')
  assert.equal(result.data.video_url, before.video_url)
  assert.equal(result.data.video_task_id, before.video_task_id)
  assert.equal(result.data.video_prompt, before.video_prompt)
  assert.deepEqual(result.data.character_ids, [15])
})

test('transition-only PUT preserves AI origin and stale or missing revisions reject the whole update', async () => {
  const first = await request('PUT', '/storyboards/101', { transition_config: { type: 'audio_fade', duration_ms: 30 }, continuity_revision: 0 })
  assert.equal(first.status, 200)
  assert.equal(JSON.parse(first.data.continuity_plan).origin, 'ai')
  assert.deepEqual(JSON.parse(first.data.transition_config), { type: 'audio_fade', duration_ms: 30 })
  assert.equal(first.data.continuity_revision, 1)
  for (const revision of [0, undefined]) {
    const before = snapshot()
    const conflict = await request('PUT', '/storyboards/101', { continuity_revision: revision, title: 'must not save', character_ids: [], continuity_plan: continuation(100), transition_config: { type: 'dissolve', duration_ms: 250 } })
    assert.equal(conflict.status, 409)
    assert.deepEqual(snapshot(), before)
  }
})

test('invalid continuity sources and transitions do not partially update fields or bindings', async () => {
  for (const [id, payload] of [[100, { continuity_plan: continuation(101) }], [101, { continuity_plan: continuation(110) }], [101, { transition_config: { type: 'audio_fade', duration_ms: 101 } }]] as [number, Json][]) {
    const before = snapshot()
    const result = await request('PUT', `/storyboards/${id}`, { ...payload, continuity_revision: 0, title: 'invalid edit', character_ids: [] })
    assert.equal(result.status, 400)
    assert.deepEqual(snapshot(), before)
  }
})

test('choosing a completed historical video stores its matching task ID and retains other versions', async () => {
  addTask(600, 100)
  const result = await request('PUT', '/storyboards/100', { video_url: task(600).local_path, video_task_id: 600, continuity_revision: 0 })
  assert.equal(result.status, 200)
  assert.equal(result.data.video_task_id, 600)
  assert.equal(result.data.video_url, task(600).local_path)
  assert.equal(result.data.pending_video_task_id, null)
  assert.equal(task(500).status, 'completed')
  assert.equal(task(600).status, 'completed')
})

test('foreign, deleted, unfinished, wrong-type or mismatched historical task versions fail atomically', async () => {
  addTask(600, 100, 'failed')
  addTask(601, 100, 'completed', { deleted_at: timestamp })
  addTask(602, 100)
  sqlite.prepare("UPDATE sys_task SET type='image' WHERE id=602").run()
  for (const candidate of [
    { video_task_id: 501, video_url: task(501).local_path },
    { video_task_id: 600, video_url: task(600).local_path },
    { video_task_id: 601, video_url: task(601).local_path },
    { video_task_id: 602, video_url: task(602).local_path },
    { video_task_id: 500, video_url: '/static/videos/not-the-same-version.mp4' },
    { video_task_id: 99999, video_url: task(500).local_path },
  ]) {
    const before = snapshot()
    const result = await request('PUT', '/storyboards/100', { ...candidate, title: 'must not save', character_ids: [], continuity_revision: 0 })
    assert.equal(result.status, 400)
    assert.deepEqual(snapshot(), before)
  }
})

test('unfinished tasks protect the main video switch even when the pending pointer was cleared', async () => {
  addTask(600, 100)
  addTask(601, 100, 'queued')
  for (const status of ['queued', 'processing', 'downloading', 'blocked']) {
    sqlite.prepare('UPDATE sys_task SET status=?,phase=? WHERE id=601').run(status, status === 'blocked' ? 'submission_unknown' : status)
    sqlite.prepare('UPDATE storyboards SET pending_video_task_id=? WHERE id=100').run(status === 'blocked' ? null : 601)
    const before = snapshot()
    const result = await request('PUT', '/storyboards/100', { video_url: task(600).local_path, video_task_id: 600, continuity_revision: 0 })
    assert.equal(result.status, 409, `${status}: ${JSON.stringify(result)}`)
    assert.deepEqual(snapshot(), before)
  }
})

test('DELETE, POST and reorder return 409 without writes while the episode has unfinished generation', async () => {
  addTask(600, 101, 'queued')
  for (const status of ['queued', 'processing', 'downloading', 'blocked']) {
    sqlite.prepare('UPDATE sys_task SET status=?,phase=? WHERE id=600').run(status, status === 'blocked' ? 'submission_unknown' : status)
    for (const [method, route, body] of [
      ['DELETE', '/storyboards/100', undefined],
      ['POST', '/storyboards', { episode_id: 9, storyboard_number: 4, title: 'new' }],
      ['PUT', '/storyboards/100', { storyboard_number: 4, title: 'move', continuity_revision: 0 }],
    ] as [string, string, Json | undefined][]) {
      const before = snapshot()
      const result = await request(method, route, body)
      assert.equal(result.status, 409, `${method} with ${status}: ${JSON.stringify(result)}`)
      assert.deepEqual(snapshot(), before)
    }
  }
})

test('DELETE soft-deletes the shot, retains its video history, and marks the new adjacency for review', async () => {
  plan(102, { ...continuation(101), origin: 'manual' })
  const previousVideo = row(102).video_url
  const result = await request('DELETE', '/storyboards/101')
  assert.equal(result.status, 200)
  assert.ok(row(101).deleted_at)
  assert.equal(row(101).continuity_revision, 1)
  assert.equal(task(501).deleted_at, null)
  const following = row(102)
  const saved = JSON.parse(following.continuity_plan)
  assert.equal(saved.needs_review, true)
  assert.equal(saved.origin, 'manual')
  assert.equal(saved.source_storyboard_id, 101, 'do not silently rebind the manual choice')
  assert.equal(following.continuity_revision, 1)
  assert.equal(following.video_url, previousVideo)
})

test('POST returns snake-case shot metadata and marks an existing displaced source for review', async () => {
  sqlite.prepare('UPDATE storyboards SET storyboard_number=storyboard_number+1 WHERE id IN (101,102)').run()
  plan(101, { ...continuation(100), origin: 'manual' })
  const result = await request('POST', '/storyboards', { episode_id: 9, storyboard_number: 2, character_ids: [15], continuity_plan: independent, transition_config: { type: 'cut', duration_ms: 0 } })
  assert.equal(result.status, 201)
  assert.equal(result.data.storyboard_number, 2)
  assert.equal(result.data.episode_id, 9)
  assert.equal(result.data.continuity_revision, 1)
  assert.deepEqual(result.data.character_ids, [15])
  assert.equal(JSON.parse(result.data.continuity_plan).origin, 'manual')
  assert.equal(JSON.parse(row(101).continuity_plan).needs_review, true)
  assert.equal(JSON.parse(row(101).continuity_plan).source_storyboard_id, 100)
  const before = snapshot()
  assert.equal((await request('POST', '/storyboards', { episode_id: 9, storyboard_number: 2 })).status, 400)
  assert.deepEqual(snapshot(), before)
})

test('task list combines batch/type/storyboard filters and hides soft-deleted task records', async () => {
  addTask(600, 100, 'queued', { batch_id: 'selected-batch' })
  addTask(601, 100, 'queued', { batch_id: 'selected-batch', deleted_at: timestamp })
  addTask(602, 101, 'queued', { batch_id: 'other-batch' })
  addTask(603, 101, 'queued', { batch_id: 'selected-batch' })
  sqlite.prepare("UPDATE sys_task SET type='image' WHERE id=603").run()
  const list = await request('GET', '/tasks?batch_id=selected-batch&type=video&storyboard_id=100&drama_id=2')
  assert.equal(list.status, 200)
  assert.deepEqual(list.data.map((item: Json) => item.id), [600])
  assert.equal(typeof list.data[0].params, 'string')
  const batchOnly = await request('GET', '/tasks?batch_id=selected-batch')
  assert.deepEqual(batchOnly.data.map((item: Json) => item.id).sort(), [600, 603])
  assert.equal((await request('GET', '/tasks/601')).data, null)
  assert.equal((await request('GET', '/tasks')).data.some((item: Json) => item.id === 601), false)
})

test('batch preview is read-only and returns snake-case dependency fields for the real route', async () => {
  plan(101, continuation(100))
  const before = snapshot()
  const result = await request('POST', '/tasks/batch/preview', { episode_id: 9, tasks: [videoInput(101), videoInput(100)] })
  assert.equal(result.status, 200)
  assert.deepEqual(result.data.blockers, [])
  assert.equal(result.data.items.length, 2)
  const dependent = result.data.items.find((item: Json) => item.storyboard_id === 101)
  assert.deepEqual(Object.keys(dependent).sort(), ['blockers', 'depends_on_storyboard_id', 'mode', 'source_storyboard_id', 'source_task_id', 'storyboard_id', 'storyboard_number'])
  assert.equal(dependent.mode, 'motion_context')
  assert.equal(dependent.source_storyboard_id, 100)
  assert.equal(dependent.depends_on_storyboard_id, 100)
  assert.equal(dependent.source_task_id, null)
  assert.deepEqual(snapshot(), before)
  assert.deepEqual(networkCalls, ['http://routes.invalid/object_info'])
})

test('batch creation orders dependencies, keeps completed videos and deduplicates the request key', async () => {
  plan(101, continuation(100))
  const oldVideos = [row(100).video_url, row(101).video_url]
  const body = { episode_id: 9, request_key: 'route-batch-idempotent', tasks: [videoInput(101), videoInput(100)] }
  const result = await request('POST', '/tasks/batch', body)
  assert.equal(result.status, 201)
  assert.deepEqual(Object.keys(result.data).sort(), ['batch_id', 'task_ids'])
  assert.equal(result.data.batch_id, 'video:route-batch-idempotent')
  const [first, second] = result.data.task_ids.map(task)
  assert.equal(first.storyboard_id, 100)
  assert.equal(second.storyboard_id, 101)
  assert.equal(first.status, 'queued')
  assert.equal(second.depends_on_task_id, first.id)
  assert.equal(JSON.parse(second.params).continuitySourceTaskId, first.id)
  assert.deepEqual([row(100).pending_video_task_id, row(101).pending_video_task_id], [first.id, second.id])
  assert.deepEqual([row(100).video_url, row(101).video_url], oldVideos)
  assert.deepEqual([row(100).video_task_id, row(101).video_task_id], [500, 501])
  const before = snapshot()
  const repeated = await request('POST', '/tasks/batch', body)
  assert.deepEqual(repeated.data, result.data)
  assert.deepEqual(snapshot(), before)
  const changed = await request('POST', '/tasks/batch', { ...body, tasks: [videoInput(100, { prompt: 'different' })] })
  assert.equal(changed.status, 409)
  assert.deepEqual(snapshot(), before)
  const listed = await request('GET', `/tasks?batch_id=${encodeURIComponent(result.data.batch_id)}`)
  assert.deepEqual(listed.data.map((item: Json) => item.id), result.data.task_ids)
  assert.ok(allTasks().filter(item => item.batch_id === result.data.batch_id).every(item => item.status === 'queued'))
})

test('batch blockers are inspectable at preview and enqueue rejects without partially writing a valid shot', async () => {
  const body = { episode_id: 9, request_key: 'route-stale-revision', tasks: [videoInput(100), videoInput(101, { continuity_revision: 99 })] }
  const before = snapshot()
  const preview = await request('POST', '/tasks/batch/preview', body)
  assert.equal(preview.status, 200)
  assert.ok(preview.data.blockers.length)
  assert.match(preview.data.items.find((item: Json) => item.storyboard_id === 101).blockers.join(' '), /刷新/)
  assert.deepEqual(snapshot(), before)
  const result = await request('POST', '/tasks/batch', body)
  assert.equal(result.status, 409)
  assert.deepEqual(snapshot(), before)
})

test('metadata-only PUT preserves the primary and pending task while generation is unfinished', async () => {
  addTask(600, 100, 'queued')
  sqlite.prepare('UPDATE storyboards SET pending_video_task_id=600 WHERE id=100').run()
  const before = row(100)
  const result = await request('PUT', '/storyboards/100', { continuity_revision: 0, continuity_plan: independent, transition_config: { type: 'cut', duration_ms: 0 } })
  assert.equal(result.status, 200)
  for (const field of ['video_url', 'video_task_id', 'pending_video_task_id']) assert.equal(result.data[field], before[field])
  assert.equal(task(600).status, 'queued')
})

function mockReconciliation(requestKey?: string) {
  networkCalls.length = 0
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    networkCalls.push(url.pathname + url.search)
    assert.equal(url.origin, 'http://routes.invalid', 'the original endpoint is pinned')
    assert.equal(options?.method || 'GET', 'GET', 'reconciliation must never POST a generation')
    if (url.pathname === '/queue') return Response.json({ queue_running: requestKey ? [[1, 'original-upstream-id', {}, { huobao_request_key: requestKey }]] : [], queue_pending: [] })
    assert.equal(url.pathname + url.search, '/history?max_items=1000')
    return Response.json({})
  }
}

test('reconcile with no upstream match returns blocked unchanged and never submits again', async () => {
  const queued = await request('POST', '/tasks', videoInput(100))
  assert.equal(queued.status, 201)
  const id = queued.data.id
  sqlite.prepare("UPDATE sys_task SET status='blocked',phase='submission_unknown',blocked_reason='unconfirmed' WHERE id=?").run(id)
  sqlite.prepare('UPDATE storyboards SET pending_video_task_id=NULL WHERE id=100').run()
  const before = snapshot()
  mockReconciliation()
  const result = await request('POST', `/tasks/${id}/reconcile`, {})
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { id, reconciled: false, status: 'blocked' })
  assert.deepEqual(snapshot(), before)
  assert.deepEqual(networkCalls, ['/queue', '/history?max_items=1000'])
})

for (const continueDependents of [false, true]) test(`reconcile resumes the original ID and UUID, with continue_dependents=${continueDependents}`, async () => {
  plan(101, continuation(100))
  const queued = await request('POST', '/tasks/batch', { episode_id: 9, request_key: 'route-reconcile-batch', tasks: [videoInput(100), videoInput(101)] })
  assert.equal(queued.status, 201)
  const [id, childId] = queued.data.task_ids
  sqlite.prepare("UPDATE sys_task SET status='blocked',phase='submission_unknown',blocked_reason='unconfirmed' WHERE id=?").run(id)
  sqlite.prepare("UPDATE sys_task SET status='blocked',phase='blocked',blocked_reason='source unconfirmed' WHERE id=?").run(childId)
  sqlite.prepare('UPDATE storyboards SET pending_video_task_id=NULL WHERE id IN (100,101)').run()
  const oldTask = task(id)
  const originalIds = allTasks().map(item => item.id)
  mockReconciliation(oldTask.request_key)
  const result = await request('POST', `/tasks/${id}/reconcile`, continueDependents ? { continue_dependents: true } : {})
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { id, reconciled: true, status: 'queued' })
  assert.deepEqual(allTasks().map(item => item.id), originalIds, 'no replacement task is created')
  assert.equal(task(id).task_id, 'original-upstream-id')
  assert.equal(task(id).phase, 'polling')
  assert.equal(task(id).request_key, oldTask.request_key)
  assert.equal(task(id).params, oldTask.params, 'the artifact UUID and source version stay fixed')
  assert.equal(task(id).blocked_reason, null)
  assert.equal(row(100).pending_video_task_id, id)
  assert.equal(task(childId).status, continueDependents ? 'queued' : 'blocked')
  assert.equal(task(childId).depends_on_task_id, id)
  assert.equal(row(100).video_task_id, 500)
  assert.equal(row(100).video_url, '/static/videos/history-500.mp4')
  assert.deepEqual(networkCalls, ['/queue', '/history?max_items=1000'])
})

test('single video route queues without clearing the completed video or submitting to a provider', async () => {
  const before = row(100)
  const result = await request('POST', '/tasks', videoInput(100))
  assert.equal(result.status, 201)
  assert.equal(result.data.status, 'queued')
  assert.equal(result.data.id, row(100).pending_video_task_id)
  assert.equal(row(100).video_url, before.video_url)
  assert.equal(row(100).video_task_id, before.video_task_id)
  assert.equal(networkCalls.some(url => url.includes('/prompt')), false)
})
