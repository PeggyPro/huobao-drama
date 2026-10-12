import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import type { VideoGenerationRecord } from '../src/services/adapters/types.js'

const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'huobao-versioning-test-'))
const workflowFile = path.join(tempDir, 'video.json')
process.env.COMFYUI_VIDEO_WORKFLOW = workflowFile
process.env.STORAGE_PATH = path.join(tempDir, 'static')
const { comfyuiVideoAdapter, freezeComfyUIVideoWorkflow } = await import('../src/services/adapters/comfyui.js')
const { injectComfyUIVideoReferences } = await import('../src/services/adapters/comfyui-reference.js')
const { comfyUIContextArtifact } = await import('../src/services/comfyui-artifacts.js')
const config = { provider: 'comfyui', baseUrl: 'http://comfy.test', apiKey: 'secret-key', model: 'h3-test' }
const ownUuid = '9e70b984-7f70-45ef-bc09-d168aa2b54a3'
const sourceUuid = '30b01c0c-7c0f-46c6-a752-9d5d851d5ad9'
const anotherUuid = '631236e2-140e-4551-9f4c-34d54781fbc6'
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lTkAAAAASUVORK5CYII='
function h3(): Record<string, any> {
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: 'h3-int8.safetensors', weight_dtype: 'default' } },
    videoVae: { class_type: 'VAELoader', inputs: { vae_name: 'h3-video.safetensors' } },
    audioVae: { class_type: 'VAELoader', inputs: { vae_name: 'h3-audio.safetensors' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors', type: 'minimax' } },
    turbo: { class_type: 'MiniMaxH3TurboLoRA', inputs: { model: ['model', 0], lora_name: 'turbo.safetensors', strength: 1, low_vram: true } },
    root: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: ['prompt', 0], width: 32, height: 32, length: 124, clip: ['clip', 0], vae: ['videoVae', 0], audio_vae: ['audioVae', 0], ref_image_size: 'match' } },
    guider: { class_type: 'BasicGuider', inputs: { model: ['turbo', 0], conditioning: ['root', 0] } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
    sampler: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], latent_image: ['root', 1], guider: ['guider', 0] } },
    videoDecode: { class_type: 'VAEDecode', inputs: { vae: ['videoVae', 0], samples: ['sampler', 0] } },
    audioDecode: { class_type: 'VAEDecodeAudio', inputs: { vae: ['audioVae', 0], samples: ['sampler', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['videoDecode', 0], audio: ['audioDecode', 0], fps: 24 } },
    prompt: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'template' } },
    duration: { class_type: 'PrimitiveFloat', inputs: { value: 5 }, _meta: { title: 'duration' } },
  }
}
const record = (overrides: Partial<VideoGenerationRecord> = {}): VideoGenerationRecord => ({
  id: 77, artifactUuid: ownUuid, requestKey: 'request-key-77', seed: 42, continuitySourceArtifact: null, ...overrides,
})
function frozen(graph = h3(), overrides: Partial<VideoGenerationRecord> = {}) {
  fs.writeFileSync(workflowFile, JSON.stringify(graph))
  return freezeComfyUIVideoWorkflow(config, record(overrides))
}
function latent(): Buffer {
  const header = Buffer.from(JSON.stringify({
    __metadata__: { format: 'h3_motion_context_av_v1' },
    video: { dtype: 'F32', shape: [1, 24, 7, 2, 2], data_offsets: [0, 2688] },
    audio: { dtype: 'F32', shape: [1, 32, 2, 37], data_offsets: [2688, 12160] },
  }))
  const size = Buffer.alloc(8)
  size.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([size, header, Buffer.alloc(12160)])
}
const nodeEntries = (graph: Record<string, any>, type: string) => Object.entries(graph).filter(([, node]) => node.class_type === type)
after(() => {
  assert.equal(path.dirname(fs.realpathSync(tempDir)), tempParent)
  assert.match(path.basename(tempDir), /^huobao-versioning-test-/)
  fs.rmSync(tempDir, { recursive: true })
})

test('H3 saves to a unique UUID target for each task, even without a storyboard ID', async () => {
  const first = h3()
  const second = h3()
  await injectComfyUIVideoReferences(config, record(), first)
  await injectComfyUIVideoReferences(config, record({ artifactUuid: anotherUuid }), second)
  assert.equal(nodeEntries(first, 'MiniMaxH3MotionContextSaveLatent')[0][1].inputs.filename_prefix, `h3_context/${ownUuid}/clip`)
  assert.equal(nodeEntries(second, 'MiniMaxH3MotionContextSaveLatent')[0][1].inputs.filename_prefix, `h3_context/${anotherUuid}/clip`)
  assert.deepEqual(nodeEntries(first, 'MiniMaxH3MotionContextSaveLatent')[0][1].inputs.latent, ['sampler', 0])
  assert.equal(nodeEntries(first, 'MiniMaxH3MotionContextSaveLatent')[0][1].inputs.clip_index, 1)
})

test('missing/invalid UUID and request key cannot fall back to storyboard IDs', async () => {
  frozen()
  for (const artifactUuid of [undefined, '', 'huobao_storyboard_77', 'bad/../uuid']) {
    await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, record({ artifactUuid, storyboardId: 77 })), /UUID/)
    await assert.rejects(injectComfyUIVideoReferences(config, record({ artifactUuid }), h3()), /UUID/)
  }
  for (const requestKey of [undefined, '', '   ', 'with\nnewline']) {
    await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, record({ requestKey })), /requestKey/)
  }
})

test('missing source and unverified legacy context fail instead of reading storyboard directories', async () => {
  frozen()
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, record({ continuityMode: 'motion_context', continuitySourceStoryboardId: 70 })), /缺少精确的来源 artifact/)
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, record({
    continuityMode: 'motion_context', continuitySourceArtifact: comfyUIContextArtifact(sourceUuid),
  })), /旧任务 latent 不可验证/)
  await assert.rejects(injectComfyUIVideoReferences(config, record({
    continuityMode: 'motion_context', continuitySourceArtifact: { ...comfyUIContextArtifact(sourceUuid), subfolder: 'h3_context/huobao_storyboard_70' },
  }), h3()), /旧任务 latent 不可验证/)
})

test('motion references keep order; exact source path and own target stay distinct; AV trim runs once', async (t) => {
  const freeze = frozen()
  const source = { ...comfyUIContextArtifact(sourceUuid), filename: 'accepted_00001.safetensors', verified: true, compatibility: freeze.compatibility }
  const bytes = latent()
  const downloads: string[] = []
  let uploads = 0
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const address = new URL(String(input))
    if (address.pathname === '/view') {
      downloads.push(address.search)
      assert.equal(address.searchParams.get('subfolder'), source.subfolder)
      assert.equal(address.searchParams.get('filename'), source.filename)
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes.length) } })
      const match = new Headers(init?.headers).get('range')!.match(/bytes=(\d+)-(\d+)/)!
      const start = Number(match[1]); const end = Number(match[2])
      return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } })
    }
    assert.equal(address.pathname, '/upload/image')
    assert.equal(downloads.length, 3)
    return Response.json({ name: `server-${++uploads}.png`, subfolder: 'references', type: 'input' })
  })
  const request = await comfyuiVideoAdapter.buildGenerateRequest(config, record({
    workflowSnapshot: freeze.workflow, workflowHash: freeze.hash, compatibility: freeze.compatibility,
    prompt: '@图片2 turns toward @图片1', referenceImageUrls: JSON.stringify([image, image]),
    continuityMode: 'motion_context', continuitySourceArtifact: source,
  }))
  const graph = request.body.prompt
  assert.equal(uploads, 2)
  assert.equal(graph.prompt.inputs.value, '<Picture 2> turns toward <Picture 1>')
  assert.deepEqual(graph.root.inputs['ref_images.ref_image_0'], ['huobao_reference_1', 0])
  assert.deepEqual(graph.root.inputs['ref_images.ref_image_1'], ['huobao_reference_2', 0])
  assert.equal(graph.huobao_reference_1.inputs.image, 'references/server-1.png')
  assert.equal(graph.huobao_reference_2.inputs.image, 'references/server-2.png')
  const [[loadId, load]] = nodeEntries(graph, 'MiniMaxH3MotionContextLoadLatent')
  assert.deepEqual(load.inputs, { latent_path: `${source.subfolder}/${source.filename}`, clip_index: 1 })
  const [[motionId, motion]] = nodeEntries(graph, 'MiniMaxH3MotionContext')
  assert.deepEqual(motion.inputs.context_latent, [loadId, 0])
  assert.equal(motion.inputs.context_length, '22')
  assert.equal(motion.inputs.audio_context_length, 24)
  assert.deepEqual(graph.guider.inputs.conditioning, [motionId, 0])
  assert.deepEqual(graph.sampler.inputs.latent_image, ['root', 1])
  const trims = nodeEntries(graph, 'MiniMaxH3MotionContextTrim')
  assert.equal(trims.length, 1)
  const [trimId, trim] = trims[0]
  assert.deepEqual(trim.inputs.images, ['videoDecode', 0])
  assert.deepEqual(trim.inputs.audio, ['audioDecode', 0])
  assert.deepEqual(trim.inputs.trim_frames, [motionId, 1])
  assert.equal(trim.inputs.fps, 24)
  assert.equal(trim.inputs.match_tail, true)
  assert.deepEqual(graph.video.inputs.images, [trimId, 0])
  assert.deepEqual(graph.video.inputs.audio, [trimId, 1])
  assert.equal(nodeEntries(graph, 'MiniMaxH3MotionContextSaveLatent')[0][1].inputs.filename_prefix, `h3_context/${ownUuid}/clip`)
  await assert.rejects(injectComfyUIVideoReferences(config, record(), graph), /避免重复 trim/)
})

test('freeze snapshots preserve resolved seed, duration and model while the workflow file changes', async () => {
  const freeze = frozen(h3(), { seed: 123, duration: 8, prompt: 'frozen prompt' })
  assert.equal(freeze.workflow.noise.inputs.noise_seed, 123)
  assert.equal(freeze.workflow.duration.inputs.value, 8)
  assert.equal(freeze.compatibility.width, 32)
  const original = JSON.stringify(freeze.workflow)
  fs.writeFileSync(workflowFile, 'invalid JSON after enqueue')
  const buildRecord = record({ seed: 123, duration: 99, prompt: 'dynamic prompt', workflowSnapshot: freeze.workflow, workflowHash: freeze.hash, compatibility: freeze.compatibility })
  const request = await comfyuiVideoAdapter.buildGenerateRequest({ ...config, model: 'another-current-model' }, buildRecord)
  assert.equal(request.body.prompt.noise.inputs.noise_seed, 123)
  assert.equal(request.body.prompt.duration.inputs.value, 8)
  assert.equal(request.body.prompt.model.inputs.unet_name, 'h3-int8.safetensors')
  assert.equal(request.body.prompt.prompt.inputs.value, 'dynamic prompt')
  request.body.prompt.model.inputs.unet_name = 'modified return value'
  assert.equal(JSON.stringify(freeze.workflow), original)
  const rebuilt = await comfyuiVideoAdapter.buildGenerateRequest(config, buildRecord)
  assert.equal(rebuilt.body.prompt.model.inputs.unet_name, 'h3-int8.safetensors')
  assert.deepEqual(rebuilt.body.extra_data, { huobao_request_key: 'request-key-77', huobao_task_id: 77 })
  assert.equal(JSON.stringify(rebuilt.body.extra_data).includes('secret-key'), false)
  assert.equal(rebuilt.headers.Authorization, 'Bearer secret-key')
  assert.equal(rebuilt.body.client_id, 'huobao-video-77')
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, { ...buildRecord, seed: 124 }), /seed 与冻结/)
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, { ...buildRecord, workflowHash: 'tampered' }), /workflowHash/)
})

test('freeze hashes are canonical and model signatures include VAE, LoRA and loader dtype but not seed/prompt', () => {
  const base = frozen()
  const reordered = Object.fromEntries(Object.entries(h3()).reverse())
  assert.equal(frozen(reordered).hash, base.hash)
  const differentPromptAndSeed = frozen(h3(), { seed: 99, prompt: 'different' })
  assert.notEqual(differentPromptAndSeed.hash, base.hash)
  assert.equal(differentPromptAndSeed.compatibility.modelSignature, base.compatibility.modelSignature)
  for (const mutate of [
    (g: Record<string, any>) => { g.videoVae.inputs.vae_name = 'another-video-vae' },
    (g: Record<string, any>) => { g.audioVae.inputs.vae_name = 'another-audio-vae' },
    (g: Record<string, any>) => { g.model.inputs.weight_dtype = 'fp8_e4m3fn' },
    (g: Record<string, any>) => { g.turbo.inputs.strength = 0.5 },
  ]) {
    const graph = h3(); mutate(graph)
    assert.notEqual(frozen(graph).compatibility.modelSignature, base.compatibility.modelSignature)
  }
  for (const seed of [undefined, null, -1]) assert.throws(() => frozen(h3(), { seed }), /先解析并保存固定 seed/)
})

test('freeze derives real linked ResolutionSelector dimensions and Wan literals without guessing', () => {
  const graph = h3()
  graph.resolution = { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 0.5, multiple: 32 } }
  graph.root.inputs.width = ['resolution', 0]
  graph.root.inputs.height = ['resolution', 1]
  const actual = frozen(graph)
  assert.equal(actual.compatibility.width, 960)
  assert.equal(actual.compatibility.height, 544)
  const wan = {
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan.safetensors' } },
    latent: { class_type: 'Wan22ImageToVideoLatent', inputs: { width: 832, height: 480, vae: ['vae', 0], length: 121 } },
    sampler: { class_type: 'KSampler', inputs: { seed: 0 } },
    video: { class_type: 'CreateVideo', inputs: { fps: 24 } },
  }
  const wanFrozen = frozen(wan, { duration: 12 })
  assert.equal(wanFrozen.compatibility.width, 832)
  assert.equal(wanFrozen.compatibility.height, 480)
  assert.equal(wanFrozen.compatibility.latentFormat, null)
  assert.equal(wanFrozen.workflow.latent.inputs.length, 289)
  graph.root.inputs.width = ['unknown-expression', 0]
  assert.throws(() => frozen(graph), /无法.*确定实际 width/)
})

test('source model signature mismatch fails before any image upload or source fetch', async (t) => {
  const freeze = frozen()
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network') })
  await assert.rejects(comfyuiVideoAdapter.buildGenerateRequest(config, record({
    workflowSnapshot: freeze.workflow, workflowHash: freeze.hash, compatibility: freeze.compatibility,
    continuityMode: 'motion_context', referenceImageUrls: JSON.stringify([image]),
    continuitySourceArtifact: { ...comfyUIContextArtifact(sourceUuid), verified: true, compatibility: { ...freeze.compatibility, modelSignature: 'other' } },
  })), /modelSignature/)
  assert.equal(network.mock.callCount(), 0)
})

test('H3 first/last guides retain the raw AV latent without adding motion trim', async (t) => {
  let uploads = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: `guide-${++uploads}.png`, type: 'input' }))
  const graph = h3()
  await injectComfyUIVideoReferences(config, record({ firstFrameUrl: image, lastFrameUrl: image, referenceImageUrls: JSON.stringify([image]) }), graph)
  assert.equal(nodeEntries(graph, 'MiniMaxH3AddGuide').length, 2)
  assert.equal(nodeEntries(graph, 'MiniMaxH3MotionContextTrim').length, 0)
  assert.equal(nodeEntries(graph, 'MiniMaxH3MotionContextSaveLatent').length, 1)
  assert.deepEqual(graph.sampler.inputs.latent_image, ['root', 1])
  assert.deepEqual(graph.video.inputs.images, ['videoDecode', 0])
  assert.deepEqual(graph.video.inputs.audio, ['audioDecode', 0])
})
