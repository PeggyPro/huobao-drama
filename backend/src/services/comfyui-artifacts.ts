import { createHash } from 'node:crypto'
import type { AIConfig, ComfyUIContextArtifact, ComfyUIVideoCompatibility } from './adapters/types.js'

export const COMFYUI_CONTEXT_FORMAT = 'h3_motion_context_av_v1' as const
export const MAX_COMFYUI_CONTEXT_HEADER_BYTES = 1024 * 1024
export const MAX_COMFYUI_CONTEXT_FILE_BYTES = 2 * 1024 * 1024 * 1024
// Includes both ranges and an oversized streaming chunk, even if Range is ignored.
export const MAX_COMFYUI_CONTEXT_READ_BYTES = 2 * MAX_COMFYUI_CONTEXT_HEADER_BYTES + 64 * 1024 + 16
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type FetchOptions = { fetch?: typeof fetch }
export type ComfyUIVideoMode = 'none' | 'independent' | 'reference' | 'tail_frame' | 'motion_context'
export interface ComfyUITensorMetadata {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}
export interface VerifiedComfyUIContext extends ComfyUIContextArtifact {
  verified: true
  format: typeof COMFYUI_CONTEXT_FORMAT
  contentLength: number
  headerLength: number
  headerSha256: string
  tensors: { video: ComfyUITensorMetadata; audio: ComfyUITensorMetadata }
}

export function assertComfyUIArtifactUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('ComfyUI artifactUuid 必须为有效的 UUID，旧目录不能作为版本化产物')
}

export function comfyUIContextArtifact(artifactUuid: string): ComfyUIContextArtifact {
  assertComfyUIArtifactUuid(artifactUuid)
  return { filename: 'clip_00001.safetensors', subfolder: `h3_context/${artifactUuid.toLowerCase()}`, type: 'output' }
}

/** Only exact versioned output paths are allowed; never resolve a directory's newest file. */
export function assertComfyUIContextArtifact(artifact: unknown): asserts artifact is ComfyUIContextArtifact {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('H3 Motion Context 缺少精确的来源 artifact')
  const value = artifact as ComfyUIContextArtifact
  if (value.type !== 'output') throw new Error('H3 Motion Context artifact type 必须为 output')
  if (typeof value.filename !== 'string' || !/^[a-z0-9_.-]+\.safetensors$/i.test(value.filename) || value.filename.includes('..')) {
    throw new Error('H3 Motion Context artifact filename 必须为精确的 safetensors 文件名')
  }
  const parts = typeof value.subfolder === 'string' ? value.subfolder.split('/') : []
  if (parts.length !== 2 || parts[0] !== 'h3_context' || !UUID.test(parts[1])) {
    throw new Error('H3 Motion Context artifact subfolder 必须为 h3_context/<UUID>；旧任务 latent 不可验证')
  }
}

export function comfyUIVideoOutputTrim(mode?: string | null) {
  const motion = mode === 'motion_context'
  return {
    appliedInWorkflow: motion,
    videoContextFrames: motion ? 22 : 0,
    audioContextFrames: motion ? 24 : 0,
    // The node returns the actual count (possibly <22 for a very short source).
    trimFramesSource: motion ? 'motion_context_output' as const : null,
    exportTrimFrames: 0 as const,
  }
}

export function assertComfyUIVideoCompatibility(actual: ComfyUIVideoCompatibility, expected: ComfyUIVideoCompatibility): void {
  for (const key of ['version', 'model', 'width', 'height', 'fps', 'latentFormat', 'modelSignature'] as const) {
    if (actual?.[key] !== expected[key]) throw new Error(`H3 Motion Context compatibility 不匹配：${key}`)
  }
}

function endpoint(config: AIConfig, suffix: string): string {
  return `${config.baseUrl.replace(/\/+$/, '')}${suffix}`
}
function authHeaders(config: AIConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}
function checkContentType(response: Response): void {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (type && !['application/octet-stream', 'binary/octet-stream', 'application/safetensors', 'application/x-safetensors'].includes(type)) {
    throw new Error(`ComfyUI context fileType 无效：${type}`)
  }
}
function contentLength(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) throw new Error('ComfyUI context Content-Length 无效')
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 10 || length > MAX_COMFYUI_CONTEXT_FILE_BYTES) {
    throw new Error('ComfyUI context 文件长度无效或超过 2 GiB 上限')
  }
  return length
}

/** Read only the required prefix and cancel immediately; never buffer an entire latent. */
async function readPrefix(response: Response, needed: number, budget: { bytes: number }): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('ComfyUI context 响应没有 body')
  const output = new Uint8Array(needed)
  let offset = 0
  try {
    while (offset < needed) {
      const { done, value } = await reader.read()
      if (done) throw new Error('ComfyUI context safetensors header 被截断')
      budget.bytes += value.byteLength
      if (budget.bytes > MAX_COMFYUI_CONTEXT_READ_BYTES) throw new Error('ComfyUI context Range 总读取量超过硬上限')
      const take = Math.min(value.byteLength, needed - offset)
      output.set(value.subarray(0, take), offset)
      offset += take
    }
    return output
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

function pythonRound(value: number): number {
  const lower = Math.floor(value)
  return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value)
}

function validateHeader(header: unknown, payloadLength: number, compatibility?: ComfyUIVideoCompatibility): VerifiedComfyUIContext['tensors'] {
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('ComfyUI context safetensors header 必须为对象')
  const object = header as Record<string, any>
  if (!object.__metadata__ || typeof object.__metadata__ !== 'object' || Array.isArray(object.__metadata__)
    || object.__metadata__.format !== COMFYUI_CONTEXT_FORMAT
    || Object.values(object.__metadata__).some(value => typeof value !== 'string')) {
    throw new Error('ComfyUI context safetensors format 不是 h3_motion_context_av_v1')
  }
  if (Object.keys(object).some(key => !['__metadata__', 'video', 'audio'].includes(key))) throw new Error('ComfyUI context 包含未知 tensor')
  const byteSizes: Record<string, number> = { F16: 2, BF16: 2, F32: 4, F64: 8 }
  const tensors = {} as VerifiedComfyUIContext['tensors']
  for (const key of ['video', 'audio'] as const) {
    const tensor = object[key]
    if (!tensor || typeof tensor !== 'object' || Array.isArray(tensor)
      || !Object.hasOwn(byteSizes, tensor.dtype)
      || !Array.isArray(tensor.shape) || tensor.shape.length !== (key === 'video' ? 5 : 4)
      || tensor.shape.some((n: unknown) => typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0)) {
      throw new Error(`ComfyUI context ${key} tensor dtype/shape 无效`)
    }
    const offsets = tensor.data_offsets
    if (!Array.isArray(offsets) || offsets.length !== 2
      || offsets.some((n: unknown) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      || offsets[0] >= offsets[1] || offsets[1] > payloadLength) {
      throw new Error(`ComfyUI context ${key} data_offsets 无效或超出 Content-Length`)
    }
    const bytes = tensor.shape.reduce((size: bigint, dimension: number) => size * BigInt(dimension), BigInt(byteSizes[tensor.dtype]))
    if (bytes !== BigInt(offsets[1] - offsets[0])) throw new Error(`ComfyUI context ${key} shape 与 data_offsets 长度不匹配`)
    tensors[key] = { dtype: tensor.dtype, shape: [...tensor.shape], data_offsets: [offsets[0], offsets[1]] }
  }
  const video = tensors.video.shape
  const audio = tensors.audio.shape
  // These are the installed H3 _empty_av_latent fields, not stock latent guesses.
  if (video[1] !== 24 || video[2] < 2 || (video[2] - 2) % 5 !== 0 || video[3] % 2 || video[4] % 2
    || audio[0] !== video[0] || audio[1] !== 32 || audio[2] !== 2) {
    throw new Error('ComfyUI context video/audio H3 tensor shape 无效')
  }
  const frames = 5 + (video[2] - 2) / 5 * 17
  if (audio[3] !== pythonRound(frames * 40 / 24)) throw new Error('ComfyUI context video/audio 时间维度不匹配')
  const ordered = Object.values(tensors).sort((a, b) => a.data_offsets[0] - b.data_offsets[0])
  if (ordered[0].data_offsets[0] !== 0 || ordered[0].data_offsets[1] !== ordered[1].data_offsets[0]
    || ordered[1].data_offsets[1] !== payloadLength) throw new Error('ComfyUI context data_offsets 重叠、有空洞或文件长度不匹配')
  if (compatibility && (compatibility.latentFormat !== COMFYUI_CONTEXT_FORMAT || compatibility.fps !== 24
    || compatibility.width !== video[4] * 16 || compatibility.height !== video[3] * 16)) {
    throw new Error('ComfyUI context compatibility 与 tensor 尺寸、fps 或格式不匹配')
  }
  return tensors
}

/** Inspect a newly saved own artifact, attaching the task's frozen compatibility. */
export async function inspectComfyUIContext(
  config: AIConfig,
  artifact: ComfyUIContextArtifact,
  compatibility?: ComfyUIVideoCompatibility,
  options: FetchOptions = {},
): Promise<VerifiedComfyUIContext> {
  assertComfyUIContextArtifact(artifact)
  if (compatibility && artifact.compatibility) assertComfyUIVideoCompatibility(artifact.compatibility, compatibility)
  const expected = compatibility || artifact.compatibility
  const fetcher = options.fetch || globalThis.fetch
  const query = new URLSearchParams({ filename: artifact.filename, subfolder: artifact.subfolder, type: artifact.type })
  const address = endpoint(config, `/view?${query}`)
  const headers = authHeaders(config)
  const head = await fetcher(address, { method: 'HEAD', headers, signal: AbortSignal.timeout(15_000) })
  let length: number | undefined
  let etag: string | null = null
  try {
    if (head.status === 200) {
      checkContentType(head)
      length = contentLength(head.headers.get('content-length'))
      etag = head.headers.get('etag')
    } else if (![405, 501].includes(head.status)) throw new Error(`ComfyUI context HEAD 失败：HTTP ${head.status}`)
  } finally { await head.body?.cancel() }
  const budget = { bytes: 0 }
  const readRange = async (start: number, end: number): Promise<Uint8Array> => {
    const response = await fetcher(address, {
      method: 'GET',
      headers: { ...headers, Range: `bytes=${start}-${end}`, ...(etag && !etag.startsWith('W/') ? { 'If-Match': etag } : {}) },
      signal: AbortSignal.timeout(15_000),
    })
    let readStarted = false
    try {
      if (response.status !== 200 && response.status !== 206) throw new Error(`ComfyUI context Range GET 失败：HTTP ${response.status}`)
      checkContentType(response)
      let total: number | undefined
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
        if (!range || Number(range[1]) !== start || Number(range[2]) !== end) throw new Error('ComfyUI context Content-Range 不匹配')
        total = contentLength(range[3])
        const rangeLength = response.headers.get('content-length')
        if (rangeLength !== null && (!/^\d+$/.test(rangeLength) || Number(rangeLength) !== end - start + 1)) {
          throw new Error('ComfyUI context Range Content-Length 不匹配')
        }
      } else total = contentLength(response.headers.get('content-length'))
      if (length !== undefined && total !== undefined && length !== total) throw new Error('ComfyUI context 文件长度在验证期间改变')
      length ??= total
      if (length === undefined) throw new Error('ComfyUI context 缺少可验证的文件总长度')
      if (end >= length) throw new Error('ComfyUI context header 长度超出 Content-Length')
      const needed = response.status === 206 ? end - start + 1 : end + 1
      readStarted = true
      const prefix = await readPrefix(response, needed, budget)
      return response.status === 206 ? prefix : prefix.slice(start)
    } finally { if (!readStarted) await response.body?.cancel() }
  }
  const prefix = await readRange(0, 7)
  const headerLengthBig = new DataView(prefix.buffer, prefix.byteOffset, 8).getBigUint64(0, true)
  if (headerLengthBig < 2n || headerLengthBig > BigInt(MAX_COMFYUI_CONTEXT_HEADER_BYTES)) throw new Error('ComfyUI context safetensors header length 无效或超过 1 MiB 上限')
  const headerLength = Number(headerLengthBig)
  if (headerLength + 8 >= length!) throw new Error('ComfyUI context safetensors header 长度超出文件')
  const headerBytes = await readRange(8, 7 + headerLength)
  let header: unknown
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)) }
  catch { throw new Error('ComfyUI context safetensors header JSON 无效') }
  const tensors = validateHeader(header, length! - 8 - headerLength, expected)
  return {
    filename: artifact.filename, subfolder: artifact.subfolder, type: 'output', verified: true,
    format: COMFYUI_CONTEXT_FORMAT, contentLength: length!, headerLength,
    headerSha256: createHash('sha256').update(headerBytes).digest('hex'), tensors,
    ...(expected ? { compatibility: structuredClone(expected) } : {}),
  }
}

/** Source artifacts require recorded provenance: a header cannot identify model weights. */
export async function verifyComfyUIContext(
  config: AIConfig,
  artifact: ComfyUIContextArtifact,
  compatibility?: ComfyUIVideoCompatibility,
  options: FetchOptions = {},
): Promise<VerifiedComfyUIContext> {
  assertComfyUIContextArtifact(artifact)
  if (artifact.verified !== true || !artifact.compatibility) throw new Error('H3 Motion Context 来源缺少已验证的 compatibility；旧任务 latent 不可验证')
  if (compatibility) assertComfyUIVideoCompatibility(artifact.compatibility, compatibility)
  return inspectComfyUIContext(config, artifact, compatibility, options)
}

const objectInfoCaches = new WeakMap<typeof fetch, Map<string, { expires: number; result: Promise<Record<string, any>> }>>()
const OBJECT_INFO_TTL_MS = 30_000
async function objectInfo(config: AIConfig, options: FetchOptions): Promise<Record<string, any>> {
  const fetcher = options.fetch || globalThis.fetch
  let cache = objectInfoCaches.get(fetcher)
  if (!cache) { cache = new Map(); objectInfoCaches.set(fetcher, cache) }
  const key = `${endpoint(config, '')}:${createHash('sha256').update(config.apiKey || '').digest('hex')}`
  const previous = cache.get(key)
  if (previous && previous.expires > Date.now()) return previous.result
  const result = (async () => {
    const response = await fetcher(endpoint(config, '/object_info'), { headers: authHeaders(config), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`ComfyUI object_info 失败：HTTP ${response.status}`) }
    const info: unknown = await response.json()
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('ComfyUI object_info 响应无效')
    return info as Record<string, any>
  })()
  if (cache.size >= 64) cache.delete(cache.keys().next().value!)
  cache.set(key, { expires: Date.now() + OBJECT_INFO_TTL_MS, result })
  try { return await result } catch (error) { cache.delete(key); throw error }
}

/** One cached object_info request; require only the selected graph and mode's nodes. */
export async function assertComfyUIVideoCapabilities(
  config: AIConfig,
  mode: ComfyUIVideoMode,
  workflow?: Record<string, any>,
  options: FetchOptions = {},
): Promise<void> {
  if (!['none', 'independent', 'reference', 'tail_frame', 'motion_context'].includes(mode)) throw new Error(`不支持的 ComfyUI 接续模式：${mode}`)
  const required = new Set<string>()
  for (const node of Object.values(workflow || {})) {
    if (!node || typeof node.class_type !== 'string' || !node.class_type) throw new Error('ComfyUI workflow class_type 无效')
    required.add(node.class_type)
  }
  const h3 = required.has('MiniMaxH3ReferenceToVideo')
  if (h3) required.add('MiniMaxH3MotionContextSaveLatent')
  if (mode === 'motion_context') {
    if (workflow && !h3) throw new Error('H3 Motion Context 仅支持 ComfyUI MiniMax H3 流程')
    for (const type of ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3MotionContext', 'MiniMaxH3MotionContextLoadLatent', 'MiniMaxH3MotionContextSaveLatent', 'MiniMaxH3MotionContextTrim', 'CreateVideo']) required.add(type)
  }
  if (mode === 'tail_frame') {
    if (!workflow || (!h3 && !required.has('Wan22ImageToVideoLatent'))) throw new Error('ComfyUI tail_frame 需要 H3 或 Wan 的工作流')
    required.add('LoadImage')
    if (h3) required.add('MiniMaxH3AddGuide')
  }
  if (mode === 'reference') required.add('LoadImage')
  if (!required.size) return
  const info = await objectInfo(config, options)
  const missing = [...required].filter(type => !Object.hasOwn(info, type) || !info[type] || typeof info[type] !== 'object').sort()
  if (missing.length) throw new Error(`ComfyUI 缺少当前工作流所需节点：${missing.join(', ')}`)
  if (mode === 'motion_context') {
    const inputs = info.MiniMaxH3MotionContextLoadLatent?.input?.required
    if (!inputs?.latent_path || !inputs?.clip_index) throw new Error('ComfyUI Motion Context LoadLatent 不支持精确 latent_path/clip_index，请更新节点')
  }
}
