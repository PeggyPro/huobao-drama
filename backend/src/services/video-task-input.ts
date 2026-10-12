import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { getDramaStylePrompt } from './style-preset.js'
import { assertContinuityCapability, continuityPrompt, parseContinuityPlan, validateContinuitySource } from './continuity-contract.js'
import { ContinuityConflict } from './continuity-plans.js'
import { assertComfyUIVideoCapabilities, verifyComfyUIContext } from './comfyui-artifacts.js'
import { freezeComfyUIVideoWorkflow, resolveComfyUIVideoSeed } from './adapters/comfyui.js'
import type { AIConfig, VideoGenerationRecord } from './adapters/types.js'
import { STORAGE_ROOT } from '../utils/paths.js'

export type JsonRecord = Record<string, any>
export function jsonRecord(value: unknown): JsonRecord {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return result && typeof result === 'object' && !Array.isArray(result) ? result : {} }
  catch { return {} }
}
export function stableHash(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export const activeVideoStates = ['queued', 'processing', 'downloading']
export function blockingVideoTask(storyboardId: number) {
  return db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId), isNull(schema.sysTask.deletedAt))).all()
    .find(task => activeVideoStates.includes(task.status || '') || (task.status === 'blocked' && task.phase === 'submission_unknown'))
}
export function storyboardFingerprint(id: number): string | null {
  const shot = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
  if (!shot || shot.deletedAt) return null
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, shot.episodeId)).get()
  if (!episode || episode.deletedAt) return null
  const characters = db.select({ id: schema.characters.id, image: schema.characters.imageUrl }).from(schema.storyboardCharacters)
    .innerJoin(schema.characters, eq(schema.characters.id, schema.storyboardCharacters.characterId)).where(eq(schema.storyboardCharacters.storyboardId, id)).all().sort((a,b) => a.id-b.id)
  const props = db.select({ id: schema.props.id, image: schema.props.imageUrl }).from(schema.storyboardProps)
    .innerJoin(schema.props, eq(schema.props.id, schema.storyboardProps.propId)).where(eq(schema.storyboardProps.storyboardId, id)).all().sort((a,b) => a.id-b.id)
  const scene = shot.sceneId ? db.select().from(schema.scenes).where(eq(schema.scenes.id, shot.sceneId)).get() : null
  const plan = parseContinuityPlan(shot.continuityPlan)
  // Export transitions, human/AI provenance and suggestions do not change generation input.
  const continuity = { mode: plan.mode, relation: plan.relation, source: plan.source_storyboard_id,
    start: plan.start_state, end: plan.end_state, needsReview: plan.needs_review }
  return stableHash({ episodeId: shot.episodeId, continuity, prompt: shot.videoPrompt, description: shot.description,
    duration: shot.duration, sceneId: shot.sceneId, sceneImage: scene?.imageUrl, characters, props,
    videoConfigId: episode.videoConfigId, resolution: episode.resolution })
}

export async function localVideoArtifact(url: string) {
  if (!/^\/?static\/videos\/.+\.(mp4|webm|mov|mkv|m4v)$/i.test(url)) throw new Error('接续来源必须是已下载的本地视频')
  const root = await fs.realpath(STORAGE_ROOT)
  const file = await fs.realpath(path.resolve(root, url.replace(/^\/?static\//, '')))
  const relative = path.relative(root, file)
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('视频路径超出素材目录')
  const stat = await fs.stat(file)
  if (!stat.isFile() || !stat.size) throw new Error('来源视频文件为空或不可读')
  // A versioned storage URL plus physical file identity pins legacy videos too.
  return { url, file, size: stat.size, mtime_ms: stat.mtimeMs, identity: stableHash({ url, size: stat.size, mtime: stat.mtimeMs }) }
}

/** Shared normalization for single and batch requests, including the existing Wan wire format. */
export function normalizeVideoInput(raw: JsonRecord): JsonRecord {
  const input = jsonRecord(raw.input), parameters = jsonRecord(raw.parameters)
  const media = Array.isArray(input.media) ? input.media : []
  const mediaUrls = (type: string) => media.filter(item => item?.type === type).map(item => item.url)
  const normalized: JsonRecord = { ...raw, prompt: raw.prompt ?? input.prompt ?? '',
    reference_image_urls: raw.reference_image_urls ?? mediaUrls('reference_image'),
    reference_video_urls: raw.reference_video_urls ?? mediaUrls('reference_video'),
    reference_audio_urls: raw.reference_audio_urls ?? mediaUrls('reference_audio'),
    first_frame_url: raw.first_frame_url ?? mediaUrls('first_frame')[0], last_frame_url: raw.last_frame_url ?? mediaUrls('last_frame')[0],
    file_url: raw.file_url ?? mediaUrls('file')[0], link_url: raw.link_url ?? mediaUrls('link')[0],
  }
  for (const [key, alias] of Object.entries({ generate_audio: 'audio', duration: 'duration', aspect_ratio: 'ratio', resolution: 'resolution', seed: 'seed', prompt_extend: 'prompt_extend', watermark: 'watermark', continuity_mode: 'continuity_mode', continuity_source_storyboard_id: 'continuity_source_storyboard_id' })) normalized[key] = raw[key] ?? parameters[alias]
  const mediaTypes = ['first_frame','last_frame','reference_image','reference_video','reference_audio','file','link']
  if (media.some(item => !mediaTypes.includes(item?.type) || typeof item?.url !== 'string' || !item.url.trim())) throw new Error('input.media 中的每项都必须包含支持的 type 和非空 url')
  if (['first_frame','last_frame','file','link'].some(type => mediaUrls(type).length > 1)) throw new Error('首尾帧、file、link 最多各一项')
  for (const key of ['reference_image_urls','reference_video_urls','reference_audio_urls']) {
    if (!Array.isArray(normalized[key]) || normalized[key].some((url: unknown) => typeof url !== 'string' || !url.trim())) throw new Error(`${key} 必须为非空 URL 字符串数组`)
  }
  return normalized
}
function validateMedia(input: JsonRecord, provider: string) {
  const images = input.reference_image_urls.length, videos = input.reference_video_urls.length, audio = input.reference_audio_urls.length
  const first = !!input.first_frame_url, last = !!input.last_frame_url, file = !!input.file_url, link = !!input.link_url
  if (provider === 'aliyun') {
    if (images > 10 || videos > 5 || audio > 5) throw new Error('Wan 3.0 参考素材超限：图片≤10、视频≤5、音频≤5')
    if (last && !first) throw new Error('Wan 3.0 尾帧必须与首帧同时传入')
    if (file && link) throw new Error('Wan 3.0 file 与 link 不能同时传入')
    if ((first || last) && (images+videos+audio > 0 || file || link)) throw new Error('Wan 3.0 首尾帧不能与多媒体参考混用')
    if (images+videos+audio+Number(first)+Number(last)+Number(file)+Number(link) > 20) throw new Error('Wan 3.0 最多20个参考素材')
  } else {
    if (images > 9 || videos > 3 || audio > 3) throw new Error('参考素材超限：图片≤9、视频≤3、音频≤3')
    if (audio && !images && !videos) throw new Error('参考音频需要至少一个参考图片或视频')
  }
  if (!String(input.prompt).trim() && !(images+videos+audio) && !first && !last && !file && !link) throw new Error('视频生成需要至少一个参考素材或 prompt')
}
export interface PreparedVideo {
  storyboardId: number | null; dramaId: number | null; input: JsonRecord; params: JsonRecord; config: AIConfig;
  preview: { storyboard_id: number; storyboard_number: number; mode: string; source_storyboard_id: number | null; source_task_id: number | null; depends_on_storyboard_id: number | null; blockers: string[] }
}
export async function prepareVideoInputs(rawInputs: JsonRecord[], episodeId?: number) {
  if (!Array.isArray(rawInputs) || !rawInputs.length || rawInputs.length > 200) throw new Error('请提交1–200个视频任务')
  const selected = new Set(rawInputs.map(input => Number(input.storyboard_id)).filter(Boolean))
  if (selected.size !== rawInputs.filter(input => input.storyboard_id != null).length) throw new Error('同一批次不能重复选择分镜')
  const prepared: PreparedVideo[] = [], items: PreparedVideo['preview'][] = []
  for (const raw of rawInputs) {
    const id = Number(raw.storyboard_id) || null
    const shot = id ? db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get() : null
    const preview: PreparedVideo['preview'] = { storyboard_id: id || 0, storyboard_number: shot?.storyboardNumber || 0, mode: 'independent', source_storyboard_id: null, source_task_id: null, depends_on_storyboard_id: null, blockers: [] }
    items.push(preview)
    try {
      const input = normalizeVideoInput(raw)
      if (id && (!shot || shot.deletedAt)) throw new Error('分镜不存在或已删除')
      if (episodeId && (!shot || shot.episodeId !== episodeId)) throw new Error('批量任务必须属于指定剧集')
      const episode = shot ? db.select().from(schema.episodes).where(eq(schema.episodes.id, shot.episodeId)).get() : null
      if (shot && (!episode || episode.deletedAt)) throw new Error('剧集不存在或已删除')
      if (raw.continuity_revision != null && raw.continuity_revision !== shot?.continuityRevision) throw new ContinuityConflict('分镜已更新，请刷新后重新提交')
      const pending = shot ? blockingVideoTask(shot.id) : null
      if (pending) throw new Error(`本段已有未结束任务 #${pending.id}，请等待、核查上游或先取消`)
      const configId = input.config_id ?? episode?.videoConfigId ?? await getActiveConfigId('video')
      const config = configId ? await getConfigById(Number(configId)) : null
      const configRow = configId ? db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(configId))).get() : null
      if (!config || configRow?.serviceType !== 'video') throw new Error('所选视频模型配置不可用，请重新选择')
      config.model = input.model || config.model
      validateMedia(input, config.provider)
      const plan = parseContinuityPlan(shot?.continuityPlan)
      if (input.continuity_mode != null) {
        plan.mode = input.continuity_mode
        plan.source_storyboard_id = input.continuity_source_storyboard_id == null ? null : Number(input.continuity_source_storyboard_id)
      }
      const validatedPlan = parseContinuityPlan(plan)
      preview.mode = validatedPlan.mode; preview.source_storyboard_id = validatedPlan.source_storyboard_id
      const siblings = shot ? db.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, shot.episodeId), isNull(schema.storyboards.deletedAt))).all() : []
      if (shot) validateContinuitySource(shot, siblings, validatedPlan)
      else if (validatedPlan.mode !== 'independent') throw new Error('接续任务必须绑定当前分镜')
      assertContinuityCapability(validatedPlan.mode, config.provider, config.model)
      if (validatedPlan.mode !== 'independent' && (input.first_frame_url || input.last_frame_url)) throw new Error('自动接续不能同时指定手动首帧或尾帧')
      const source = siblings.find(row => row.id === validatedPlan.source_storyboard_id)
      const style = await getDramaStylePrompt(episode?.dramaId ?? input.drama_id ?? null)
      const params: JsonRecord = { queueVersion: 1, requestInput: input, configId: Number(configId),
        connection: { provider: config.provider, baseUrl: config.baseUrl, model: config.model, requiresAuth: !!config.apiKey },
        artifactUuid: randomUUID(), seed: config.provider === 'comfyui' ? resolveComfyUIVideoSeed(input.seed) : input.seed,
        model: config.model, prompt: [style, input.prompt, shot ? continuityPrompt(validatedPlan, source ? parseContinuityPlan(source.continuityPlan).end_state : undefined) : ''].filter(Boolean).join('\n'),
        duration: input.duration ?? shot?.duration ?? 5, aspectRatio: input.aspect_ratio, resolution: episode?.resolution || input.resolution,
        referenceMode: 'reference', imageUrl: input.image_url, firstFrameUrl: input.first_frame_url, lastFrameUrl: input.last_frame_url,
        referenceImageUrls: input.reference_image_urls, referenceVideoUrls: input.reference_video_urls, referenceAudioUrls: input.reference_audio_urls,
        referenceFileUrl: input.file_url, referenceLinkUrl: input.link_url, generateAudio: input.generate_audio === false ? 0 : 1,
        promptExtend: input.prompt_extend, watermark: input.watermark, continuityPlan: validatedPlan,
        continuityMode: validatedPlan.mode === 'motion_context' ? 'motion_context' : null,
        continuitySourceStoryboardId: validatedPlan.source_storyboard_id, storyboardRevision: shot?.continuityRevision ?? null,
        storyboardFingerprint: id ? storyboardFingerprint(id) : null,
      }
      if (config.provider === 'comfyui') {
        const frozen = freezeComfyUIVideoWorkflow(config, videoRecord(0, id, { ...params, requestKey: randomUUID() }))
        params.workflowSnapshot = frozen.workflow; params.workflowHash = frozen.hash; params.compatibility = frozen.compatibility
        await assertComfyUIVideoCapabilities(config, validatedPlan.mode, frozen.workflow)
        if (input.reference_image_urls.length || input.image_url) await assertComfyUIVideoCapabilities(config, 'reference', frozen.workflow)
        if (input.first_frame_url || input.last_frame_url) await assertComfyUIVideoCapabilities(config, 'tail_frame', frozen.workflow)
      }
      if (source) {
        if (selected.has(source.id)) preview.depends_on_storyboard_id = source.id
        else {
          const explicitId = input.continuity_source_task_id == null ? null : Number(input.continuity_source_task_id)
          const pending = source.pendingVideoTaskId ? db.select().from(schema.sysTask).where(eq(schema.sysTask.id, source.pendingVideoTaskId)).get() : null
          if (!explicitId && pending && !pending.deletedAt && activeVideoStates.includes(pending.status || '')) {
            preview.source_task_id = pending.id; params.continuitySourceTaskId = pending.id; params.waitForSourceTask = true
          } else {
            const sourceId = explicitId ?? source.videoTaskId
            const sourceTask = sourceId ? db.select().from(schema.sysTask).where(eq(schema.sysTask.id, sourceId)).get() : null
            if (sourceTask) {
              if (sourceTask.deletedAt || sourceTask.storyboardId !== source.id || sourceTask.status !== 'completed' || sourceTask.phase === 'completed_stale' || !sourceTask.localPath) throw new Error('指定来源视频版本尚未完成或不可用')
              params.sourceVideo = await localVideoArtifact(sourceTask.localPath)
              params.continuitySourceTaskId = sourceTask.id; preview.source_task_id = sourceTask.id
              if (validatedPlan.mode === 'motion_context') {
                const artifact = jsonRecord(sourceTask.artifacts).context
                if (!artifact?.verified) throw new Error('来源视频缺少已验证的 H3 动作上下文，请重新生成来源段或改选尾帧接续')
                params.continuitySourceArtifact = await verifyComfyUIContext(config, artifact, params.compatibility)
              }
            } else {
              if (explicitId) throw new Error('指定来源任务不存在')
              if (!source.videoUrl) throw new Error(`请将前段 #${source.storyboardNumber} 加入本批次，或先生成来源视频`)
              if (validatedPlan.mode === 'motion_context') throw new Error('旧视频没有可验证的动作上下文，可选择尾帧接续或重新生成来源段')
              params.sourceVideo = { ...await localVideoArtifact(source.videoUrl), legacy: true }
            }
          }
        }
      }
      prepared.push({ storyboardId: id, dramaId: episode?.dramaId ?? input.drama_id ?? null, input, params, config, preview })
    } catch (error) { preview.blockers.push(error instanceof Error ? error.message : String(error)) }
  }
  return { items, blockers: items.flatMap(item => item.blockers.map(message => `分镜 ${item.storyboard_number || item.storyboard_id}：${message}`)), prepared }
}
export function videoRecord(id: number, storyboardId: number | null, params: JsonRecord): VideoGenerationRecord {
  return { ...params, id, storyboardId,
    // Tail-frame provenance belongs to the queue; the adapter consumes its first-frame image.
    continuitySourceStoryboardId: params.continuityMode === 'motion_context' ? params.continuitySourceStoryboardId : null,
    continuitySourceArtifact: params.continuityMode === 'motion_context' ? params.continuitySourceArtifact : null,
    referenceImageUrls: JSON.stringify(params.referenceImageUrls || []),
    referenceVideoUrls: JSON.stringify(params.referenceVideoUrls || []), referenceAudioUrls: JSON.stringify(params.referenceAudioUrls || []) }
}

/** Reload credentials only from the original endpoint; a new default provider cannot redirect a persisted job. */
export async function frozenVideoConfig(params: JsonRecord): Promise<AIConfig> {
  const frozen = params.connection || params.__huobaoConfig
  if (!frozen?.baseUrl || !frozen.provider) throw new Error('任务缺少原始模型连接，不能安全恢复')
  const current = params.configId ? await getConfigById(params.configId) : null
  if (current && current.provider === frozen.provider && current.baseUrl.replace(/\/+$/, '') === frozen.baseUrl.replace(/\/+$/, '')) return { ...current, ...frozen, model: params.model || frozen.model }
  if (frozen.provider === 'comfyui' && frozen.requiresAuth === false) return { ...frozen, apiKey: '', model: params.model || frozen.model }
  throw new Error('原任务连接或凭据已改变，请恢复原配置后重试；任务不会切换到新的默认模型')
}
