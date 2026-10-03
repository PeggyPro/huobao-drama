import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'

const parent = fs.realpathSync(os.tmpdir())
const dir = fs.mkdtempSync(path.join(parent, 'huobao-ref-test-'))
process.env.STORAGE_PATH = path.join(dir, 'static')
fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'images'), { recursive: true })
const scene = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#246810' } }).png().toBuffer()
const character = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#b0c0d0' } }).png().toBuffer()
fs.writeFileSync(path.join(process.env.STORAGE_PATH, 'images', 'scene.png'), scene)
const inlineCharacter = `data:image/png;base64,${character.toString('base64')}`
const { injectComfyUIVideoReferences } = await import('../src/services/adapters/comfyui-reference.js')
const config = { provider: 'comfyui', model: 'test', apiKey: 'test-key', baseUrl: 'http://comfy.test/' }
const h3 = (): Record<string, any> => ({
  '121': { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
  '122': { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
  '130': { class_type: 'CreateVideo', inputs: { fps: 24, images: ['122', 0], audio: ['121', 0] } },
  '131': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { vae: ['119', 0], ref_image_size: 'match' } },
  '126': { class_type: 'BasicGuider', inputs: { conditioning: ['131', 0] } },
  '125': { class_type: 'SamplerCustomAdvanced', inputs: { latent_image: ['131', 1] } },
})
const wan = (): Record<string, any> => ({ '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { length: 121 } } })
after(() => {
  assert.equal(path.dirname(fs.realpathSync(dir)), parent)
  assert.match(path.basename(dir), /^huobao-ref-test-/)
  fs.rmSync(dir, { recursive: true })
})

test('H3 uploads scene then character, honors server paths, and wires separate indexed sockets', async (t) => {
  const files: Uint8Array[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'http://comfy.test/upload/image')
    assert.equal(options.method, 'POST')
    assert.equal((options.headers as any).Authorization, 'Bearer test-key')
    assert.equal((options.headers as any)['Content-Type'], undefined)
    assert.ok(options.body instanceof FormData)
    assert.equal(options.body.get('type'), 'input')
    const file = options.body.get('image') as File
    files.push(new Uint8Array(await file.arrayBuffer()))
    return Response.json({ name: `server-renamed-${files.length}.png`, subfolder: 'huobao/refs', type: 'input' })
  })
  const graph = h3()
  const prompt = await injectComfyUIVideoReferences(config, {
    id: 1, prompt: '@图片2徐牧在@图片1牛棚中醒来',
    referenceImageUrls: JSON.stringify(['static/images/scene.png', inlineCharacter]),
  }, graph)
  assert.equal(prompt, '<Picture 2>徐牧在<Picture 1>牛棚中醒来')
  assert.equal(files.length, 2)
  assert.deepEqual(await sharp(files[0]).raw().toBuffer(), await sharp(scene).raw().toBuffer())
  assert.deepEqual(await sharp(files[1]).raw().toBuffer(), await sharp(character).raw().toBuffer())
  for (let i = 0; i < 2; i++) {
    const link = graph['131'].inputs[`ref_images.ref_image_${i}`]
    assert.deepEqual(link, [`huobao_reference_${i + 1}`, 0])
    assert.equal(graph[link[0]].class_type, 'LoadImage')
    assert.equal(graph[link[0]].inputs.image, `huobao/refs/server-renamed-${i + 1}.png`)
  }
  assert.deepEqual(graph['126'].inputs.conditioning, ['131', 0])
})

test('H3 first and last frame guides retain independent reference slots and the AV latent', async (t) => {
  let uploads = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: `${++uploads}.png`, subfolder: 'refs', type: 'input' }))
  const graph = h3()
  await injectComfyUIVideoReferences(config, {
    id: 2, referenceImageUrls: JSON.stringify([inlineCharacter]), prompt: '@图片1徐牧继续起身',
    firstFrameUrl: 'static/images/scene.png', lastFrameUrl: inlineCharacter,
  }, graph)
  assert.equal(uploads, 3)
  assert.deepEqual(graph['131'].inputs['ref_images.ref_image_0'], ['huobao_reference_1', 0])
  assert.equal(graph['131'].inputs['ref_images.ref_image_1'], undefined)
  assert.deepEqual(graph.huobao_guide_131_0.inputs, {
    positive: ['131', 0], latent: ['131', 1], vae: ['119', 0], image: ['huobao_reference_2', 0], frame_idx: 0,
  })
  assert.deepEqual(graph.huobao_guide_131_1.inputs.positive, ['huobao_guide_131_0', 0])
  assert.equal(graph.huobao_guide_131_1.inputs.frame_idx, -1)
  assert.deepEqual(graph['126'].inputs.conditioning, ['huobao_guide_131_1', 0])
  assert.deepEqual(graph['125'].inputs.latent_image, ['131', 1])
})

test('Wan binds a single uploaded start frame and rejects multiple independent assets', async (t) => {
  let uploads = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: `${++uploads}.png`, subfolder: '', type: 'input' }))
  const graph = wan()
  await injectComfyUIVideoReferences(config, { id: 3, firstFrameUrl: inlineCharacter }, graph)
  assert.deepEqual(graph['7'].inputs.start_image, ['huobao_reference_1', 0])
  assert.equal(graph['7'].inputs.length, 121)
  await assert.rejects(injectComfyUIVideoReferences(config, {
    id: 4, referenceImageUrls: JSON.stringify(['static/images/scene.png', inlineCharacter]),
  }, wan()), /只支持一张首帧图/)
  await assert.rejects(injectComfyUIVideoReferences(config, { id: 4, lastFrameUrl: inlineCharacter }, wan()), /不能指定尾帧/)
  assert.equal(uploads, 1)
})

test('missing or invalid references fail before uploads instead of shifting numbered subjects', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not upload') })
  await assert.rejects(injectComfyUIVideoReferences(config, {
    id: 5, prompt: '@图片2徐牧', referenceImageUrls: JSON.stringify(['static/images/missing.png', inlineCharacter]),
  }, h3()), /第 1 张参考图读取失败/)
  await assert.rejects(injectComfyUIVideoReferences(config, {
    id: 5, referenceImageUrls: JSON.stringify([inlineCharacter, 'data:image/png;base64,bm90IGFuIGltYWdl']),
  }, h3()), /第 2 张参考图读取失败/)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('H3 rejects unmatched image numbers, excessive refs, and unsupported media', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not upload') })
  await assert.rejects(injectComfyUIVideoReferences(config, {
    id: 6, prompt: '@图片2徐牧', referenceImageUrls: JSON.stringify([inlineCharacter]),
  }, h3()), /没有对应参考图片/)
  await assert.rejects(injectComfyUIVideoReferences(config, {
    id: 6, referenceImageUrls: JSON.stringify(Array(10).fill(inlineCharacter)),
  }, h3()), /最多支持 9 张/)
  await assert.rejects(injectComfyUIVideoReferences(config, {
    id: 6, referenceVideoUrls: JSON.stringify(['http://example.test/video.mp4']),
  }, h3()), /尚未接通参考视频/)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('upload failure propagates and storage traversal cannot become a LoadImage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('full', { status: 500 }))
  await assert.rejects(injectComfyUIVideoReferences(config, { id: 7, firstFrameUrl: inlineCharacter }, wan()), /上传失败.*HTTP 500/)
  await assert.rejects(injectComfyUIVideoReferences(config, { id: 7, firstFrameUrl: 'static/../outside.png' }, wan()), /超出图片存储目录/)
})

test('remote image download does not receive the ComfyUI API key', async (t) => {
  let downloads = 0
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (url === 'https://assets.test/scene.png') {
      assert.equal(options.headers, undefined)
      downloads++
      return new Response(new Uint8Array(scene))
    }
    return Response.json({ name: 'downloaded.png', type: 'input' })
  })
  const graph = wan()
  await injectComfyUIVideoReferences(config, { id: 8, firstFrameUrl: 'https://assets.test/scene.png' }, graph)
  assert.equal(downloads, 1)
  assert.equal(graph.huobao_reference_1.inputs.image, 'downloaded.png')
})

test('text-only workflows keep working without uploading images', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not upload') })
  const graph = h3()
  const before = JSON.stringify(graph)
  assert.equal(await injectComfyUIVideoReferences(config, { id: 9, prompt: 'plain text' }, graph), 'plain text')
  assert.equal(JSON.stringify(graph), before)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('H3 first shot saves a deterministic Motion Context latent slot', async () => {
  const graph = h3()
  await injectComfyUIVideoReferences(config, {
    id: 10, storyboardId: 10, prompt: 'first shot',
  }, graph)
  const save = Object.values(graph).find(node => node.class_type === 'MiniMaxH3MotionContextSaveLatent')
  assert.ok(save)
  assert.deepEqual(save.inputs.latent, ['125', 0])
  assert.equal(save.inputs.filename_prefix, 'h3_context/huobao_storyboard_10/clip')
  assert.equal(save.inputs.clip_index, 1)
})

test('H3 Motion Context loads the source slot and rewires positive conditioning', async () => {
  const graph = h3()
  await injectComfyUIVideoReferences(config, {
    id: 11,
    storyboardId: 11,
    prompt: 'continued shot',
    continuityMode: 'motion_context',
    continuitySourceStoryboardId: 10,
  }, graph)
  const loadEntry = Object.entries(graph).find(([, node]) => node.class_type === 'MiniMaxH3MotionContextLoadLatent')
  const motionEntry = Object.entries(graph).find(([, node]) => node.class_type === 'MiniMaxH3MotionContext')
  const save = Object.values(graph).find(node => node.class_type === 'MiniMaxH3MotionContextSaveLatent')
  assert.ok(loadEntry)
  assert.ok(motionEntry)
  assert.ok(save)
  const [loadId, load] = loadEntry
  const [motionId, motion] = motionEntry
  assert.deepEqual(load.inputs, { latent_path: 'h3_context/huobao_storyboard_10', clip_index: 1 })
  assert.deepEqual(motion.inputs.conditioning, ['131', 0])
  assert.deepEqual(motion.inputs.context_latent, [loadId, 0])
  assert.deepEqual(motion.inputs.latent, ['131', 1])
  assert.equal(motion.inputs.context_length, '22')
  assert.equal(motion.inputs.audio_context_length, 24)
  assert.deepEqual(graph['126'].inputs.conditioning, [motionId, 0])
  const trim = Object.values(graph).find(node => node.class_type === 'MiniMaxH3MotionContextTrim')
  assert.ok(trim)
  assert.deepEqual(trim.inputs.images, ['122', 0])
  assert.deepEqual(trim.inputs.audio, ['121', 0])
  assert.deepEqual(trim.inputs.trim_frames, [motionId, 1])
  assert.equal(trim.inputs.fps, 24)
  assert.equal(trim.inputs.match_tail, true)
  assert.deepEqual(graph['130'].inputs.images, [Object.entries(graph).find(([, node]) => node.class_type === 'MiniMaxH3MotionContextTrim')?.[0], 0])
  assert.deepEqual(graph['130'].inputs.audio, [Object.entries(graph).find(([, node]) => node.class_type === 'MiniMaxH3MotionContextTrim')?.[0], 1])
  assert.equal(save.inputs.filename_prefix, 'h3_context/huobao_storyboard_11/clip')
})

test('H3 Motion Context rejects an invalid source and leaves Wan graphs unchanged', async () => {
  await assert.rejects(() => injectComfyUIVideoReferences(config, {
    id: 12, storyboardId: 12, prompt: 'bad', continuityMode: 'motion_context', continuitySourceStoryboardId: 12,
  }, h3()), /不能与当前分镜相同/)
  const graph = wan()
  await injectComfyUIVideoReferences(config, { id: 13, storyboardId: 13, prompt: 'wan shot' }, graph)
  assert.equal(Object.values(graph).some(node => node.class_type.startsWith('MiniMaxH3MotionContext')), false)
})
