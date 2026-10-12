/**
 * FFmpeg episode export. The v2 merge manifest freezes every selected source,
 * its measured frame timeline, and the transition at the incoming boundary.
 */
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { checkFfmpegSuite } from '../utils/ffmpeg.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import {
  assertReadableVideo,
  buildTimelineManifest,
  executeMergeManifest,
  probeMedia,
  resolveCanvas,
  toAbsoluteVideoPath,
  type MergeManifest,
  type MediaProbe,
  type TimelineSource,
  type TransitionOverride,
  type TransitionType,
} from './ffmpeg-merge-helper.js'

export type { MergeManifest, TransitionOverride, TransitionType }

export interface MergeBlocker { code: string; message: string; storyboard_id?: number }
export interface PreviewClip {
  storyboard_id: number
  storyboard_number: number
  video_task_id: number | null
  url: string | null
  duration_ms: number | null
  fps: string | null
  width: number | null
  height: number | null
  has_audio: boolean | null
  offset_ms: number | null
}
export interface MergePreflight {
  version: 2
  clips: PreviewClip[]
  boundaries: MergeManifest['boundaries']
  total_duration_ms: number
  canvas: MergeManifest['canvas']
  fps: string
  timebase: string
  blockers: MergeBlocker[]
  /** Internal frozen manifest; omitted by the API route. */
  manifest: MergeManifest | null
}

export class MergePreflightError extends Error {
  constructor(public readonly preview: MergePreflight) {
    super(preview.blockers.map(blocker => blocker.message).join('；') || '拼接前检查未通过')
    this.name = 'MergePreflightError'
  }
}

interface StoryboardSelection {
  id: number
  storyboardNumber: number
  previousStoryboardId: number | null
  videoTaskId: number | null
  videoUrl: string | null
  composedVideoUrl: string | null
  transitionConfig: unknown
}

function selectedStoryboardIds(storyboardIds?: number[]): Set<number> | null {
  if (!storyboardIds?.length) return null
  return new Set(storyboardIds.map(Number).filter(id => Number.isInteger(id) && id > 0))
}

function previewClipFromStoryboard(sb: StoryboardSelection, probe?: MediaProbe, offsetMs: number | null = null): PreviewClip {
  return {
    storyboard_id: sb.id, storyboard_number: sb.storyboardNumber, video_task_id: sb.videoTaskId,
    url: sb.videoUrl || sb.composedVideoUrl, duration_ms: probe?.duration_ms ?? null,
    fps: probe?.fps ?? null, width: probe?.width ?? null, height: probe?.height ?? null,
    has_audio: probe?.has_audio ?? null, offset_ms: offsetMs,
  }
}

function toTransitionOverrides(values?: TransitionOverride[]): TransitionOverride[] {
  return (values || []).map(value => ({
    storyboard_id: Number(value.storyboard_id), type: value.type,
    ...(value.duration_ms === undefined ? {} : { duration_ms: Number(value.duration_ms) }),
  }))
}

function storyboardSelection(row: typeof schema.storyboards.$inferSelect, previousStoryboardId: number | null): StoryboardSelection {
  return {
    id: row.id, storyboardNumber: row.storyboardNumber, previousStoryboardId,
    videoTaskId: row.videoTaskId ?? null, videoUrl: row.videoUrl, composedVideoUrl: row.composedVideoUrl,
    transitionConfig: row.transitionConfig,
  }
}

async function loadSelection(episodeId: number, storyboardIds?: number[]): Promise<{
  rows: StoryboardSelection[]
  blockers: MergeBlocker[]
}> {
  const allRows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
  const all = allRows.map((row, index) => storyboardSelection(row, index ? allRows[index - 1].id : null))
  const requested = selectedStoryboardIds(storyboardIds)
  if (!requested) return { rows: all, blockers: [] }
  const found = new Set(all.map(row => row.id))
  const blockers: MergeBlocker[] = []
  for (const id of requested) {
    if (!found.has(id)) blockers.push({ code: 'storyboard_not_found', storyboard_id: id, message: `分镜 ${id} 不属于该剧集或已删除` })
  }
  return { rows: all.filter(row => requested.has(row.id)), blockers }
}

function previewWithDefaults(rows: StoryboardSelection[], canvas: MergeManifest['canvas'], blockers: MergeBlocker[]): MergePreflight {
  return {
    version: 2, clips: rows.map(row => previewClipFromStoryboard(row)), boundaries: [], total_duration_ms: 0,
    canvas, fps: '30/1', timebase: '1/30', blockers, manifest: null,
  }
}

/** Probe and build the exact v2 timeline. This does no generation and is safe for preview. */
export async function previewEpisodeMerge(
  episodeId: number, dramaId: number, storyboardIds?: number[], transitions?: TransitionOverride[],
): Promise<MergePreflight> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  let canvas: MergeManifest['canvas']
  const blockers: MergeBlocker[] = []
  try { canvas = resolveCanvas(episode?.resolution, drama?.aspectRatio) } catch (error) {
    blockers.push({ code: 'canvas_unresolved', message: error instanceof Error ? error.message : String(error) })
    canvas = { width: 1280, height: 720, aspect_ratio: '16:9', resolution: '720p' }
  }
  const selection = await loadSelection(episodeId, storyboardIds)
  blockers.push(...selection.blockers)
  const suite = await checkFfmpegSuite()
  if (!suite.ffprobe) blockers.push({ code: 'ffprobe_unavailable', message: '本机 ffprobe 不可用，无法读取视频实际帧数和时长' })
  if (!suite.ffmpeg) blockers.push({ code: 'ffmpeg_unavailable', message: '本机 ffmpeg 不可用，无法导出视频' })

  const sources: TimelineSource[] = []
  const previewClips: PreviewClip[] = []
  for (const row of selection.rows) {
    const url = row.videoUrl || row.composedVideoUrl
    if (!url) {
      blockers.push({ code: 'missing_video_url', storyboard_id: row.id, message: `分镜 S${row.storyboardNumber} 没有可用视频 URL` })
      previewClips.push(previewClipFromStoryboard(row))
      continue
    }
    let filePath: string
    let stat: fs.Stats
    try { filePath = toAbsoluteVideoPath(url); stat = assertReadableVideo(filePath) } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      blockers.push({ code: 'video_unreadable', storyboard_id: row.id, message: `分镜 S${row.storyboardNumber} 视频不可读：${message}` })
      previewClips.push(previewClipFromStoryboard(row)); continue
    }
    if (!suite.ffprobe) { previewClips.push(previewClipFromStoryboard(row)); continue }
    try {
      const probe = await probeMedia(filePath)
      sources.push({
        storyboard_id: row.id, storyboard_number: row.storyboardNumber, previous_storyboard_id: row.previousStoryboardId,
        video_task_id: row.videoTaskId, url, duration_ms: probe.duration_ms, probe,
        source_size: stat.size, source_mtime_ms: stat.mtimeMs, transition: row.transitionConfig,
      })
      previewClips.push(previewClipFromStoryboard(row, probe))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      blockers.push({ code: 'ffprobe_failed', storyboard_id: row.id, message: `分镜 S${row.storyboardNumber} 无法探测视频：${message}` })
      previewClips.push(previewClipFromStoryboard(row))
    }
  }
  // Keep the old readiness invariant explicit: every requested storyboard must have a readable source.
  const readyVideos = sources
  const storyboards = selection.rows
  if (blockers.length || readyVideos.length !== storyboards.length || readyVideos.length === 0) {
    if (!blockers.length && readyVideos.length === 0) blockers.push({ code: 'no_clips', message: '所选镜头还没有可拼接的视频' })
    return { ...previewWithDefaults(selection.rows, canvas, blockers), clips: previewClips }
  }
  let manifest: MergeManifest
  try {
    manifest = buildTimelineManifest({ episodeId, dramaId, createdAt: now(), canvas, sources, overrides: toTransitionOverrides(transitions) })
  } catch (error) {
    blockers.push({ code: 'invalid_transition', message: error instanceof Error ? error.message : String(error) })
    return { ...previewWithDefaults(selection.rows, canvas, blockers), clips: previewClips }
  }
  const clipById = new Map(manifest.clips.map(clip => [clip.storyboard_id, clip]))
  return {
    version: 2, clips: previewClips.map(clip => ({ ...clip, offset_ms: clipById.get(clip.storyboard_id)?.offset_ms ?? null })),
    boundaries: manifest.boundaries, total_duration_ms: manifest.total_duration_ms,
    canvas: manifest.canvas, fps: manifest.fps, timebase: manifest.timebase, blockers, manifest,
  }
}

export function publicMergePreview(preview: MergePreflight): Omit<MergePreflight, 'manifest'> {
  const { manifest: _manifest, ...publicPreview } = preview
  return publicPreview
}

/** Start an asynchronous export after complete preflight. Old scenes arrays remain readable. */
export async function mergeEpisodeVideos(
  episodeId: number, dramaId: number, storyboardIds?: number[], transitions?: TransitionOverride[],
): Promise<number> {
  const preview = await previewEpisodeMerge(episodeId, dramaId, storyboardIds, transitions)
  if (preview.blockers.length) throw new MergePreflightError(preview)
  if (!preview.manifest) throw new MergePreflightError({ ...preview, blockers: [{ code: 'no_manifest', message: '拼接时间轴为空' }] })
  const manifest = preview.manifest
  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: manifest.clips.length })
  const res = await db.insert(schema.videoMerges).values({
    episodeId, dramaId, title: `Episode ${episodeId} Merge`, provider: 'ffmpeg', model: 'ffmpeg-concat-h264-aac-v2',
    status: 'processing', scenes: JSON.stringify(manifest), createdAt: now(),
  })
  const mergeId = getInsertId(res)
  doMerge(mergeId, episodeId, manifest).catch(async error => {
    const message = error instanceof Error ? error.message : String(error)
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: message })
    console.error('[Merge] Failed:', error)
    await db.update(schema.videoMerges).set({ status: 'failed', errorMsg: message }).where(eq(schema.videoMerges.id, mergeId))
  })
  return mergeId
}

async function doMerge(mergeId: number, episodeId: number, manifest: MergeManifest): Promise<void> {
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)
  const mergedRelative = `static/merged/${outputFilename}`
  const tempRoot = path.join(STORAGE_ROOT, 'temp')
  try {
    const result = await executeMergeManifest(manifest, outputPath, {
      tempRoot,
      onNormalized: async normalized => {
        await db.update(schema.videoMerges).set({ scenes: JSON.stringify(normalized) }).where(eq(schema.videoMerges.id, mergeId))
      },
    })
    await extractVideoPoster(mergedRelative)
    await db.update(schema.videoMerges).set({
      status: 'completed', mergedUrl: mergedRelative, duration: Math.round(result.probe.duration), completedAt: now(), scenes: JSON.stringify(result.manifest),
    }).where(eq(schema.videoMerges.id, mergeId))
    await db.update(schema.episodes).set({
      videoUrl: mergedRelative, duration: Math.round(result.probe.duration), updatedAt: now(),
    }).where(eq(schema.episodes.id, episodeId))
    logTaskSuccess('MergeTask', 'episode-merge', {
      mergeId, episodeId, output: mergedRelative, duration: result.probe.duration,
      expectedDuration: manifest.total_duration_ms / 1000, clips: manifest.clips.length,
    })
  } catch (error) {
    // executeMergeManifest only creates/cleans its owned task directory and never deletes old outputs.
    throw error
  }
}

export { toAbsoluteVideoPath }
