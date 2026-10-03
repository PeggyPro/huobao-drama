import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { STORAGE_ROOT } from '../../utils/paths.js'
import type { AIConfig, VideoGenerationRecord } from './types.js'

type Workflow = Record<string, { class_type: string; inputs: Record<string, any>; _meta?: { title?: string } }>
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

function urlList(raw: string | null | undefined, label: string): string[] {
  if (!raw) return []
  let values: unknown
  try { values = JSON.parse(raw) } catch { throw new Error(`${label}必须为图片地址数组`) }
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${label}必须为非空地址数组`)
  }
  // Preserve every position: @图片N must keep pointing at the same asset.
  return values.map(value => value.trim())
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function readReferenceImage(value: string): Promise<Buffer> {
  let bytes: Buffer
  if (/^data:image\//i.test(value)) {
    const match = value.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i)
    if (!match) throw new Error('参考图 data URL 无效，需要 base64 图片')
    if (match[1].length > MAX_IMAGE_BYTES * 4 / 3 + 4) throw new Error('参考图超过 32MB')
    bytes = Buffer.from(match[1], 'base64')
  } else if (/^\/?static\//.test(value)) {
    const root = path.resolve(STORAGE_ROOT)
    const candidate = path.resolve(root, value.replace(/^\/?static\//, ''))
    if (!withinRoot(root, candidate)) throw new Error('参考图路径超出图片存储目录')
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)])
    if (!withinRoot(realRoot, realFile)) throw new Error('参考图路径超出图片存储目录')
    if ((await fs.stat(realFile)).size > MAX_IMAGE_BYTES) throw new Error('参考图超过 32MB')
    bytes = await fs.readFile(realFile)
  } else if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`读取参考图失败：HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      await response.body?.cancel()
      throw new Error('参考图超过 32MB')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('参考图响应为空')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        size += chunk.byteLength
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel()
          throw new Error('参考图超过 32MB')
        }
        chunks.push(chunk)
      }
    } finally { reader.releaseLock() }
    bytes = Buffer.concat(chunks)
  } else {
    throw new Error('参考图地址无效，需要 static 图片路径、HTTP(S) URL 或图片 data URL')
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('参考图为空或超过 32MB')
  // Decode the actual image instead of trusting its filename/MIME. Keep detail
  // for character sheets without passing unbounded canvases to the local GPU.
  return sharp(bytes, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
}

async function uploadReference(config: AIConfig, bytes: Buffer, taskId: number, index: number): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `task-${taskId}-ref-${index + 1}-${digest}.png`)
  form.append('type', 'input')
  form.append('subfolder', 'huobao/refs')
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/upload/image`, {
    method: 'POST',
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`上传参考图到 ComfyUI 失败：HTTP ${response.status} ${await response.text()}`)
  const uploaded = await response.json() as { name?: string; subfolder?: string; type?: string }
  if (!uploaded.name || /[\\/]/.test(uploaded.name) || uploaded.type !== 'input') {
    throw new Error('ComfyUI 上传结果缺少有效的 input 图片名称')
  }
  const filename = [uploaded.subfolder, uploaded.name].filter(Boolean).join('/').replace(/\\/g, '/')
  if (filename.split('/').includes('..') || filename.startsWith('/')) throw new Error('ComfyUI 返回了无效的图片路径')
  // The server can rename collisions: use its response, never our proposed name.
  return filename
}

function uniqueNodeId(workflow: Workflow, base: string): string {
  let id = base
  while (workflow[id]) id += '_'
  return id
}

function h3ContextFolder(storyboardId: number): string {
  return `h3_context/huobao_storyboard_${storyboardId}`
}

function samplerForH3Latent(workflow: Workflow, rootId: string): string | null {
  const samplerClasses = new Set(['SamplerCustomAdvanced', 'SamplerCustom', 'KSampler', 'KSamplerAdvanced'])
  const match = Object.entries(workflow).find(([, node]) => samplerClasses.has(node.class_type)
    && Array.isArray(node.inputs.latent_image)
    && node.inputs.latent_image[0] === rootId
    && node.inputs.latent_image[1] === 1)
  return match?.[0] || null
}

function addH3MotionContextTrim(workflow: Workflow, motionId: string): void {
  const videoEntry = Object.entries(workflow).find(([, node]) => node.class_type === 'CreateVideo'
    && Array.isArray(node.inputs.images))
  if (!videoEntry) throw new Error('H3 Motion Context 找不到 CreateVideo 输出节点，无法裁掉接续头部帧')
  const [, video] = videoEntry
  const imageLink = video.inputs.images
  const audioLink = Array.isArray(video.inputs.audio) ? video.inputs.audio : null
  const trimId = uniqueNodeId(workflow, `huobao_motion_context_trim_${motionId}`)
  workflow[trimId] = {
    class_type: 'MiniMaxH3MotionContextTrim',
    inputs: {
      images: imageLink,
      trim_frames: [motionId, 1],
      ...(audioLink ? { audio: audioLink } : {}),
      fps: video.inputs.fps ?? 24,
      match_tail: true,
    },
    _meta: { title: '火宝裁掉 H3 接续头部帧' },
  }
  video.inputs.images = [trimId, 0]
  if (audioLink) video.inputs.audio = [trimId, 1]
}

function validateH3MotionContext(record: VideoGenerationRecord, hasH3: boolean): void {
  if (record.continuityMode && record.continuityMode !== 'motion_context') {
    throw new Error(`不支持的视频接续模式：${record.continuityMode}`)
  }
  if (!record.continuityMode) {
    if (record.continuitySourceStoryboardId != null) {
      throw new Error('H3 Motion Context 缺少 continuity_mode')
    }
    return
  }
  if (!hasH3) throw new Error('H3 Motion Context 仅支持 ComfyUI MiniMax H3 流程')
  if (!Number.isInteger(record.storyboardId) || (record.storyboardId as number) <= 0) {
    throw new Error('H3 Motion Context 需要有效的当前分镜 ID')
  }
  if (!Number.isInteger(record.continuitySourceStoryboardId) || (record.continuitySourceStoryboardId as number) <= 0) {
    throw new Error('H3 Motion Context 需要上一分镜 ID')
  }
  if (record.storyboardId === record.continuitySourceStoryboardId) {
    throw new Error('H3 Motion Context 的来源分镜不能与当前分镜相同')
  }
  if (record.firstFrameUrl || record.lastFrameUrl) {
    throw new Error('H3 Motion Context 不能同时指定首帧或尾帧图片；请在两种接续模式中选择一种')
  }
}

function addH3MotionContext(
  workflow: Workflow,
  rootId: string,
  root: Workflow[string],
  record: VideoGenerationRecord,
  samplerId: string,
): void {
  const storyboardId = record.storyboardId as number
  const targetFolder = h3ContextFolder(storyboardId)
  if (record.continuityMode === 'motion_context') {
    const sourceFolder = h3ContextFolder(record.continuitySourceStoryboardId as number)
    const loadId = uniqueNodeId(workflow, `huobao_motion_context_load_${rootId}`)
    workflow[loadId] = {
      class_type: 'MiniMaxH3MotionContextLoadLatent',
      inputs: { latent_path: sourceFolder, clip_index: 1 },
      _meta: { title: '火宝上一分镜 Motion Context' },
    }
    const consumers = Object.values(workflow).flatMap(consumer => Object.entries(consumer.inputs)
      .filter(([, value]) => Array.isArray(value) && value[0] === rootId && value[1] === 0)
      .map(([key]) => ({ consumer, key })))
    if (!consumers.length) throw new Error('H3 Motion Context 找不到正向条件连接')
    if (!root.inputs.vae) throw new Error('H3 Motion Context 需要视频 VAE 连接')
    const motionId = uniqueNodeId(workflow, `huobao_motion_context_${rootId}`)
    workflow[motionId] = {
      class_type: 'MiniMaxH3MotionContext',
      inputs: {
        conditioning: [rootId, 0],
        vae: root.inputs.vae,
        latent: [rootId, 1],
        context_latent: [loadId, 0],
        context_length: '22',
        audio_context_length: 24,
      },
      _meta: { title: '火宝 H3 Motion Context 续接' },
    }
    for (const { consumer, key } of consumers) consumer.inputs[key] = [motionId, 0]
    addH3MotionContextTrim(workflow, motionId)
  }
  const saveId = uniqueNodeId(workflow, `huobao_motion_context_save_${rootId}`)
  workflow[saveId] = {
    class_type: 'MiniMaxH3MotionContextSaveLatent',
    inputs: {
      latent: [samplerId, 0],
      filename_prefix: `${targetFolder}/clip`,
      clip_index: 1,
    },
    _meta: { title: '火宝保存 H3 Motion Context' },
  }
}

/** Upload references and wire real IMAGE links before /prompt is submitted. */
export async function injectComfyUIVideoReferences(
  config: AIConfig,
  record: VideoGenerationRecord,
  workflow: Workflow,
): Promise<string | null | undefined> {
  const refs = urlList(record.referenceImageUrls, '参考图片')
  const videos = urlList(record.referenceVideoUrls, '参考视频')
  const audios = urlList(record.referenceAudioUrls, '参考音频')
  if (videos.length || audios.length || record.referenceFileUrl || record.referenceLinkUrl) {
    throw new Error('当前火宝 ComfyUI 接入支持图片参考，尚未接通参考视频、音频或文件输入')
  }
  const h3Entries = Object.entries(workflow).filter(([, node]) => node.class_type === 'MiniMaxH3ReferenceToVideo')
  const h3 = h3Entries.map(([, node]) => node)
  const wan = Object.values(workflow).filter(node => node.class_type === 'Wan22ImageToVideoLatent')
  validateH3MotionContext(record, h3.length > 0)
  let sources: string[]
  let referenceCount = 0
  const guides: { url: string; frame: number }[] = []
  let prompt = record.prompt
  if (h3.length) {
    sources = refs.length ? refs : record.imageUrl ? [record.imageUrl] : []
    if (refs.length && record.imageUrl && !refs.includes(record.imageUrl)) {
      throw new Error('H3 请将所有参考图片按提示词编号放入 reference_image_urls')
    }
    if (sources.length > 9) throw new Error('H3 最多支持 9 张独立参考图片，请减少绑定素材')
    prompt = prompt?.replace(/@图片(\d+)/g, '<Picture $1>')
    for (const match of (prompt || '').matchAll(/<Picture (\d+)>/g)) {
      if (Number(match[1]) < 1 || Number(match[1]) > sources.length) {
        throw new Error(`提示词中的 ${match[0]} 没有对应参考图片，请检查素材绑定`)
      }
    }
    referenceCount = sources.length
    if (record.firstFrameUrl) guides.push({ url: record.firstFrameUrl, frame: 0 })
    if (record.lastFrameUrl) guides.push({ url: record.lastFrameUrl, frame: -1 })
    if (guides.length && h3.some(node => !node.inputs.vae)) {
      throw new Error('H3 首尾帧续接需要视频 VAE 连接')
    }
    sources = [...sources, ...guides.map(guide => guide.url)]
  } else if (wan.length) {
    if (record.lastFrameUrl) throw new Error('当前 Wan 2.2 5B 流程只支持首帧，不能指定尾帧')
    sources = [...new Set([record.firstFrameUrl, record.imageUrl, ...refs].filter((value): value is string => !!value))]
    if (sources.length > 1) {
      throw new Error(`Wan 2.2 5B 只支持一张首帧图，当前收到 ${sources.length} 张图片。请选择包含人物和场景的完整首帧，或切换到 H3 多参考图；不会忽略已绑定的图片。`)
    }
    prompt = prompt?.replace(/@图片\d+/g, '')
  } else {
    if (refs.length || record.firstFrameUrl || record.lastFrameUrl || record.imageUrl) {
      throw new Error('所选 ComfyUI 工作流没有受支持的图片输入节点，无法使用绑定参考图')
    }
    return prompt
  }
  // H3 Motion Context has no image upload on its own, but its Save/Load nodes
  // still need to be attached for storyboard tasks. Wan text-only workflows
  // must keep their graph untouched when there is no start image.
  if (!sources.length && !(h3.length && record.storyboardId)) return prompt

  // Read all inputs before uploading any: a missing asset must fail instead of
  // disappearing and shifting the remaining character/scene reference numbers.
  const images: Buffer[] = []
  for (let i = 0; i < sources.length; i++) {
    try { images.push(await readReferenceImage(sources[i])) }
    catch (error) { throw new Error(`第 ${i + 1} 张参考图读取失败：${(error as Error).message}`) }
  }
  const nodeIds: string[] = []
  for (let i = 0; i < images.length; i++) {
    let filename: string
    try { filename = await uploadReference(config, images[i], record.id, i) }
    catch (error) { throw new Error(`第 ${i + 1} 张参考图上传失败：${(error as Error).message}`) }
    let nodeId = `huobao_reference_${i + 1}`
    while (workflow[nodeId]) nodeId += '_'
    workflow[nodeId] = {
      class_type: 'LoadImage',
      inputs: { image: filename },
      _meta: { title: `火宝参考图 ${i + 1}` },
    }
    nodeIds.push(nodeId)
  }
  for (const [rootId, node] of h3Entries) {
    // Remove old reference sockets when replacing them with this task's assets.
    if (referenceCount) {
      for (const key of Object.keys(node.inputs)) {
        if (key === 'ref_images' || key.startsWith('ref_images.')) delete node.inputs[key]
      }
      nodeIds.slice(0, referenceCount).forEach((id, index) => { node.inputs[`ref_images.ref_image_${index}`] = [id, 0] })
    }
    // Anchor first/last frames on the target timeline while retaining the
    // independent character/scene references and the original audio/video latent.
    const consumers = Object.values(workflow).flatMap(consumer => Object.entries(consumer.inputs)
      .filter(([, value]) => Array.isArray(value) && value[0] === rootId && value[1] === 0)
      .map(([key]) => ({ consumer, key })))
    let positiveId = rootId
    for (let i = 0; i < guides.length; i++) {
      let guideId = `huobao_guide_${rootId}_${i}`
      while (workflow[guideId]) guideId += '_'
      workflow[guideId] = {
        class_type: 'MiniMaxH3AddGuide',
        inputs: {
          positive: [positiveId, 0], latent: [rootId, 1], vae: node.inputs.vae,
          image: [nodeIds[referenceCount + i], 0], frame_idx: guides[i].frame,
        },
        _meta: { title: guides[i].frame === 0 ? '火宝首帧续接' : '火宝尾帧约束' },
      }
      positiveId = guideId
    }
    if (guides.length) for (const { consumer, key } of consumers) consumer.inputs[key] = [positiveId, 0]
    if (record.storyboardId) {
      const samplerId = samplerForH3Latent(workflow, rootId)
      if (!samplerId) {
        if (record.continuityMode === 'motion_context') {
          throw new Error('H3 Motion Context 找不到连接当前 latent 的采样器')
        }
      } else {
        addH3MotionContext(workflow, rootId, node, record, samplerId)
      }
    }
  }
  for (const node of wan) node.inputs.start_image = [nodeIds[0], 0]
  return prompt
}
