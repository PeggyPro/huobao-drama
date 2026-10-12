import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import type { VideoWorkerIO } from '../src/services/video-task-worker.js'

// Set every persistent boundary before the first business-module import. No app,
// server, actual provider, ffmpeg process, or production database is used here.
const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'huobao-video-queue-test-'))
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
process.env.COMFYUI_SUBMIT_CONCURRENCY = '2'
process.env.HUOBAO_DATA_DIR = tempDir
process.env.STORAGE_PATH = path.join(tempDir, 'static')
process.env.COMFYUI_VIDEO_WORKFLOW = path.join(tempDir, 'workflow.json')
fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'videos'), { recursive: true })
fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'frames'), { recursive: true })
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unmocked network is forbidden in video queue tests') }
const { db, dbPath, schema } = await import('../src/db/index.js')
const queue = await import('../src/services/video-queue.js')
const { runVideoTask, reconcileComfySubmission } = await import('../src/services/video-task-worker.js')
const { frozenVideoConfig, localVideoArtifact, jsonRecord } = await import('../src/services/video-task-input.js')
const { STORAGE_ROOT } = await import('../src/utils/paths.js')
const { comfyUIContextArtifact } = await import('../src/services/comfyui-artifacts.js')
assert.equal(dbPath, ':memory:')
assert.equal(STORAGE_ROOT, process.env.STORAGE_PATH)
assert.equal((db.$client.pragma('database_list') as { name: string; file: string }[]).find(row => row.name === 'main')?.file, '')

const baseUrl = 'http://queue.test'
const model = 'MiniMax_H3_queue_fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lTkAAAAASUVORK5CYII=', 'base64')
const referenceImages = await Promise.all(['#ff0000', '#00ff00'].map(background => sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer()))
const image = (index: number) => `data:image/png;base64,${referenceImages[index - 1].toString('base64')}`
const timestamp = () => new Date().toISOString()
type Json = Record<string, any>
type FetchCall = { url: URL; options?: RequestInit }
let calls: FetchCall[] = []
let downloadSequence = 0
let route: (url: URL, options?: RequestInit) => Promise<Response>
function graph(): Json {
  // Installed H3 AV socket conventions, with a tiny canvas for header mocks.
  return {
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
}
function objectInfo() {
  return Object.fromEntries([
    ...Object.values(graph()).map(node => [node.class_type, {}]),
    ...['LoadImage', 'MiniMaxH3AddGuide', 'MiniMaxH3MotionContext', 'MiniMaxH3MotionContextSaveLatent', 'MiniMaxH3MotionContextTrim'].map(type => [type, {}]),
    ['MiniMaxH3MotionContextLoadLatent', { input: { required: { latent_path: ['STRING'], clip_index: ['INT'] } } }],
  ])
}
function savedVideo(name: string) {
  const file = path.join(STORAGE_ROOT, 'videos', `${name}.mp4`)
  fs.writeFileSync(file, `mock playable file ${name}`)
  return `/static/videos/${name}.mp4`
}
function plan(mode = 'independent', source: number | null = null) {
  return JSON.stringify({ version: 1, mode, relation: 'continuous_action', source_storyboard_id: source, origin: 'manual', end_state: 'holds the cup' })
}
function fixture(count = 1, modes: string[] = []) {
  const ts = timestamp()
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'comfyui', name: 'queue fixture', baseUrl, apiKey: '', model: JSON.stringify([model]), priority: 1, isActive: true, createdAt: ts, updatedAt: ts }).returning().get()
  const drama = db.insert(schema.dramas).values({ title: 'isolated queue test', style: '', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'episode', videoConfigId: config.id, createdAt: ts, updatedAt: ts }).returning().get()
  const shots: (typeof schema.storyboards.$inferSelect)[] = []
  for (let i = 0; i < count; i++) {
    shots.push(db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: i + 1, videoPrompt: `shot ${i + 1}`, duration: 5,
      continuityPlan: plan(modes[i] || 'independent', modes[i] && modes[i] !== 'independent' ? shots[i - 1].id : null), createdAt: ts, updatedAt: ts }).returning().get())
  }
  return { config, episode, shots }
}
function input(shot: { id: number }, extra: Json = {}) { return { storyboard_id: shot.id, prompt: 'person moves the cup', seed: 42, ...extra } }
function task(id: number) { const row = queue.getVideoTask(id); assert.ok(row); return row }
function params(id: number): Json { return jsonRecord(task(id).params) }
function shot(id: number) { const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get(); assert.ok(row); return row }
function patchTask(id: number, values: Partial<typeof schema.sysTask.$inferInsert>) { db.update(schema.sysTask).set(values).where(eq(schema.sysTask.id, id)).run() }
function patchShot(id: number, values: Partial<typeof schema.storyboards.$inferInsert>) { db.update(schema.storyboards).set(values).where(eq(schema.storyboards.id, id)).run() }
function claim(id: number) { const token = queue.claimVideoTask(id); assert.ok(token, `task ${id} should be claimable`); return token }
function history(id = 'upstream', requestKey?: string) {
  return { [id]: { prompt: [0, id, {}, { huobao_request_key: requestKey }], status: { completed: true, status_str: 'success' }, outputs: { save: { images: [{ filename: 'result.mp4', subfolder: 'video', type: 'output' }] } } } }
}
function io(overrides: Partial<VideoWorkerIO> = {}): Partial<VideoWorkerIO> {
  return {
    fetch: globalThis.fetch, pollIntervalMs: 0,
    download: async () => savedVideo(`downloaded-${++downloadSequence}`),
    probe: async () => ({ duration: 5, duration_ms: 5000, width: 32, height: 32, fps: '24/1', fps_num: 24, fps_den: 1, frame_count: 120,
      has_audio: true, audio_sample_rate: 48000, audio_channels: 2, audio_duration: 5, timebase: '1/12288' }),
    poster: async () => '/static/frames/poster.png',
    extractTail: async () => { fs.writeFileSync(path.join(STORAGE_ROOT, 'frames', 'tail.png'), png); return '/static/frames/tail.png' },
    inspectContext: async (_config, artifact, compatibility) => ({ ...artifact, compatibility, verified: true, format: 'h3_motion_context_av_v1', contentLength: 12500, headerLength: 332, headerSha256: 'a'.repeat(64),
      tensors: { video: { dtype: 'F32', shape: [1, 24, 7, 2, 2], data_offsets: [0, 2688] }, audio: { dtype: 'F32', shape: [1, 32, 2, 37], data_offsets: [2688, 12160] } } }),
    ...overrides,
  }
}
function succeed() {
  route = async (url) => {
    if (url.pathname === '/prompt') return Response.json({ prompt_id: 'upstream' })
    if (url.pathname === '/history/upstream') return Response.json(history())
    throw new Error(`Unexpected mocked request ${url}`)
  }
}
async function chain() {
  const f = fixture(3, ['independent', 'tail_frame', 'motion_context'])
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, request_key: 'chain-request', tasks: f.shots.map(row => input(row)).reverse() })
  return { ...f, ids: result.task_ids }
}
function contextBytes() {
  const header = Buffer.from(JSON.stringify({ __metadata__: { format: 'h3_motion_context_av_v1' },
    video: { dtype: 'F32', shape: [1, 24, 7, 2, 2], data_offsets: [0, 2688] }, audio: { dtype: 'F32', shape: [1, 32, 2, 37], data_offsets: [2688, 12160] } }))
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([size, header, Buffer.alloc(12160)])
}
function contextResponse(options?: RequestInit) {
  const bytes = contextBytes()
  if (options?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes.length) } })
  const range = new Headers(options?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!
  const start = Number(range[1]), end = Number(range[2])
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } })
}

beforeEach((t) => {
  assert.ok('mock' in t, 'this hook must run in a test context')
  t.mock.method(console, 'log', () => {})
  queue.stopVideoQueue()
  assert.equal(dbPath, ':memory:')
  for (const table of [schema.storyboardCharacters, schema.storyboardProps, schema.sysTask, schema.storyboards, schema.episodes, schema.dramas, schema.aiServiceConfigs]) db.delete(table).run()
  fs.writeFileSync(process.env.COMFYUI_VIDEO_WORKFLOW!, JSON.stringify(graph()))
  calls = []
  route = async url => { throw new Error(`Unexpected mocked request ${url}`) }
  t.mock.method(globalThis, 'fetch', async (value: string | URL | Request, options?: RequestInit) => {
    const url = new URL(value instanceof Request ? value.url : String(value))
    assert.equal(url.origin, baseUrl, 'a persisted task must use its original endpoint')
    calls.push({ url, options })
    if (url.pathname === '/object_info') return Response.json(objectInfo())
    return route(url, options)
  })
})
after(() => {
  queue.stopVideoQueue()
  db.$client.close()
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(fs.realpathSync(tempDir)), tempParent)
  assert.match(path.basename(tempDir), /^huobao-video-queue-test-/)
  fs.rmSync(tempDir, { recursive: true })
})

test('single and batch use the same frozen params; autostart=false leaves tasks unclaimed', async () => {
  const f = fixture()
  const body = input(f.shots[0], { input: { prompt: 'ignored lower priority' }, duration: 7, generate_audio: false, reference_image_urls: [image(1), image(2)] })
  const single = await queue.enqueueSingleVideo(body)
  const first = params(single)
  assert.equal(task(single).status, 'queued'); assert.equal(task(single).workerToken, null)
  assert.equal(first.seed, 42); assert.equal(first.duration, 7); assert.equal(first.generateAudio, 0)
  assert.equal(first.workflowSnapshot.noise.inputs.noise_seed, 42)
  assert.equal(first.workflowSnapshot.duration.inputs.value, 7)
  assert.match(first.workflowHash, /^[a-f0-9]{64}$/)
  assert.equal(first.compatibility.width, 32)
  assert.ok(!JSON.stringify(first.connection).includes('apiKey'))
  queue.cancelVideoTask(single)
  const batch = await queue.enqueueVideoBatch({ episode_id: f.episode.id, request_key: 'same-frozen-input', tasks: [body] })
  const second = params(batch.task_ids[0])
  const comparable = ({ artifactUuid: _artifact, requestKey: _key, ...value }: Json) => value
  assert.deepEqual(comparable(second), comparable(first))
  assert.notEqual(second.artifactUuid, first.artifactUuid)
  assert.notEqual(second.requestKey, first.requestKey)
  assert.equal(calls.filter(call => call.url.pathname === '/object_info').length, 1)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})

test('the same request key deduplicates concurrent requests and rejects a changed body with 409', async () => {
  const f = fixture()
  const body = { episode_id: f.episode.id, request_key: 'idempotent-body', tasks: [input(f.shots[0])] }
  const [a, b] = await Promise.all([queue.enqueueVideoBatch(body), queue.enqueueVideoBatch(structuredClone(body))])
  assert.deepEqual(a, b)
  assert.equal(db.select().from(schema.sysTask).all().length, 1)
  const identity = params(a.task_ids[0]).artifactUuid
  await assert.rejects(queue.enqueueVideoBatch({ ...body, tasks: [input(f.shots[0], { prompt: 'different' })] }), (error: any) => error.status === 409)
  assert.equal(params(a.task_ids[0]).artifactUuid, identity)
  queue.cancelVideoTask(a.task_ids[0])
  assert.deepEqual(await queue.enqueueVideoBatch(body), a)
})

test('single-request idempotency persists the same task and a rejected batch writes no partial rows', async () => {
  const f = fixture(2)
  const body = input(f.shots[0], { request_key: 'single-key-reuse' })
  const id = await queue.enqueueSingleVideo(body)
  assert.equal(await queue.enqueueSingleVideo(body), id)
  await assert.rejects(queue.enqueueSingleVideo({ ...body, seed: 43 }), (error: any) => error.status === 409)
  queue.cancelVideoTask(id)
  const count = db.select().from(schema.sysTask).all().length
  await assert.rejects(queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: [input(f.shots[0]), input(f.shots[1], { seed: 0.5 })] }), /seed/)
  assert.equal(db.select().from(schema.sysTask).all().length, count)
  assert.equal(shot(f.shots[0].id).pendingVideoTaskId, null)
  assert.equal(shot(f.shots[1].id).pendingVideoTaskId, null)
})

test('same-batch parent binding waits for the new task and never freezes the old video', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  patchShot(f.shots[0].id, { videoUrl: savedVideo('previous-version') })
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: [input(f.shots[1]), input(f.shots[0])] })
  const [parent, child] = result.task_ids
  assert.equal(task(parent).storyboardId, f.shots[0].id)
  assert.equal(task(child).dependsOnTaskId, parent)
  assert.equal(params(child).continuitySourceTaskId, parent)
  assert.equal(params(child).sourceVideo, undefined)
  assert.equal(queue.claimVideoTask(child), null)
  const token = claim(parent)
  assert.equal(queue.claimVideoTask(child), null)
  const current = savedVideo('current-version')
  assert.equal(queue.publishVideoResult(parent, token, current, 'https://result.test/video.mp4', {}).published, true)
  assert.equal(shot(f.shots[0].id).videoUrl, current)
  assert.ok(queue.claimVideoTask(child))
})

for (const failure of ['failed', 'cancelled', 'deleted'] as const) {
  test(`a ${failure} dependency blocks every unsubmitted descendant`, async () => {
    const f = await chain(), [parent, child, grandchild] = f.ids
    if (failure === 'failed') queue.finishVideoFailure(parent, claim(parent), new Error('mock provider failed'))
    else queue.cancelVideoTask(parent, failure === 'deleted')
    for (const id of [child, grandchild]) {
      assert.equal(task(id).status, 'blocked')
      assert.equal(task(id).phase, 'dependency_failed')
      assert.ok(task(id).blockedReason)
      assert.equal(queue.claimVideoTask(id), null)
    }
    assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
  })
}

test('retry_continue reconnects only unsubmitted descendants and retains their frozen identity', async () => {
  const f = await chain(), [parent, child, grandchild] = f.ids
  const childBefore = params(child), grandBefore = params(grandchild)
  queue.finishVideoFailure(parent, claim(parent), new Error('failed before submission'))
  const excluded: number[] = []
  for (const extra of [{ taskId: 'already-submitted' }, { workerToken: 'active-worker' }, { phase: 'submission_unknown' }, { deletedAt: timestamp() }]) {
    const old = task(child)
    const copy = db.insert(schema.sysTask).values({ type: 'video', provider: old.provider, params: old.params, dependsOnTaskId: parent,
      status: 'blocked', phase: 'dependency_failed', createdAt: timestamp(), updatedAt: timestamp(), ...extra }).returning().get()
    excluded.push(copy.id)
  }
  const retry = await queue.retryVideoTask(parent, true)
  assert.notEqual(retry.id, parent)
  assert.equal(task(retry.id).retryOfTaskId, parent)
  assert.notEqual(params(retry.id).artifactUuid, params(parent).artifactUuid)
  assert.equal(task(child).dependsOnTaskId, retry.id)
  assert.equal(params(child).continuitySourceTaskId, retry.id)
  assert.equal(task(grandchild).dependsOnTaskId, child)
  for (const [id, before] of [[child, childBefore], [grandchild, grandBefore]] as const) {
    assert.equal(task(id).status, 'queued')
    assert.equal(params(id).artifactUuid, before.artifactUuid)
    assert.equal(params(id).requestKey, before.requestKey)
    assert.deepEqual(params(id).workflowSnapshot, before.workflowSnapshot)
    assert.equal(params(id).sourceVideo, undefined)
  }
  for (const id of excluded) assert.equal(task(id).dependsOnTaskId, parent)
})

test('lease recovery preserves upstream identity and stale workers cannot write results or failures', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0]))
  const old = claim(id)
  assert.equal(queue.claimVideoTask(id), null)
  queue.updateLeasedVideo(id, old, { taskId: 'running-on-gpu', phase: 'polling' })
  patchTask(id, { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
  assert.throws(() => queue.updateLeasedVideo(id, old, { resultUrl: 'late' }), queue.LostVideoLease)
  const current = claim(id)
  assert.notEqual(current, old)
  assert.equal(task(id).taskId, 'running-on-gpu')
  assert.equal(task(id).phase, 'polling')
  assert.throws(() => queue.publishVideoResult(id, old, 'late.mp4', 'late', {}), queue.LostVideoLease)
  queue.finishVideoFailure(id, old, new Error('late failure'))
  assert.equal(task(id).workerToken, current)
  assert.equal(task(id).status, 'processing')
  assert.equal(task(id).localPath, null)
  for (const expiry of [null, 'not-a-date']) {
    patchTask(id, { leaseExpiresAt: expiry })
    assert.throws(() => queue.requireVideoLease(id, current), queue.LostVideoLease)
  }
})

for (const deleting of [false, true]) {
  test(`${deleting ? 'deletion' : 'cancellation'} during download prevents late completion from publishing`, async () => {
    const f = fixture(), oldUrl = savedVideo('existing-main')
    patchShot(f.shots[0].id, { videoUrl: oldUrl })
    const id = await queue.enqueueSingleVideo(input(f.shots[0]))
    const token = claim(id)
    queue.updateLeasedVideo(id, token, { taskId: 'upstream', phase: 'polling' })
    succeed()
    await assert.rejects(runVideoTask(id, token, io({ download: async () => {
      queue.cancelVideoTask(id, deleting)
      return savedVideo('late-download')
    } })), queue.LostVideoLease)
    assert.equal(task(id).status, 'cancelled')
    assert.equal(!!task(id).deletedAt, deleting)
    assert.equal(task(id).localPath, null)
    assert.equal(shot(f.shots[0].id).videoUrl, oldUrl)
    assert.equal(shot(f.shots[0].id).pendingVideoTaskId, null)
    assert.throws(() => queue.publishVideoResult(id, token, '/static/videos/late.mp4', 'late', {}), queue.LostVideoLease)
  })
}

test('changed storyboard inputs archive a completed result without replacing the current video', async () => {
  const f = await chain(), [id, child] = f.ids
  const oldUrl = savedVideo('main-before-edit')
  patchShot(f.shots[0].id, { videoUrl: oldUrl })
  const token = claim(id)
  queue.updateLeasedVideo(id, token, { taskId: 'upstream', phase: 'polling' })
  succeed()
  await runVideoTask(id, token, io({ download: async () => {
    patchShot(f.shots[0].id, { videoPrompt: 'edited after submit' })
    return savedVideo('archived-edit')
  } }))
  assert.equal(task(id).status, 'completed')
  assert.equal(task(id).phase, 'completed_stale')
  assert.equal(task(id).localPath, '/static/videos/archived-edit.mp4')
  assert.ok(jsonRecord(task(id).artifacts).video)
  assert.equal(shot(f.shots[0].id).videoUrl, oldUrl)
  assert.equal(shot(f.shots[0].id).videoTaskId, null)
  assert.equal(task(child).status, 'blocked')
  assert.equal(queue.claimVideoTask(child), null)
})

test('input changes before submission reject the task without contacting prompt', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0]))
  patchShot(f.shots[0].id, { duration: 9 })
  await assert.rejects(runVideoTask(id, claim(id), io()), /输入已改变/)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})

test('a persisted upstream ID only polls, using the original endpoint after the default changes', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0]))
  const token = claim(id)
  queue.updateLeasedVideo(id, token, { taskId: 'upstream', phase: 'polling' })
  db.update(schema.aiServiceConfigs).set({ baseUrl: 'http://new-default.invalid', model: '["different-model"]' }).where(eq(schema.aiServiceConfigs.id, f.config.id)).run()
  const frozen = await frozenVideoConfig(params(id))
  assert.equal(frozen.baseUrl, baseUrl)
  assert.equal(frozen.model, model)
  // Frozen recovery must not depend on today's workflow file either.
  fs.writeFileSync(process.env.COMFYUI_VIDEO_WORKFLOW!, '{invalid current workflow')
  succeed()
  calls = []
  await runVideoTask(id, token, io())
  assert.deepEqual(calls.map(call => call.url.pathname), ['/history/upstream'])
  assert.equal(task(id).status, 'completed')
  assert.equal(shot(f.shots[0].id).videoTaskId, id)
})

test('changed authenticated original connection fails instead of borrowing new default credentials', async () => {
  const f = fixture()
  db.update(schema.aiServiceConfigs).set({ apiKey: 'original-test-key' }).where(eq(schema.aiServiceConfigs.id, f.config.id)).run()
  const id = await queue.enqueueSingleVideo(input(f.shots[0]))
  assert.equal(params(id).connection.requiresAuth, true)
  assert.equal(JSON.stringify(params(id)).includes('original-test-key'), false)
  db.update(schema.aiServiceConfigs).set({ baseUrl: 'http://replacement.invalid', apiKey: 'new-key' }).where(eq(schema.aiServiceConfigs.id, f.config.id)).run()
  calls = []
  await assert.rejects(runVideoTask(id, claim(id), io()), /原任务连接或凭据已改变/)
  assert.equal(calls.length, 0)
})

test('submission uses frozen seed/workflow and persists verified context without leaking credentials', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0]))
  const frozen = params(id)
  fs.writeFileSync(process.env.COMFYUI_VIDEO_WORKFLOW!, JSON.stringify({ replaced: { class_type: 'UnknownNode', inputs: {} } }))
  let submitted: Json | undefined
  route = async (url, options) => {
    if (url.pathname === '/prompt') { submitted = JSON.parse(String(options?.body)); return Response.json({ prompt_id: 'upstream' }) }
    if (url.pathname === '/history/upstream') return Response.json(history())
    throw new Error(`Unexpected request ${url}`)
  }
  await runVideoTask(id, claim(id), io())
  assert.ok(submitted)
  assert.deepEqual(submitted.extra_data, { huobao_request_key: frozen.requestKey, huobao_task_id: id })
  assert.equal(submitted.prompt.noise.inputs.noise_seed, frozen.seed)
  assert.equal(submitted.prompt.model.inputs.unet_name, 'h3.safetensors')
  const context = jsonRecord(task(id).artifacts).context
  assert.equal(context.verified, true)
  assert.equal(context.subfolder, `h3_context/${frozen.artifactUuid}`)
  assert.deepEqual(context.compatibility, frozen.compatibility)
})

for (const foundIn of ['queue', 'history'] as const) {
  test(`an uncertain submission reconciles ${foundIn} by requestKey and never resubmits`, async () => {
    const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0])), token = claim(id)
    queue.updateLeasedVideo(id, token, { phase: 'submitting' })
    const key = params(id).requestKey
    route = async url => {
      if (url.pathname === '/queue') return Response.json({ queue_running: foundIn === 'queue' ? [[0, 'upstream', {}, { huobao_request_key: key }]] : [], queue_pending: [] })
      if (url.pathname === '/history') { assert.equal(url.searchParams.get('max_items'), '1000'); return Response.json(foundIn === 'history' ? history('upstream', key) : {}) }
      if (url.pathname === '/history/upstream') return Response.json(history())
      throw new Error(`Unexpected request ${url}`)
    }
    calls = []
    await runVideoTask(id, token, io())
    assert.deepEqual(calls.map(call => call.url.pathname), ['/queue', '/history', '/history/upstream'])
    assert.equal(task(id).taskId, 'upstream')
    assert.equal(task(id).status, 'completed')
  })
}

test('unknown submission absent from both queue and history stays blocked and cannot be blindly retried', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0])), token = claim(id)
  queue.updateLeasedVideo(id, token, { phase: 'submitting' })
  route = async url => {
    if (url.pathname === '/queue') return Response.json({ queue_pending: [], queue_running: [] })
    if (url.pathname === '/history') return Response.json({})
    throw new Error(`Unexpected request ${url}`)
  }
  let failure: unknown
  try { await runVideoTask(id, token, io()) } catch (error) { failure = error }
  assert.match(String(failure), /禁止自动重发/)
  queue.finishVideoFailure(id, token, failure)
  assert.equal(task(id).status, 'blocked')
  assert.equal(task(id).phase, 'submission_unknown')
  await assert.rejects(queue.retryVideoTask(id), (error: any) => error.status === 409)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})

test('submission_unknown blocks fresh request keys and batch preflight creates no rows', async () => {
  const f = fixture(2)
  const uncertainId = await queue.enqueueSingleVideo(input(f.shots[0], { request_key: 'original-unknown' }))
  const token = claim(uncertainId), originalRequestKey = task(uncertainId).requestKey
  queue.updateLeasedVideo(uncertainId, token, { phase: 'submitting' })
  queue.finishVideoFailure(uncertainId, token, new Error('connection lost after acceptance'))
  assert.equal(task(uncertainId).status, 'blocked')
  assert.equal(task(uncertainId).phase, 'submission_unknown')
  const before = db.select().from(schema.sysTask).all().map(row => row.id)
  await assert.rejects(queue.enqueueSingleVideo(input(f.shots[0], { request_key: 'fresh-single' })), (error: any) => error.status === 409)
  assert.deepEqual(db.select().from(schema.sysTask).all().map(row => row.id), before)
  await assert.rejects(queue.enqueueVideoBatch({ episode_id: f.episode.id, request_key: 'fresh-batch', tasks: [
    input(f.shots[0], { request_key: 'fresh-batch-child' }), input(f.shots[1], { request_key: 'fresh-batch-second' }),
  ] }), (error: any) => error.status === 409)
  assert.deepEqual(db.select().from(schema.sysTask).all().map(row => row.id), before)
  assert.equal(shot(f.shots[1].id).pendingVideoTaskId, null)
  assert.equal(task(uncertainId).requestKey, originalRequestKey)
  const preview = await queue.previewVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
  assert.ok(preview.blockers.length)
  assert.deepEqual(db.select().from(schema.sysTask).all().map(row => row.id), before)
  queue.cancelVideoTask(uncertainId)
  const replacement = await queue.enqueueSingleVideo(input(f.shots[0], { request_key: 'explicit-restart' }))
  assert.notEqual(replacement, uncertainId)
  assert.notEqual(params(replacement).requestKey, originalRequestKey)
})

test('conflicting requestKey matches and unavailable reconciliation endpoints cannot authorize submission', async () => {
  const config = { provider: 'comfyui', baseUrl, apiKey: '', model }
  route = async url => url.pathname === '/queue'
    ? Response.json({ queue_running: [[0, 'one', {}, { huobao_request_key: 'key' }]], queue_pending: [] })
    : Response.json(history('two', 'key'))
  await assert.rejects(reconcileComfySubmission(config, 'key'), /多个上游任务/)
  route = async () => new Response('offline', { status: 503 })
  await assert.rejects(reconcileComfySubmission(config, 'key'), /HTTP 503/)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})

test('a lost submission response reconciles the accepted request with exactly one POST', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0])), key = params(id).requestKey
  route = async url => {
    if (url.pathname === '/prompt') throw new Error('socket closed after acceptance')
    if (url.pathname === '/queue') return Response.json({ queue_pending: [[0, 'upstream', {}, { huobao_request_key: key }]], queue_running: [] })
    if (url.pathname === '/history') return Response.json({})
    if (url.pathname === '/history/upstream') return Response.json(history())
    throw new Error(`Unexpected request ${url}`)
  }
  await runVideoTask(id, claim(id), io())
  assert.equal(calls.filter(call => call.url.pathname === '/prompt').length, 1)
  assert.equal(task(id).taskId, 'upstream')
  assert.equal(task(id).status, 'completed')
})

for (const phase of ['polling', 'downloading'] as const) {
  test(`retry of a known upstream ${phase} failure resumes the original task and artifact UUID`, async () => {
    const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0])), token = claim(id)
    const before = params(id)
    queue.updateLeasedVideo(id, token, { taskId: 'upstream', phase, ...(phase === 'downloading' ? { resultUrl: 'http://queue.test/view?filename=result.mp4' } : {}) })
    queue.finishVideoFailure(id, token, new Error('temporary I/O failure'))
    const retry = await queue.retryVideoTask(id)
    assert.equal(retry.id, id)
    assert.equal(params(id).artifactUuid, before.artifactUuid)
    assert.equal(params(id).requestKey, before.requestKey)
    assert.equal(task(id).taskId, 'upstream')
    assert.equal(task(id).phase, phase)
    calls = []
    succeed()
    await runVideoTask(id, claim(id), io())
    assert.deepEqual(calls.map(call => call.url.pathname), phase === 'polling' ? ['/history/upstream'] : [])
    assert.equal(task(id).status, 'completed')
  })
}

for (const phase of ['polling', 'downloading', 'submitting'] as const) {
  for (const sourceChange of ['deleted', 'archived'] as const) {
    test(`restart recovers an accepted ${phase} child after its source is ${sourceChange}, then archives without resubmission`, async () => {
      const f = fixture(3, ['independent', 'tail_frame', 'tail_frame'])
      const oldUrl = savedVideo(`child-main-${phase}-${sourceChange}`)
      patchShot(f.shots[1].id, { videoUrl: oldUrl })
      const batch = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
      const [parent, child, grandchild] = batch.task_ids
      queue.publishVideoResult(parent, claim(parent), savedVideo(`source-${phase}-${sourceChange}`), 'http://queue.test/view?parent', {})
      const oldToken = claim(child), frozen = params(child)
      queue.updateLeasedVideo(child, oldToken, {
        taskId: phase === 'submitting' ? null : 'upstream', phase,
        ...(phase === 'downloading' ? { resultUrl: 'http://queue.test/view?filename=result.mp4' } : {}),
      })
      if (sourceChange === 'deleted') queue.cancelVideoTask(parent, true)
      else patchTask(parent, { phase: 'completed_stale' })
      patchTask(child, { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
      const newToken = claim(child)
      assert.notEqual(newToken, oldToken)
      route = async url => {
        if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [[0, 'upstream', {}, { huobao_request_key: frozen.requestKey }]] })
        if (url.pathname === '/history') return Response.json({})
        if (url.pathname === '/history/upstream') return Response.json(history())
        throw new Error(`Unexpected request ${url}`)
      }
      calls = []
      await runVideoTask(child, newToken, io())
      assert.equal(task(child).status, 'completed')
      assert.equal(task(child).phase, 'completed_stale')
      assert.equal(task(child).taskId, 'upstream')
      assert.ok(task(child).localPath)
      assert.equal(params(child).artifactUuid, frozen.artifactUuid)
      assert.equal(params(child).requestKey, frozen.requestKey)
      assert.equal(shot(f.shots[1].id).videoUrl, oldUrl)
      assert.equal(shot(f.shots[1].id).videoTaskId, null)
      assert.equal(shot(f.shots[1].id).pendingVideoTaskId, null)
      assert.equal(task(grandchild).status, 'blocked')
      const expected = phase === 'downloading' ? [] : phase === 'polling' ? ['/history/upstream'] : ['/queue', '/history', '/history/upstream']
      assert.deepEqual(calls.map(call => call.url.pathname).sort(), expected.sort())
      assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
    })
  }
}

test('tail-frame legacy source is probed before extraction and guide upload does not displace reference slots', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  const sourceUrl = savedVideo('legacy-tail-source')
  patchShot(f.shots[0].id, { videoUrl: sourceUrl })
  const id = await queue.enqueueSingleVideo(input(f.shots[1], { prompt: '@图片1 scene with @图片2 person', reference_image_urls: [image(1), image(2)] }))
  assert.equal(params(id).sourceVideo.legacy, true)
  const order: string[] = [], uploaded: Buffer[] = []
  let submitted: Json | undefined
  route = async (url, options) => {
    if (url.pathname === '/upload/image') {
      order.push('upload')
      const file = (options!.body as FormData).get('image') as Blob
      uploaded.push(Buffer.from(await file.arrayBuffer()))
      return Response.json({ name: `image-${uploaded.length}.png`, subfolder: 'refs', type: 'input' })
    }
    if (url.pathname === '/prompt') { order.push('submit'); submitted = JSON.parse(String(options?.body)); return Response.json({ prompt_id: 'upstream' }) }
    if (url.pathname === '/history/upstream') return Response.json(history())
    throw new Error(`Unexpected request ${url}`)
  }
  const defaults = io()
  await runVideoTask(id, claim(id), io({
    probe: async file => { if (file === params(id).sourceVideo.file) order.push('probe-source'); return defaults.probe!(file) },
    extractTail: async url => { assert.equal(url, sourceUrl); order.push('tail'); return defaults.extractTail!(url) },
  }))
  assert.deepEqual(order, ['probe-source', 'tail', 'upload', 'upload', 'upload', 'submit'])
  // Upload normalizes image encoding. Compare the distinct decoded colors, not
  // PNG container bytes, so a reference/guide reordering remains observable.
  const colors = await Promise.all(uploaded.map(async bytes => [...(await sharp(bytes).removeAlpha().raw().toBuffer()).subarray(0, 3)]))
  assert.deepEqual(colors, [[255, 0, 0], [0, 255, 0], [255, 255, 255]])
  assert.deepEqual(submitted!.prompt.root.inputs['ref_images.ref_image_0'], ['huobao_reference_1', 0])
  assert.deepEqual(submitted!.prompt.root.inputs['ref_images.ref_image_1'], ['huobao_reference_2', 0])
  const guide: any = Object.values(submitted!.prompt).find((node: any) => node.class_type === 'MiniMaxH3AddGuide')
  assert.deepEqual(guide.inputs.image, ['huobao_reference_3', 0])
  assert.equal(guide.inputs.frame_idx, 0)
  assert.equal(params(id).resolvedFirstFrameUrl, '/static/frames/tail.png')
  assert.deepEqual(params(id).referenceImageUrls, [image(1), image(2)])
})

test('unreadable or replaced legacy source fails before tail extraction and upload', async () => {
  const f = fixture(2, ['independent', 'tail_frame']), url = savedVideo('replaced-legacy')
  patchShot(f.shots[0].id, { videoUrl: url })
  const id = await queue.enqueueSingleVideo(input(f.shots[1]))
  const original = params(id).sourceVideo
  assert.equal(path.dirname(original.file), path.join(STORAGE_ROOT, 'videos'))
  fs.writeFileSync(original.file, '')
  let extracted = 0
  await assert.rejects(runVideoTask(id, claim(id), io({ extractTail: async () => { extracted++; return '/static/frames/wrong.png' } })), /为空或不可读|文件已改变/)
  assert.equal(extracted, 0)
  assert.equal(calls.some(call => ['/upload/image', '/prompt'].includes(call.url.pathname)), false)
})

test('a missing reference never shifts later slots or partially uploads tail-frame input', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  patchShot(f.shots[0].id, { videoUrl: savedVideo('tail-missing-ref') })
  const id = await queue.enqueueSingleVideo(input(f.shots[1], { prompt: '@图片1 scene @图片2 person', reference_image_urls: ['/static/frames/does-not-exist.png', image(2)] }))
  await assert.rejects(runVideoTask(id, claim(id), io()), /第 1 张参考图读取失败/)
  assert.deepEqual(params(id).referenceImageUrls, ['/static/frames/does-not-exist.png', image(2)])
  assert.equal(calls.some(call => ['/upload/image', '/prompt'].includes(call.url.pathname)), false)
})

test('legacy video without verified context remains usable for tail mode but motion is rejected', async () => {
  const f = fixture(2, ['independent', 'motion_context'])
  patchShot(f.shots[0].id, { videoUrl: savedVideo('legacy-no-latent') })
  await assert.rejects(queue.enqueueSingleVideo(input(f.shots[1])), /旧视频没有可验证/)
  assert.equal(db.select().from(schema.sysTask).all().length, 0)
  patchShot(f.shots[1].id, { continuityPlan: plan('tail_frame', f.shots[0].id) })
  const id = await queue.enqueueSingleVideo(input(f.shots[1]))
  assert.equal(params(id).sourceVideo.legacy, true)
  assert.equal(params(id).continuitySourceArtifact, undefined)
})

test('broken optional H3 context keeps the completed video playable and blocks motion continuation', async () => {
  const f = fixture(2, ['independent', 'motion_context'])
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
  const [parent, child] = result.task_ids
  succeed()
  await runVideoTask(parent, claim(parent), io({ inspectContext: async () => { throw new Error('bad safetensors shape') } }))
  assert.equal(task(parent).status, 'completed')
  assert.equal(shot(f.shots[0].id).videoTaskId, parent)
  assert.equal(jsonRecord(task(parent).artifacts).context_error, 'bad safetensors shape')
  calls = []
  const token = claim(child)
  let failure: unknown
  try { await runVideoTask(child, token, io()) } catch (error) { failure = error }
  assert.match(String(failure), /上下文缺失或校验失败/)
  queue.finishVideoFailure(child, token, failure)
  assert.equal(task(child).status, 'failed')
  assert.equal(calls.length, 0)
})

test('motion child verifies and loads the exact newly published parent artifact', async () => {
  const f = fixture(2, ['independent', 'motion_context'])
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
  const [parent, child] = result.task_ids
  succeed()
  await runVideoTask(parent, claim(parent), io())
  const parentArtifact = jsonRecord(task(parent).artifacts).context
  assert.equal(parentArtifact.subfolder, comfyUIContextArtifact(params(parent).artifactUuid).subfolder)
  let submitted: Json | undefined
  route = async (url, options) => {
    if (url.pathname === '/view') {
      assert.equal(url.searchParams.get('filename'), parentArtifact.filename)
      assert.equal(url.searchParams.get('subfolder'), parentArtifact.subfolder)
      return contextResponse(options)
    }
    if (url.pathname === '/prompt') { submitted = JSON.parse(String(options?.body)); return Response.json({ prompt_id: 'upstream' }) }
    if (url.pathname === '/history/upstream') return Response.json(history())
    throw new Error(`Unexpected request ${url}`)
  }
  await runVideoTask(child, claim(child), io())
  const nodes = Object.values(submitted!.prompt) as any[]
  const load = nodes.find(node => node.class_type === 'MiniMaxH3MotionContextLoadLatent')
  const save = nodes.find(node => node.class_type === 'MiniMaxH3MotionContextSaveLatent')
  assert.equal(load.inputs.latent_path, `${parentArtifact.subfolder}/${parentArtifact.filename}`)
  assert.equal(save.inputs.filename_prefix, `h3_context/${params(child).artifactUuid}/clip`)
  assert.notEqual(params(child).artifactUuid, params(parent).artifactUuid)
  assert.equal(nodes.filter(node => node.class_type === 'MiniMaxH3MotionContextTrim').length, 1)
})

for (const change of ['transition', 'title', 'suggestion'] as const) {
  test(`${change}-only edits do not invalidate frozen generation despite a revision change`, async () => {
    const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0]))
    const current = shot(f.shots[0].id)
    const values: Partial<typeof schema.storyboards.$inferInsert> = { continuityRevision: current.continuityRevision + 1 }
    if (change === 'transition') values.transitionConfig = JSON.stringify({ type: 'dissolve', duration_ms: 250 })
    if (change === 'title') values.title = 'renamed for editing'
    if (change === 'suggestion') values.continuityPlan = JSON.stringify({ ...JSON.parse(current.continuityPlan!), reason: 'new editorial explanation', suggestion: { mode: 'independent', reason: 'new AI suggestion' } })
    patchShot(current.id, values)
    succeed()
    await runVideoTask(id, claim(id), io())
    assert.equal(task(id).phase, 'completed')
    assert.equal(shot(current.id).videoTaskId, id)
    assert.equal(calls.filter(call => call.url.pathname === '/prompt').length, 1)
  })
}

test('an effective continuity-state change still archives the result even without a revision bump', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0])), token = claim(id)
  queue.updateLeasedVideo(id, token, { taskId: 'upstream', phase: 'polling' })
  const current = shot(f.shots[0].id)
  patchShot(current.id, { continuityPlan: JSON.stringify({ ...JSON.parse(current.continuityPlan!), end_state: 'places the cup on the table' }) })
  succeed()
  await runVideoTask(id, token, io())
  assert.equal(task(id).phase, 'completed_stale')
  assert.equal(shot(current.id).videoTaskId, null)
  assert.equal(shot(current.id).videoUrl, null)
})

test('explicit archived source is rejected during enqueue instead of creating a doomed child', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  patchShot(f.shots[0].id, { videoUrl: savedVideo('old-main-before-archive') })
  const parent = await queue.enqueueSingleVideo(input(f.shots[0])), token = claim(parent)
  patchShot(f.shots[0].id, { videoPrompt: 'source was edited' })
  queue.publishVideoResult(parent, token, savedVideo('archived-source'), 'http://queue.test/view?archived', {})
  assert.equal(task(parent).phase, 'completed_stale')
  const count = db.select().from(schema.sysTask).all().length
  await assert.rejects(queue.enqueueSingleVideo(input(f.shots[1], { continuity_source_task_id: parent })), (error: any) => error.status === 409)
  assert.equal(db.select().from(schema.sysTask).all().length, count)
  assert.equal(shot(f.shots[1].id).pendingVideoTaskId, null)
})

test('legacy restart recovery adopts only known upstream IDs and leaves old latents unverifiable', async () => {
  const f = fixture()
  const legacyParams = { __huobaoConfig: { provider: 'comfyui', baseUrl, model } }
  const old = db.insert(schema.sysTask).values({ type: 'video', provider: 'comfyui', model, prompt: 'legacy running shot', taskId: 'upstream',
    params: JSON.stringify(legacyParams), status: 'processing', createdAt: timestamp(), updatedAt: timestamp() }).returning().get()
  const ambiguous = db.insert(schema.sysTask).values({ type: 'video', provider: 'comfyui', model, params: JSON.stringify(legacyParams),
    status: 'failed', errorMsg: '服务重启，生成任务中断，请重试', createdAt: timestamp(), updatedAt: timestamp() }).returning().get()
  const modern = await queue.enqueueSingleVideo(input(f.shots[0]))
  const currentToken = claim(modern), currentParams = params(modern)
  queue.recoverLegacyVideoTasks()
  assert.equal(task(old.id).status, 'queued')
  assert.equal(task(old.id).phase, 'polling')
  assert.equal(params(old.id).configId, f.config.id)
  assert.equal(task(ambiguous.id).status, 'blocked')
  assert.equal(task(ambiguous.id).phase, 'submission_unknown')
  assert.equal(queue.claimVideoTask(ambiguous.id), null)
  assert.equal(task(modern).workerToken, currentToken)
  assert.deepEqual(params(modern), currentParams)
  const restored = params(old.id)
  queue.recoverLegacyVideoTasks()
  assert.deepEqual(params(old.id), restored)
  calls = []
  succeed()
  let inspected = false
  await runVideoTask(old.id, claim(old.id), io({ inspectContext: async () => { inspected = true; throw new Error('legacy context must not be invented') } }))
  assert.equal(task(old.id).status, 'completed')
  assert.equal(jsonRecord(task(old.id).artifacts).context, undefined)
  assert.equal(inspected, false)
  assert.deepEqual(calls.map(call => call.url.pathname), ['/history/upstream'])
})

test('manual reconciliation stays blocked when missing and later resumes the same request on its original endpoint', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
  const [id, child] = result.task_ids, token = claim(id), original = params(id)
  queue.updateLeasedVideo(id, token, { phase: 'submitting' })
  queue.finishVideoFailure(id, token, new Error('connection lost after acceptance'))
  assert.equal(task(id).phase, 'submission_unknown')
  assert.equal(task(child).status, 'blocked')
  db.update(schema.aiServiceConfigs).set({ baseUrl: 'http://new-default.invalid' }).where(eq(schema.aiServiceConfigs.id, f.config.id)).run()
  let visible = false
  route = async url => {
    if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (url.pathname === '/history') return Response.json(visible ? history('upstream', original.requestKey) : {})
    if (url.pathname === '/history/upstream') return Response.json(history())
    throw new Error(`Unexpected request ${url}`)
  }
  calls = []
  const absent = await queue.reconcileVideoTask(id, true)
  assert.equal(absent.id, id)
  assert.equal(absent.reconciled, false)
  assert.equal(task(id).status, 'blocked')
  assert.equal(task(child).status, 'blocked')
  assert.equal(params(id).artifactUuid, original.artifactUuid)
  visible = true
  const found = await queue.reconcileVideoTask(id, true)
  assert.equal(found.id, id)
  assert.equal(found.reconciled, true)
  assert.equal(task(id).status, 'queued')
  assert.equal(task(id).phase, 'polling')
  assert.equal(task(id).taskId, 'upstream')
  assert.equal(params(id).artifactUuid, original.artifactUuid)
  assert.equal(params(id).requestKey, original.requestKey)
  assert.equal(task(child).status, 'queued')
  assert.equal(task(child).dependsOnTaskId, id)
  await runVideoTask(id, claim(id), io())
  assert.equal(task(id).status, 'completed')
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
  assert.deepEqual(calls.map(call => call.url.origin), Array(calls.length).fill(baseUrl))
})

test('deleting a parent cannot erase an already uncertain child submission', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
  const [parent, child] = result.task_ids
  queue.publishVideoResult(parent, claim(parent), savedVideo('before-unknown-child'), 'http://queue.test/view?parent', {})
  const token = claim(child), requestKey = params(child).requestKey
  queue.updateLeasedVideo(child, token, { phase: 'submitting' })
  queue.finishVideoFailure(child, token, new Error('child submission response lost'))
  assert.equal(task(child).phase, 'submission_unknown')
  queue.cancelVideoTask(parent, true)
  assert.equal(task(child).status, 'blocked')
  assert.equal(task(child).phase, 'submission_unknown', 'dependency invalidation must not erase upstream submission ambiguity')
  assert.equal(params(child).requestKey, requestKey)
  await assert.rejects(queue.retryVideoTask(child, true), (error: any) => error.status === 409)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})

test('reconciliation cannot revive a task cancelled while its upstream lookup is pending', async () => {
  const f = fixture(), id = await queue.enqueueSingleVideo(input(f.shots[0])), token = claim(id), original = params(id)
  queue.updateLeasedVideo(id, token, { phase: 'submitting' })
  queue.finishVideoFailure(id, token, new Error('submission interrupted'))
  route = async url => {
    if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (url.pathname === '/history') {
      queue.cancelVideoTask(id, true)
      return Response.json(history('upstream', original.requestKey))
    }
    throw new Error(`Unexpected request ${url}`)
  }
  await assert.rejects(queue.reconcileVideoTask(id), (error: any) => error.status === 409 || /取消|删除|改变|不存在/.test(String(error)))
  assert.equal(task(id).status, 'cancelled')
  assert.ok(task(id).deletedAt)
  assert.equal(shot(f.shots[0].id).pendingVideoTaskId, null)
  assert.equal(task(id).taskId, null)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})

test('deleting the source during tail preparation stops the unsubmitted child', async () => {
  const f = fixture(2, ['independent', 'tail_frame'])
  const result = await queue.enqueueVideoBatch({ episode_id: f.episode.id, tasks: f.shots.map(row => input(row)) })
  const [parent, child] = result.task_ids
  const sourceUrl = savedVideo('source-delete-race')
  queue.publishVideoResult(parent, claim(parent), sourceUrl, 'http://queue.test/view?source', {})
  const source = await localVideoArtifact(sourceUrl)
  const defaults = io()
  let deleted = false
  route = async (url) => {
    if (url.pathname === '/upload/image') return Response.json({ name: 'tail.png', subfolder: 'test', type: 'input' })
    if (url.pathname === '/prompt') throw new Error('BUG: child submitted after source deletion')
    if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (url.pathname === '/history') return Response.json({})
    throw new Error(`Unexpected request ${url}`)
  }
  await assert.rejects(runVideoTask(child, claim(child), io({ probe: async file => {
    if (file === source.file && !deleted) { deleted = true; queue.cancelVideoTask(parent, true) }
    return defaults.probe!(file)
  } })), /来源|取消|删除|接管/)
  assert.equal(deleted, true)
  assert.equal(calls.some(call => call.url.pathname === '/prompt'), false)
})
