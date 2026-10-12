import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertComfyUIVideoCapabilities, comfyUIContextArtifact, comfyUIVideoOutputTrim,
  inspectComfyUIContext, verifyComfyUIContext,
  MAX_COMFYUI_CONTEXT_HEADER_BYTES, MAX_COMFYUI_CONTEXT_READ_BYTES, MAX_COMFYUI_CONTEXT_FILE_BYTES,
} from '../src/services/comfyui-artifacts.js'
import type { ComfyUIVideoCompatibility } from '../src/services/adapters/types.js'

const config = { provider: 'comfyui', baseUrl: 'http://comfy.test/', apiKey: 'secret-test-key', model: 'h3' }
const artifact = comfyUIContextArtifact('1cfa8a15-b77e-4b95-9d26-dae08f4d6721')
const compatibility: ComfyUIVideoCompatibility = {
  version: 1, model: 'h3', width: 32, height: 32, fps: 24, latentFormat: 'h3_motion_context_av_v1',
  modelSignature: 'abc', modelConfig: { vae: { class_type: 'VAELoader', inputs: { vae_name: 'video.safetensors' } } },
}
function header() {
  return {
    __metadata__: { format: 'h3_motion_context_av_v1' },
    video: { dtype: 'F32', shape: [1, 24, 7, 2, 2], data_offsets: [0, 2688] },
    audio: { dtype: 'F32', shape: [1, 32, 2, 37], data_offsets: [2688, 12160] },
  }
}
function safetensors(value: unknown = header(), payloadLength = 12160): Buffer {
  const json = Buffer.from(JSON.stringify(value))
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([prefix, json, Buffer.alloc(payloadLength)])
}
function rangeServer(bytes: Uint8Array, options: { ignoreRange?: boolean; headStatus?: number; headLength?: string; contentType?: string } = {}) {
  const calls: { url: URL; method: string; headers: Headers }[] = []
  let cancels = 0
  const fetcher = (async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method || 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ url, method, headers })
    assert.equal(headers.get('authorization'), 'Bearer secret-test-key')
    const type = options.contentType || 'application/octet-stream'
    if (method === 'HEAD') return new Response(null, {
      status: options.headStatus || 200, headers: { 'content-length': options.headLength || String(bytes.length), 'content-type': type },
    })
    const match = headers.get('range')!.match(/^bytes=(\d+)-(\d+)$/)!
    const start = Number(match[1])
    const end = Number(match[2])
    const range = bytes.slice(start, end + 1)
    if (options.ignoreRange) {
      let offset = 0
      return new Response(new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) return controller.close()
          controller.enqueue(bytes.slice(offset, offset + 64))
          offset += 64
        },
        cancel() { cancels++ },
      }), { status: 200, headers: { 'content-length': String(bytes.length), 'content-type': type } })
    }
    return new Response(range, { status: 206, headers: {
      'content-type': type, 'content-length': String(range.length), 'content-range': `bytes ${start}-${end}/${bytes.length}`,
    } })
  }) as typeof fetch
  return { fetch: fetcher, calls, cancels: () => cancels }
}

test('context inspection uses exact endpoint/path, bounded ranges, and installed AV tensor fields', async () => {
  const server = rangeServer(safetensors())
  const result = await inspectComfyUIContext(config, artifact, compatibility, server)
  assert.equal(result.verified, true)
  assert.equal(result.format, 'h3_motion_context_av_v1')
  assert.deepEqual(result.tensors.video.shape, [1, 24, 7, 2, 2])
  assert.deepEqual(result.tensors.audio.shape, [1, 32, 2, 37])
  assert.deepEqual(result.compatibility, compatibility)
  assert.notEqual(result.compatibility, compatibility)
  assert.match(result.headerSha256, /^[a-f0-9]{64}$/)
  assert.equal(server.calls.length, 3)
  assert.equal(server.calls[0].method, 'HEAD')
  assert.equal(server.calls[1].headers.get('range'), 'bytes=0-7')
  assert.equal(server.calls[2].headers.get('range'), `bytes=8-${result.headerLength + 7}`)
  for (const call of server.calls) {
    assert.equal(call.url.origin, 'http://comfy.test')
    assert.equal(call.url.pathname, '/view')
    assert.equal(call.url.searchParams.get('filename'), artifact.filename)
    assert.equal(call.url.searchParams.get('subfolder'), artifact.subfolder)
    assert.equal(call.url.searchParams.get('type'), 'output')
  }
})

test('Range-ignoring server streams only the needed prefix then is cancelled', async () => {
  const server = rangeServer(safetensors(), { ignoreRange: true })
  const result = await inspectComfyUIContext(config, artifact, compatibility, server)
  assert.equal(result.verified, true)
  assert.equal(server.cancels(), 2)
})

test('HEAD method unavailable can still verify total length from Content-Range', async () => {
  const server = rangeServer(safetensors(), { headStatus: 405 })
  assert.equal((await inspectComfyUIContext(config, artifact, compatibility, server)).verified, true)
})

test('legacy, traversal, wrong file type, or non-versioned paths fail before networking', async () => {
  const server = rangeServer(safetensors())
  for (const value of [
    { ...artifact, subfolder: 'h3_context/huobao_storyboard_10' },
    { ...artifact, subfolder: '../h3_context/file' },
    { ...artifact, filename: '../clip_00001.safetensors' },
    { ...artifact, filename: 'clip.mp4' },
    { ...artifact, type: 'input' },
  ]) await assert.rejects(inspectComfyUIContext(config, value as typeof artifact, compatibility, server), /artifact|旧任务/)
  assert.equal(server.calls.length, 0)
  for (const uuid of ['', '../../bad', '00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa']) {
    assert.throws(() => comfyUIContextArtifact(uuid), /UUID/)
  }
})

test('missing HTTP output, invalid content type and unsafe total sizes fail explicitly', async () => {
  for (const status of [404, 403, 500]) {
    const server = rangeServer(safetensors(), { headStatus: status })
    await assert.rejects(inspectComfyUIContext(config, artifact, compatibility, server), new RegExp(`HTTP ${status}`))
    assert.equal(server.calls.length, 1)
  }
  await assert.rejects(inspectComfyUIContext(config, artifact, compatibility,
    rangeServer(safetensors(), { contentType: 'text/html' })), /fileType/)
  for (const length of ['0', '-1', '2.5', 'NaN', String(MAX_COMFYUI_CONTEXT_FILE_BYTES + 1), '9007199254740992']) {
    await assert.rejects(inspectComfyUIContext(config, artifact, compatibility,
      rangeServer(safetensors(), { headLength: length })), /长度|Content-Length/)
  }
})

test('safetensors header length must be bounded little-endian uint64 before allocation', async () => {
  for (const length of [0n, 1n, BigInt(MAX_COMFYUI_CONTEXT_HEADER_BYTES + 1), 2n ** 64n - 1n, 1000n]) {
    const bytes = Buffer.alloc(64)
    bytes.writeBigUInt64LE(length)
    const server = rangeServer(bytes)
    await assert.rejects(inspectComfyUIContext(config, artifact, compatibility, server), /header length|header 长度/)
    assert.equal(server.calls.length, 2)
  }
})

test('a single oversized ignored-Range stream chunk hits the hard read cap and is cancelled', async () => {
  let cancelled = 0
  const oversized = new Uint8Array(MAX_COMFYUI_CONTEXT_READ_BYTES + 1)
  const fetcher = (async (_input, init) => init?.method === 'HEAD'
    ? new Response(null, { headers: { 'content-length': String(oversized.length) } })
    : new Response(new ReadableStream({
      start(controller) { controller.enqueue(oversized) },
      cancel() { cancelled++ },
    }), { headers: { 'content-length': String(oversized.length) } })) as typeof fetch
  await assert.rejects(inspectComfyUIContext(config, artifact, compatibility, { fetch: fetcher }), /总读取量超过硬上限/)
  assert.equal(cancelled, 1)
})

test('malformed tensors, offsets, shapes, temporal alignment and format are rejected', async () => {
  const variants: unknown[] = [null, [], { ...header(), video: undefined }, { ...header(), audio: undefined },
    { ...header(), __metadata__: { format: 'pt' } }, { ...header(), extra: header().audio }]
  for (const change of [
    (h: ReturnType<typeof header>) => { h.video.shape[1] = 23 },
    (h: ReturnType<typeof header>) => { h.audio.shape[2] = 3 },
    (h: ReturnType<typeof header>) => { h.video.shape[0] = 0 },
    (h: ReturnType<typeof header>) => { h.video.shape[2] = 6 },
    (h: ReturnType<typeof header>) => { h.audio.shape[3] = 36 },
    (h: ReturnType<typeof header>) => { h.video.data_offsets[0] = -1 },
    (h: ReturnType<typeof header>) => { h.audio.data_offsets[1]++ },
    (h: ReturnType<typeof header>) => { h.audio.data_offsets = [0, 9472] },
    (h: ReturnType<typeof header>) => { h.video.dtype = 'I32' },
    (h: ReturnType<typeof header>) => { h.video.shape[0] = Number.MAX_SAFE_INTEGER + 1 },
  ]) { const value = header(); change(value); variants.push(value) }
  for (const value of variants) await assert.rejects(inspectComfyUIContext(config, artifact, compatibility, rangeServer(safetensors(value))), /header|tensor|shape|data_offsets|format|维度/)
  await assert.rejects(inspectComfyUIContext(config, artifact, compatibility, rangeServer(safetensors(header(), 12161))), /文件长度不匹配/)
  await assert.rejects(inspectComfyUIContext(config, artifact, { ...compatibility, width: 64 }, rangeServer(safetensors())), /compatibility/)
})

test('source verification rejects old provenance and model/VAE signature mismatch before fetching', async () => {
  const server = rangeServer(safetensors())
  await assert.rejects(verifyComfyUIContext(config, artifact, compatibility, server), /旧任务 latent 不可验证/)
  const source = { ...artifact, verified: true, compatibility }
  for (const target of [{ ...compatibility, modelSignature: 'different-vae' }, { ...compatibility, fps: 25 }, { ...compatibility, model: 'different-model' }]) {
    await assert.rejects(verifyComfyUIContext(config, source, target, server), /compatibility 不匹配/)
  }
  assert.equal(server.calls.length, 0)
  assert.equal((await verifyComfyUIContext(config, source, compatibility, server)).verified, true)
})

test('invalid Range metadata, HTTP status and truncated bodies fail without reading a full file', async () => {
  const bytes = safetensors()
  for (const response of [
    () => new Response('not found', { status: 404 }),
    () => new Response(bytes.subarray(0, 8), { status: 206, headers: { 'content-range': `bytes 1-8/${bytes.length}` } }),
    () => new Response(bytes.subarray(0, 4), { status: 206, headers: { 'content-range': `bytes 0-7/${bytes.length}` } }),
    () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }),
  ]) {
    const fetcher = (async (_url, init) => init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': String(bytes.length) } }) : response()) as typeof fetch
    await assert.rejects(inspectComfyUIContext(config, artifact, compatibility, { fetch: fetcher }), /HTTP|Content-Range|截断|长度.*改变/)
  }
})

test('capability preflight fetches once and only asks for the current mode and graph', async () => {
  let requests = 0
  const graph = { latent: { class_type: 'Wan22ImageToVideoLatent', inputs: {} }, output: { class_type: 'CreateVideo', inputs: {} } }
  const fetcher = (async (input) => {
    assert.equal(String(input), 'http://comfy.test/object_info')
    requests++
    return Response.json({ Wan22ImageToVideoLatent: {}, CreateVideo: {}, LoadImage: {} })
  }) as typeof fetch
  await Promise.all([
    assertComfyUIVideoCapabilities(config, 'none', graph, { fetch: fetcher }),
    assertComfyUIVideoCapabilities(config, 'tail_frame', graph, { fetch: fetcher }),
  ])
  assert.equal(requests, 1)
  await assert.rejects(assertComfyUIVideoCapabilities(config, 'motion_context', graph, { fetch: fetcher }), /仅支持/)
  await assert.rejects(assertComfyUIVideoCapabilities(config, 'none', { ...graph, unknown: { class_type: 'UnavailableCustomNode', inputs: {} } }, { fetch: fetcher }), /UnavailableCustomNode/)
  assert.equal(requests, 1)
})

test('H3 requires save for independent shots but Load/Context/Trim only for motion; precise loader schema is required', async () => {
  const graph = { root: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} } }
  const info: Record<string, any> = { MiniMaxH3ReferenceToVideo: {}, MiniMaxH3MotionContextSaveLatent: {} }
  const fetcher = (async () => Response.json(info)) as typeof fetch
  await assertComfyUIVideoCapabilities(config, 'none', graph, { fetch: fetcher })
  await assert.rejects(assertComfyUIVideoCapabilities(config, 'motion_context', graph, { fetch: fetcher }), /MiniMaxH3MotionContextLoadLatent/)
  Object.assign(info, { MiniMaxH3MotionContext: {}, MiniMaxH3MotionContextLoadLatent: {}, MiniMaxH3MotionContextTrim: {}, CreateVideo: {} })
  await assert.rejects(assertComfyUIVideoCapabilities(config, 'motion_context', graph, { fetch: (async () => Response.json(info)) as typeof fetch }), /latent_path\/clip_index/)
  info.MiniMaxH3MotionContextLoadLatent = { input: { required: { latent_path: ['STRING'], clip_index: ['INT'] } } }
  await assertComfyUIVideoCapabilities(config, 'motion_context', graph, { fetch: (async () => Response.json(info)) as typeof fetch })
  assert.deepEqual(comfyUIVideoOutputTrim('motion_context'), {
    appliedInWorkflow: true, videoContextFrames: 22, audioContextFrames: 24,
    trimFramesSource: 'motion_context_output', exportTrimFrames: 0,
  })
})
