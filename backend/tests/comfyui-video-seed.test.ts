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
const { comfyuiVideoAdapter, resolveComfyUIVideoSeed } = await import('../src/services/adapters/comfyui.js')
const config = { provider: 'comfyui', baseUrl: 'http://comfy.test', apiKey: '', model: 'seed-test' }

const h3 = () => ({
  '119': { class_type: 'VAELoader', inputs: { vae_name: 'video' } },
  '120': { class_type: 'VAELoader', inputs: { vae_name: 'audio' } },
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['129', 0], latent_image: ['131', 1] } },
  '126': { class_type: 'BasicGuider', inputs: { conditioning: ['131', 0] } },
  '129': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  '130': { class_type: 'CreateVideo', inputs: { fps: 24, images: ['122', 0], audio: ['121', 0] } },
  '131': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { vae: ['119', 0], ref_image_size: 'match' } },
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
  assert.equal(path.dirname(fs.realpathSync(dir)), parent)
  assert.match(path.basename(dir), /^huobao-video-seed-test-/)
  fs.rmSync(dir, { recursive: true })
})

test('parallel H3 redraws vary their noise, including null and -1, without changing the template', async (t) => {
  setWorkflow(h3())
  const original = fs.readFileSync(workflowFile, 'utf8')
  await withRandomSeeds(t, async () => {
    const records = [undefined, undefined, null, -1].map((seed, index) => ({ id: index + 1, prompt: 'same shot', seed }))
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
      const build = (id: number) => comfyuiVideoAdapter.buildGenerateRequest(config, { id, prompt: 'same shot', seed })
      const first = await build(1)
      const second = await build(2)
      assert.equal(first.body.prompt[nodeId].inputs[key], seed)
      assert.deepEqual(first.body.prompt, second.body.prompt)
      assert.equal(JSON.parse(JSON.stringify(first.body)).prompt[nodeId].inputs[key], seed)
    }
  }
})

test('Wan defaults randomize instead of reusing its template seed of zero', async (t) => {
  setWorkflow(wan())
  await withRandomSeeds(t, async () => {
    const first = await comfyuiVideoAdapter.buildGenerateRequest(config, { id: 1 })
    const second = await comfyuiVideoAdapter.buildGenerateRequest(config, { id: 2 })
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
    const request = await comfyuiVideoAdapter.buildGenerateRequest(config, { id: 1, seed })
    const expected = structuredClone(graph)
    expected['210'].inputs.seed = seed
    assert.deepEqual(request.body.prompt, expected)
  }
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, { id: 1, seed: 2 ** 50 + 1 }), /Seed \(rgthree\) 种子不能超过/)
})

test('only linked integer seed sources change, and unsupported seed links fail explicitly', async () => {
  setWorkflow({
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: ['integer', 0] } },
    integer: { class_type: 'PrimitiveInt', inputs: { value: 1 } },
    duration: { class_type: 'PrimitiveInt', inputs: { value: 12 } },
  })
  const request = await comfyuiVideoAdapter.buildGenerateRequest(config, { id: 1, seed: 99 })
  assert.equal(request.body.prompt.integer.inputs.value, 99)
  assert.equal(request.body.prompt.duration.inputs.value, 12)
  assert.deepEqual(request.body.prompt.noise.inputs.noise_seed, ['integer', 0])
  setWorkflow({ noise: { class_type: 'RandomNoise', inputs: { noise_seed: ['unsupported', 0] } } })
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, { id: 1, seed: 99 }), /无法设置 ComfyUI 节点 noise/)
})

test('invalid seeds fail before reference uploads or submission', async (t) => {
  setWorkflow(h3())
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not send') })
  for (const seed of [-2, -3, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42', true, {}, []]) {
    assert.throws(() => resolveComfyUIVideoSeed(seed as number), /ComfyUI 视频 seed 必须/)
    await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, {
      id: 1, seed: seed as number, referenceImageUrls: JSON.stringify(['https://example.test/image.png']),
    }), /ComfyUI 视频 seed 必须/)
  }
  assert.equal(network.mock.callCount(), 0)
})

test('H3 references and Motion Context keep their wiring when a new noise seed is injected', async (t) => {
  setWorkflow(h3())
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: 'ref.png', subfolder: 'huobao', type: 'input' }))
  const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lTkAAAAASUVORK5CYII='
  const build = (seed: number) => comfyuiVideoAdapter.buildGenerateRequest(config, {
    id: 4, storyboardId: 14, prompt: '@图片1 walks', referenceImageUrls: JSON.stringify([reference]),
    firstFrameUrl: reference, continuityMode: 'motion_context', continuitySourceStoryboardId: 13, seed,
  })
  // Motion Context is mutually exclusive with a first-frame guide; test each
  // supported path through the full adapter so seed wiring cannot bypass it.
  await assert.rejects(build(22), /首帧|尾帧/)
  const motion = await comfyuiVideoAdapter.buildGenerateRequest(config, {
    id: 4, storyboardId: 14, prompt: '@图片1 walks', referenceImageUrls: JSON.stringify([reference]),
    continuityMode: 'motion_context', continuitySourceStoryboardId: 13, seed: 22,
  })
  assert.equal(motion.body.prompt['129'].inputs.noise_seed, 22)
  assert.deepEqual(motion.body.prompt['125'].inputs.noise, ['129', 0])
  assert.ok(Object.values(motion.body.prompt).some((n: any) => /Load.*Latent/.test(n.class_type)))
  assert.ok(Object.values(motion.body.prompt).some((n: any) => /Save.*Latent/.test(n.class_type)))
  const next = await comfyuiVideoAdapter.buildGenerateRequest(config, {
    id: 4, storyboardId: 14, prompt: '@图片1 walks', referenceImageUrls: JSON.stringify([reference]),
    continuityMode: 'motion_context', continuitySourceStoryboardId: 13, seed: 23,
  })
  motion.body.prompt['129'].inputs.noise_seed = 23
  assert.deepEqual(next.body.prompt, motion.body.prompt)
  const guide = await comfyuiVideoAdapter.buildGenerateRequest(config, {
    id: 4, storyboardId: 14, referenceImageUrls: JSON.stringify([reference]), firstFrameUrl: reference, seed: 24,
  })
  assert.equal(guide.body.prompt['129'].inputs.noise_seed, 24)
  assert.ok(Object.values(guide.body.prompt).some((n: any) => n.class_type === 'MiniMaxH3AddGuide' && n.inputs.frame_idx === 0))
  assert.deepEqual(guide.body.prompt['125'].inputs.noise, ['129', 0])
})

test('new tasks persist the actual seed before async submission, and invalid seeds create no task', async (t) => {
  setWorkflow(h3())
  const { db, schema } = await import('../src/db/index.js')
  const { eq } = await import('drizzle-orm')
  const { generateVideo } = await import('../src/services/generation.js')
  const ts = new Date().toISOString()
  const [provider] = await db.insert(schema.aiServiceConfigs).values({
    name: 'seed-test', serviceType: 'video', provider: 'comfyui', baseUrl: config.baseUrl, apiKey: '',
    model: JSON.stringify(['seed-test']), isActive: true, createdAt: ts, updatedAt: ts,
  }).returning()
  const received = new Map<number, number>()
  const network = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://comfy.test/prompt')
    const body = JSON.parse(String(options?.body))
    const id = Number(body.client_id.replace('huobao-video-', ''))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    const seed = JSON.parse(task.params!).seed
    assert.equal(body.prompt['129'].inputs.noise_seed, seed)
    assert.ok(Number.isSafeInteger(seed) && seed >= 0)
    received.set(id, seed)
    // Terminate this mocked request without starting any real queue or poller.
    return new Response('test stopped before GPU submission', { status: 503 })
  })
  t.mock.method(console, 'error', () => {})
  await withRandomSeeds(t, async () => {
    const ids = await Promise.all([undefined, null, -1, 0, 42].map(seed => generateVideo({
      configId: provider.id, prompt: 'same shot', seed,
    })))
    // Allow the service's asynchronous preparation to finish (no network waits).
    for (let i = 0; i < 50 && received.size < ids.length; i++) await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(received.size, ids.length)
    assert.deepEqual(ids.map(id => received.get(id)), [1001, 1002, 1003, 0, 42])
    for (const id of ids) {
      const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
      const rebuilt = await comfyuiVideoAdapter.buildGenerateRequest(config, { id, seed: JSON.parse(task.params!).seed })
      assert.equal(rebuilt.body.prompt['129'].inputs.noise_seed, received.get(id))
    }
    const before = (await db.select().from(schema.sysTask)).length
    await assert.rejects(generateVideo({ configId: provider.id, prompt: 'invalid', seed: 0.5 }), /ComfyUI 视频 seed 必须/)
    assert.equal((await db.select().from(schema.sysTask)).length, before)
    assert.equal(network.mock.callCount(), ids.length)
  })
  // Finish the expected failure callbacks before the mocks and memory DB close.
  await new Promise<void>(resolve => setImmediate(resolve))
  db.$client.close()
})
