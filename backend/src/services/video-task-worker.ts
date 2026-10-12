import { getVideoAdapter } from './adapters/registry.js'
import type { AIConfig } from './adapters/types.js'
import { downloadFile, readImageAsDataUrl } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { extractVideoLastFrame } from '../utils/video-continuity.js'
import { probeMedia } from './ffmpeg-merge-helper.js'
import { comfyUIContextArtifact, inspectComfyUIContext, verifyComfyUIContext } from './comfyui-artifacts.js'
import { frozenVideoConfig, jsonRecord, localVideoArtifact, storyboardFingerprint, videoRecord, type JsonRecord } from './video-task-input.js'
import { getVideoTask, publishVideoResult, requireVideoLease, updateLeasedVideo } from './video-queue.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

export interface VideoWorkerIO {
  fetch: typeof fetch
  download: typeof downloadFile
  probe: typeof probeMedia
  poster: typeof extractVideoPoster
  extractTail: typeof extractVideoLastFrame
  inspectContext: typeof inspectComfyUIContext
  pollIntervalMs: number
}
function headers(config: AIConfig): Record<string, string> { return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} }

/** Read queue AND history. No match is ambiguous (history may have been pruned), never permission to resubmit. */
export async function reconcileComfySubmission(config: AIConfig, requestKey: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string | null> {
  const root = config.baseUrl.replace(/\/+$/, ''), matches = new Set<string>()
  for (const endpoint of ['/queue', '/history?max_items=1000']) {
    const response = await fetchImpl(`${root}${endpoint}`, { headers: headers(config), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`无法核实 ComfyUI ${endpoint.split('?')[0]}：HTTP ${response.status}`)
    const body = jsonRecord(await response.json())
    if (endpoint === '/queue') {
      for (const row of [...(body.queue_running || []), ...(body.queue_pending || [])]) {
        if (Array.isArray(row) && row[3]?.huobao_request_key === requestKey && typeof row[1] === 'string') matches.add(row[1])
      }
    } else {
      for (const [id, entry] of Object.entries(body)) if (jsonRecord(entry).prompt?.[3]?.huobao_request_key === requestKey) matches.add(id)
    }
  }
  if (matches.size > 1) throw new Error('同一请求键对应多个上游任务，需要人工核实')
  return [...matches][0] || null
}
async function cloudImage(value: unknown): Promise<string | null> {
  const url = String(value || '').trim()
  if (!url) return null
  return /^\/?static\//.test(url) ? await readImageAsDataUrl(url.replace(/^\//, '')) : url
}
function publicMedia(value: unknown): string | null {
  const url = String(value || '').trim()
  if (!url) return null
  if (/^\/?static\//.test(url)) {
    const root = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!root) throw new Error('云端视频 API 无法读取本地媒体，请配置 PUBLIC_BASE_URL 后重试')
    return `${root}/${url.replace(/^\//, '')}`
  }
  return url
}
async function prepareSource(id: number, token: string, params: JsonRecord, config: AIConfig, io: VideoWorkerIO) {
  if (params.continuityPlan?.mode === 'independent' || !params.continuityPlan) return params
  let sourceVideo = params.sourceVideo
  if (params.continuitySourceTaskId) {
    const parent = getVideoTask(params.continuitySourceTaskId)
    if (!parent || parent.deletedAt || parent.status !== 'completed' || parent.phase === 'completed_stale' || !parent.localPath) throw new Error('指定来源任务尚未成功完成；不会使用旧版视频替代')
    if (parent.storyboardId !== params.continuitySourceStoryboardId) throw new Error('来源任务与冻结的分镜关系不匹配')
    if (sourceVideo && sourceVideo.url !== parent.localPath) throw new Error('来源任务视频路径已改变')
    sourceVideo = sourceVideo || await localVideoArtifact(parent.localPath)
    if (params.continuityMode === 'motion_context') {
      const parentConfig = jsonRecord(parent.params).connection
      if (parentConfig?.baseUrl.replace(/\/+$/, '') !== config.baseUrl.replace(/\/+$/, '') || parent.provider !== 'comfyui') throw new Error('动作上下文必须来自相同 ComfyUI 实例')
      const context = jsonRecord(parent.artifacts).context
      if (!context?.verified) throw new Error('来源段已生成视频，但动作上下文缺失或校验失败；请重试来源段，或明确改用尾帧接续')
      params.continuitySourceArtifact = await verifyComfyUIContext(config, context, params.compatibility)
    }
  }
  if (!sourceVideo?.url) throw new Error('缺少已冻结的来源视频版本')
  const physical = await localVideoArtifact(sourceVideo.url)
  if (physical.identity !== sourceVideo.identity) throw new Error('来源视频文件已改变，请重新选择来源版本')
  await io.probe(physical.file)
  params.sourceVideo = sourceVideo
  if (params.continuityPlan.mode === 'tail_frame') params.resolvedFirstFrameUrl = await io.extractTail(sourceVideo.url)
  requireVideoLease(id, token)
  updateLeasedVideo(id, token, { params: JSON.stringify(params) })
  return params
}
async function complete(id: number, token: string, params: JsonRecord, config: AIConfig, url: string, io: VideoWorkerIO) {
  updateLeasedVideo(id, token, { status: 'downloading', phase: 'downloading', resultUrl: url })
  const localPath = await io.download(url, 'videos')
  requireVideoLease(id, token)
  const physical = await localVideoArtifact(localPath)
  const media = await io.probe(physical.file)
  await io.poster(localPath)
  requireVideoLease(id, token)
  const artifacts: JsonRecord = { version: 1, video: { ...physical, media }, source_task_id: params.continuitySourceTaskId || null }
  // A playable video is still useful when its optional continuation artifact is broken.
  if (config.provider === 'comfyui' && params.compatibility?.latentFormat === 'h3_motion_context_av_v1') {
    try {
      const context = await io.inspectContext(config, comfyUIContextArtifact(params.artifactUuid), params.compatibility)
      if (media.width !== params.compatibility.width || media.height !== params.compatibility.height || Math.abs(media.fps_num/media.fps_den-params.compatibility.fps) > 0.001) throw new Error('视频实际尺寸或帧率与冻结动作上下文不一致')
      artifacts.context = context
    } catch (error) {
      artifacts.context_error = error instanceof Error ? error.message : String(error)
      logTaskWarn('VideoQueue', 'context-unavailable', { id, error: artifacts.context_error })
    }
  }
  const published = publishVideoResult(id, token, localPath, url, artifacts)
  logTaskProgress('VideoQueue', 'completed', { id, published: published.published, localPath })
}
export async function runVideoTask(id: number, token: string, overrides: Partial<VideoWorkerIO> = {}) {
  const io: VideoWorkerIO = { fetch: globalThis.fetch, download: downloadFile, probe: probeMedia, poster: extractVideoPoster,
    extractTail: extractVideoLastFrame, inspectContext: inspectComfyUIContext, pollIntervalMs: 10_000, ...overrides }
  let task = requireVideoLease(id, token)
  let params = jsonRecord(task.params)
  const config = await frozenVideoConfig(params)
  const adapter = getVideoAdapter(config.provider)
  if (task.phase === 'downloading' && task.resultUrl) return complete(id, token, params, config, task.resultUrl, io)
  let upstreamId = task.taskId
  if (!upstreamId && ['submitting','submission_unknown'].includes(task.phase || '')) {
    if (config.provider !== 'comfyui') throw new Error('上游提交结果不确定，此服务商无法按请求键查询，禁止自动重发')
    upstreamId = await reconcileComfySubmission(config, params.requestKey, io.fetch)
    if (!upstreamId) throw new Error('在上游队列和历史中未确认请求，可能尚未接收或历史已清理，禁止自动重发')
    task = updateLeasedVideo(id, token, { taskId: upstreamId, phase: 'polling' })
  }
  if (!upstreamId) {
    if (task.storyboardId && params.storyboardFingerprint !== storyboardFingerprint(task.storyboardId)) throw new Error('分镜输入已改变，请刷新后重新生成')
    updateLeasedVideo(id, token, { phase: 'preparing' })
    params = await prepareSource(id, token, params, config, io)
    const prepared: JsonRecord = { ...params, firstFrameUrl: params.resolvedFirstFrameUrl || params.firstFrameUrl }
    if (config.provider !== 'comfyui') {
      prepared.imageUrl = await cloudImage(params.imageUrl)
      prepared.firstFrameUrl = await cloudImage(prepared.firstFrameUrl)
      prepared.lastFrameUrl = await cloudImage(params.lastFrameUrl)
      // Do not remove missing positions or reorder references: @image indices are already resolved.
      prepared.referenceImageUrls = await Promise.all((params.referenceImageUrls || []).map(cloudImage))
      prepared.referenceVideoUrls = (params.referenceVideoUrls || []).map(publicMedia)
      prepared.referenceAudioUrls = (params.referenceAudioUrls || []).map(publicMedia)
      prepared.referenceFileUrl = publicMedia(params.referenceFileUrl)
    }
    const request = await adapter.buildGenerateRequest(config, videoRecord(id, task.storyboardId, prepared))
    if (params.sourceVideo?.url) {
      const sourceFile = await localVideoArtifact(params.sourceVideo.url)
      if (sourceFile.identity !== params.sourceVideo.identity) throw new Error('准备期间来源视频已改变，未提交上游')
    }
    if (params.continuitySourceTaskId) {
      const parent = getVideoTask(params.continuitySourceTaskId)
      if (!parent || parent.deletedAt || parent.status !== 'completed' || parent.phase === 'completed_stale') throw new Error('准备期间来源任务已取消、删除或失效，未提交上游')
    }
    requireVideoLease(id, token)
    if (task.storyboardId && params.storyboardFingerprint !== storyboardFingerprint(task.storyboardId)) throw new Error('准备期间分镜输入已改变，未提交上游')
    updateLeasedVideo(id, token, { phase: 'submitting' })
    try {
      const multipart = request.body instanceof FormData
      const response = await io.fetch(request.url, { method: request.method, headers: request.headers,
        body: multipart ? request.body : JSON.stringify(request.body), signal: AbortSignal.timeout(600_000) })
      requireVideoLease(id, token)
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) updateLeasedVideo(id, token, { phase: 'rejected' })
        throw new Error(`视频接口返回 HTTP ${response.status}: ${(await response.text()).slice(0,1000)}`)
      }
      const result = adapter.parseGenerateResponse(await response.json(), config)
      if (!result.isAsync && result.videoUrl) return complete(id, token, params, config, result.videoUrl, io)
      if (!result.taskId) throw new Error('上游响应缺少任务 ID，无法确认是否已接受请求')
      upstreamId = result.taskId
      updateLeasedVideo(id, token, { taskId: upstreamId, phase: 'polling' })
    } catch (error) {
      task = requireVideoLease(id, token)
      if (task.phase !== 'submitting' || config.provider !== 'comfyui') throw error
      try { upstreamId = await reconcileComfySubmission(config, params.requestKey, io.fetch) }
      catch { throw error }
      if (!upstreamId) throw error
      updateLeasedVideo(id, token, { taskId: upstreamId, phase: 'polling' })
    }
  }
  for (let attempt = 0; attempt < 720; attempt++) {
    requireVideoLease(id, token)
    if (io.pollIntervalMs) await new Promise(resolve => setTimeout(resolve, io.pollIntervalMs))
    requireVideoLease(id, token)
    try {
      const request = adapter.buildPollRequest(config, upstreamId!)
      const response = await io.fetch(request.url, { method: request.method, headers: request.headers, signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`轮询返回 HTTP ${response.status}`)
      const result = adapter.parsePollResponse(await response.json(), config)
      if (result.status === 'failed') {
        updateLeasedVideo(id, token, { phase: 'upstream_failed' })
        throw new Error(result.error || '上游生成失败')
      }
      if (result.status === 'completed' && result.videoUrl) return complete(id, token, params, config, result.videoUrl, io)
    } catch (error) {
      const latest = requireVideoLease(id, token)
      if (latest.phase !== 'polling' || attempt === 719) throw error
      logTaskWarn('VideoQueue', 'poll-retry', { id, attempt: attempt+1, error: String(error) })
    }
  }
  throw new Error('视频任务轮询超时；已保留上游任务 ID，请检查上游状态')
}
