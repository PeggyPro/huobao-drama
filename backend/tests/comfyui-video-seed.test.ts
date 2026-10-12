import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test, type TestContext } from 'node:test'

const parent = fs.realpathSync(os.tmpdir())
const dir = fs.mkdtempSync(path.join(parent, 'huobao-video-seed-test-'))
const workflowFile = path.join(dir, 'video.json')
process.env.COMFYUI_VIDEO_WORKFLOW = workflowFile
process.env.STORAGE_PATH = path.join(dir, 'static')
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
process.env.HUOBAO_DATA_DIR = dir
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unmocked network is forbidden in seed tests') }
const { comfyuiVideoAdapter, resolveComfyUIVideoSeed, freezeComfyUIVideoWorkflow } = await import('../src/services/adapters/comfyui.js')
const { comfyUIContextArtifact } = await import('../src/services/comfyui-artifacts.js')
const config = { provider: 'comfyui', baseUrl: 'http://comfy.test', apiKey: '', model: 'seed-test' }
const identity = (id: number) => ({
  id, artifactUuid: `129ea245-624e-4994-ae69-${id.toString(16).padStart(12, '0')}`,
  requestKey: `seed-request-${id}`, continuitySourceArtifact: null,
})
function contextBytes(): Buffer {
  const header = Buffer.from(JSON.stringify({
    __metadata__: { format: 'h3_motion_context_av_v1' },
    video: { dtype: 'F32', shape: [1, 24, 7, 2, 2], data_offsets: [0, 2688] },
    audio: { dtype: 'F32', shape: [1, 32, 2, 37], data_offsets: [2688, 12160] },
  }))
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([prefix, header, Buffer.alloc(12160)])
}

const h3 = () => ({
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'video' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'audio' } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], latent_image: ['131', 1] } },
  '126': { class_type: 'BasicGuider', inputs: { conditioning: ['131', 0] } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  '130': { class_type: 'CreateVideo', inputs: { fps: 24, images: ['122', 0], audio: ['121', 0] } },
  '131': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { vae: ['119', 0], audio_vae: ['120', 0], width: 32, height: 32, ref_image_size: 'match' } },
  '136': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } },
})
const wan = () => ({
  '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { length: 121 } },
  '8': { class_type: 'KSampler', inputs: { seed: 0, latent_image: ['7', 0] } },
})
function setWorkflow(graph: object) {
  fs.writeFileSync(workflowFile, JSON.stringify(graph))
}
async function withRandomSeeds(t: TestContext, run: () => Promise<void>) {
  let nextSeed = 1000
  const random = t.mock.method(crypto, 'randomInt', ((min: number, max: number) => {
    assert.equal(min, 0)
    assert.ok(max < 2 ** 48)
    return ++nextSeed
  }) as typeof crypto.randomInt)
  syncBuiltinESMExports()
  try { await run() }
  finally {
    random.mock.restore()
    syncBuiltinESMExports()
  }
}

after(() => {
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(fs.realpathSync(dir)), parent)
  assert.match(path.basename(dir), /^huobao-video-seed-test-/)
  fs.rmSync(dir, { recursive: true })
})

test('parallel H3 redraws vary their noise, including null and -1, without changing the template', async (t) => {
  setWorkflow(h3())
  const original = fs.readFileSync(workflowFile, 'utf8')
  await withRandomSeeds(t, async () => {
    const records = [undefined, undefined, null, -1].map((seed, index) => ({ ...identity(index + 1), prompt: 'same shot', seed }))
    const requests = await Promise.all(records.map(record => comfyuiVideoAdapter.buildGenerateRequest(config, record)))
    assert.deepEqual(requests.map(r => r.body.prompt['129'].inputs.noise_seed), [1001, 1002, 1003, 1004])
    for (const request of requests) {
      const graph = request.body.prompt
      assert.deepEqual(graph['125'].inputs.noise, ['129', 0])
      assert.deepEqual(graph['121'].inputs.samples, ['125', 0])
      assert.deepEqual(graph['122'].inputs.samples, ['125', 0])
    }
  })
  assert.equal(fs.readFileSync(workflowFile, 'utf8'), original)
})

test('explicit seeds including zero and safe-integer boundaries are reproducible in H3 and Wan', async () => {
  for (const [graph, nodeId, key] of [[h3(), '129', 'noise_seed'], [wan(), '8', 'seed']] as const) {
    setWorkflow(graph)
    for (const seed of [0, 42, 2 ** 50, 2 ** 50 + 1, Number.MAX_SAFE_INTEGER]) {
      const build = (id: number) => comfyuiVideoAdapter.buildGenerateRequest(config, { ...identity(id), prompt: 'same shot', seed })
      const first = await build(1)
      const second = await build(2)
      assert.equal(first.body.prompt[nodeId].inputs[key], seed)
      const comparable = structuredClone(second.body.prompt)
      for (const [nodeId, node] of Object.entries(comparable) as [string, any][]) {
        if (node.class_type !== 'MiniMaxH3MotionContextSaveLatent') continue
        assert.equal(first.body.prompt[nodeId].inputs.filename_prefix, `h3_context/${identity(1).artifactUuid}/clip`)
        assert.equal(node.inputs.filename_prefix, `h3_context/${identity(2).artifactUuid}/clip`)
        node.inputs.filename_prefix = first.body.prompt[nodeId].inputs.filename_prefix
      }
      assert.deepEqual(first.body.prompt, comparable)
      assert.equal(JSON.parse(JSON.stringify(first.body)).prompt[nodeId].inputs[key], seed)
    }
  }
})

test('Wan defaults randomize instead of reusing its template seed of zero', async (t) => {
  setWorkflow(wan())
  await withRandomSeeds(t, async () => {
    const first = await comfyuiVideoAdapter.buildGenerateRequest(config, identity(1))
    const second = await comfyuiVideoAdapter.buildGenerateRequest(config, identity(2))
    assert.equal(first.body.prompt['8'].inputs.seed, 1001)
    assert.equal(second.body.prompt['8'].inputs.seed, 1002)
    assert.deepEqual(second.body.prompt['8'].inputs.latent_image, ['7', 0])
  })
})

test('shared advanced-sampler seeds retain their provider and latent links', async () => {
  const graph = {
    '210': { class_type: 'Seed (rgthree)', inputs: { seed: -1 } },
    '280': { class_type: 'KSamplerAdvanced', inputs: { noise_seed: ['210', 0], latent_image: ['latent', 0] } },
    '281': { class_type: 'KSamplerAdvanced', inputs: { noise_seed: ['210', 0], latent_image: ['280', 0] } },
    other: { class_type: 'CustomNode', inputs: { seed: 19 } },
    dimension: { class_type: 'PrimitiveInt', inputs: { value: 832 } },
  }
  setWorkflow(graph)
  for (const seed of [0, 42, 2 ** 50]) {
    const request = await comfyuiVideoAdapter.buildGenerateRequest(config, { ...identity(1), seed })
    const expected = structuredClone(graph)
    expected['210'].inputs.seed = seed
    assert.deepEqual(request.body.prompt, expected)
  }
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, { ...identity(1), seed: 2 ** 50 + 1 }), /Seed \(rgthree\) 种子不能超过/)
})

test('only linked integer seed sources change, and unsupported seed links fail explicitly', async () => {
  setWorkflow({
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: ['integer', 0] } },
    integer: { class_type: 'PrimitiveInt', inputs: { value: 1 } },
    duration: { class_type: 'PrimitiveInt', inputs: { value: 12 } },
  })
  const request = await comfyuiVideoAdapter.buildGenerateRequest(config, { ...identity(1), seed: 99 })
  assert.equal(request.body.prompt.integer.inputs.value, 99)
  assert.equal(request.body.prompt.duration.inputs.value, 12)
  assert.deepEqual(request.body.prompt.noise.inputs.noise_seed, ['integer', 0])
  setWorkflow({ noise: { class_type: 'RandomNoise', inputs: { noise_seed: ['unsupported', 0] } } })
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, { ...identity(1), seed: 99 }), /无法设置 ComfyUI 节点 noise/)
})

test('invalid seeds fail before reference uploads or submission', async (t) => {
  setWorkflow(h3())
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not send') })
  for (const seed of [-2, -3, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42', true, {}, []]) {
    assert.throws(() => resolveComfyUIVideoSeed(seed as number), /ComfyUI 视频 seed 必须/)
    await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, {
      ...identity(1), seed: seed as number, referenceImageUrls: JSON.stringify(['https://example.test/image.png']),
    }), /ComfyUI 视频 seed 必须/)
  }
  assert.equal(network.mock.callCount(), 0)
})

test('H3 references and Motion Context keep their wiring when a new noise seed is injected', async (t) => {
  setWorkflow(h3())
  const frozen = freezeComfyUIVideoWorkflow(config, { ...identity(4), seed: 22 })
  const sourceArtifact = { ...comfyUIContextArtifact(identity(3).artifactUuid), verified: true, compatibility: frozen.compatibility }
  const bytes = contextBytes()
  let contextRequests = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/view') {
      contextRequests++
      assert.equal(url.searchParams.get('filename'), sourceArtifact.filename)
      assert.equal(url.searchParams.get('subfolder'), sourceArtifact.subfolder)
      assert.equal(url.searchParams.get('type'), 'output')
      if (options?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes.length) } })
      const range = new Headers(options?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!
      const start = Number(range[1]); const end = Number(range[2])
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } })
    }
    assert.equal(url.pathname, '/upload/image')
    return Response.json({ name: 'ref.png', subfolder: 'huobao', type: 'input' })
  })
  const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lTkAAAAASUVORK5CYII='
  const build = (seed: number) => comfyuiVideoAdapter.buildGenerateRequest(config, {
    ...identity(4), storyboardId: 14, prompt: '@图片1 walks', referenceImageUrls: JSON.stringify([reference]),
    firstFrameUrl: reference, continuityMode: 'motion_context', continuitySourceStoryboardId: 13, continuitySourceArtifact: sourceArtifact, seed,
  })
  // Motion Context is mutually exclusive with a first-frame guide; test each
  // supported path through the full adapter so seed wiring cannot bypass it.
  await assert.rejects(build(22), /首帧|尾帧/)
  const motion = await comfyuiVideoAdapter.buildGenerateRequest(config, {
    ...identity(4), storyboardId: 14, prompt: '@图片1 walks', referenceImageUrls: JSON.stringify([reference]),
    continuityMode: 'motion_context', continuitySourceStoryboardId: 13, continuitySourceArtifact: sourceArtifact, seed: 22,
  })
  assert.equal(motion.body.prompt['129'].inputs.noise_seed, 22)
  assert.deepEqual(motion.body.prompt['125'].inputs.noise, ['129', 0])
  assert.ok(Object.values(motion.body.prompt).some((n: any) => /Load.*Latent/.test(n.class_type)))
  assert.ok(Object.values(motion.body.prompt).some((n: any) => /Save.*Latent/.test(n.class_type)))
  const next = await comfyuiVideoAdapter.buildGenerateRequest(config, {
    ...identity(4), storyboardId: 14, prompt: '@图片1 walks', referenceImageUrls: JSON.stringify([reference]),
    continuityMode: 'motion_context', continuitySourceStoryboardId: 13, continuitySourceArtifact: sourceArtifact, seed: 23,
  })
  motion.body.prompt['129'].inputs.noise_seed = 23
  assert.deepEqual(next.body.prompt, motion.body.prompt)
  const guide = await comfyuiVideoAdapter.buildGenerateRequest(config, {
    ...identity(4), storyboardId: 14, referenceImageUrls: JSON.stringify([reference]), firstFrameUrl: reference, seed: 24,
  })
  assert.equal(guide.body.prompt['129'].inputs.noise_seed, 24)
  assert.ok(Object.values(guide.body.prompt).some((n: any) => n.class_type === 'MiniMaxH3AddGuide' && n.inputs.frame_idx === 0))
  assert.deepEqual(guide.body.prompt['125'].inputs.noise, ['129', 0])
  assert.equal(contextRequests, 6)
})

test('new tasks persist the actual seed before async submission, and invalid seeds create no task', async (t) => {
  setWorkflow(h3())
  const { db, schema } = await import('../src/db/index.js')
  const { eq } = await import('drizzle-orm')
  const { generateVideo } = await import('../src/services/generation.js')
  const { claimVideoTask, finishVideoFailure, getVideoTask, stopVideoQueue } = await import('../src/services/video-queue.js')
  const { runVideoTask } = await import('../src/services/video-task-worker.js')
  const { videoRecord } = await import('../src/services/video-task-input.js')
  t.after(() => { stopVideoQueue(); db.$client.close() })
  const ts = new Date().toISOString()
  const [provider] = await db.insert(schema.aiServiceConfigs).values({
    name: 'seed-test', serviceType: 'video', provider: 'comfyui', baseUrl: config.baseUrl, apiKey: '',
    model: JSON.stringify(['seed-test']), isActive: true, createdAt: ts, updatedAt: ts,
  }).returning()
  const received = new Map<number, number>()
  let preflights = 0
  let submissions = 0
  const network = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    if (url === 'http://comfy.test/object_info') {
      preflights++
      return Response.json(Object.fromEntries([
        ...Object.values(h3()).map(node => [node.class_type, {}]), ['MiniMaxH3MotionContextSaveLatent', {}],
      ]))
    }
    assert.equal(url, 'http://comfy.test/prompt')
    submissions++
    const body = JSON.parse(String(options?.body))
    const id = Number(body.client_id.replace('huobao-video-', ''))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    const params = JSON.parse(task.params!)
    const seed = params.seed
    assert.equal(body.prompt['129'].inputs.noise_seed, seed)
    assert.equal(params.workflowSnapshot['129'].inputs.noise_seed, seed)
    assert.match(params.artifactUuid, /^[0-9a-f-]{36}$/i)
    assert.equal(body.extra_data.huobao_task_id, id)
    assert.equal(body.extra_data.huobao_request_key, params.requestKey)
    assert.ok(Number.isSafeInteger(seed) && seed >= 0)
    received.set(id, seed)
    // A definite rejection requires no polling or uncertain-submission reconciliation.
    return new Response('test rejected before GPU submission', { status: 400 })
  })
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  await withRandomSeeds(t, async () => {
    const ids = await Promise.all([undefined, null, -1, 0, 42].map(seed => generateVideo({
      configId: provider.id, prompt: 'same shot', seed,
    })))
    assert.equal(received.size, 0, 'autostart=false must not submit before controlled worker execution')
    const queued = ids.map(id => JSON.parse(getVideoTask(id)!.params!))
    assert.equal(new Set(queued.map(value => value.artifactUuid)).size, ids.length)
    assert.equal(new Set(queued.map(value => value.requestKey)).size, ids.length)
    for (const id of ids) {
      const token = claimVideoTask(id)
      assert.ok(token)
      await assert.rejects(runVideoTask(id, token, { fetch: globalThis.fetch, pollIntervalMs: 0 }), /HTTP 400/)
      assert.equal(getVideoTask(id)!.phase, 'rejected')
      finishVideoFailure(id, token, new Error('expected mocked HTTP 400'))
      assert.equal(getVideoTask(id)!.status, 'failed')
    }
    assert.equal(received.size, ids.length)
    assert.deepEqual(ids.map(id => received.get(id)), [1001, 1002, 1003, 0, 42])
    for (const id of ids) {
      const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
      const rebuilt = await comfyuiVideoAdapter.buildGenerateRequest(config, videoRecord(id, task.storyboardId, JSON.parse(task.params!)))
      assert.equal(rebuilt.body.prompt['129'].inputs.noise_seed, received.get(id))
    }
    const before = (await db.select().from(schema.sysTask)).length
    await assert.rejects(generateVideo({ configId: provider.id, prompt: 'invalid', seed: 0.5 }), /ComfyUI 视频 seed 必须/)
    assert.equal((await db.select().from(schema.sysTask)).length, before)
    assert.equal(submissions, ids.length)
    assert.equal(preflights, 1)
    assert.equal(network.mock.callCount(), submissions + preflights)
  })
  // Every worker promise settled before t.after closes the memory DB and before
  // the test restores fetch; no timer or detached callback can escape the mock.
  stopVideoQueue()
})
