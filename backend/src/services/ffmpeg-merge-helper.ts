import fs from 'node:fs'
import path from 'node:path'
import type { FfprobeData, FfmpegCommand } from 'fluent-ffmpeg'
import { ffmpeg } from '../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { transitionConfigSchema } from './continuity-contract.js'

export type TransitionType = 'cut' | 'dissolve' | 'audio_fade'
export interface TransitionOverride { storyboard_id: number; type: TransitionType; duration_ms?: number }
export interface NormalizedTransition {
  type: TransitionType
  duration_ms: number
  requested_duration_ms: number
  overlap_frames: number
  warning?: string
}
export interface FrameRate { num: number; den: number; text: string; value: number }
export interface MediaProbe {
  duration: number
  duration_ms: number
  width: number
  height: number
  fps: string
  fps_num: number
  fps_den: number
  frame_count: number
  has_audio: boolean
  audio_sample_rate: number | null
  audio_channels: number | null
  audio_duration: number | null
  timebase: string
}
export interface TimelineClip {
  storyboard_id: number
  storyboard_number: number
  video_task_id: number | null
  url: string
  source_duration_ms: number
  source_frame_count: number
  source_fps: string
  source_size?: number
  source_mtime_ms?: number
  duration_ms: number
  frame_count: number
  fps: string
  width: number
  height: number
  has_audio: boolean
  offset_ms: number
  offset_frames: number
  transition: NormalizedTransition
}
export interface TimelineBoundary {
  previous_storyboard_id: number
  storyboard_id: number
  type: TransitionType
  duration_ms: number
  requested_duration_ms: number
  offset_ms: number
  overlap_ms: number
  overlap_frames: number
  warning?: string
}
export interface MergeCanvas { width: number; height: number; aspect_ratio: string; resolution: string }
export interface MergeManifest {
  version: 2
  episode_id: number
  drama_id: number
  created_at: string
  timing: 'preflight' | 'normalized'
  fps: string
  timebase: string
  canvas: MergeCanvas
  clips: TimelineClip[]
  boundaries: TimelineBoundary[]
  total_frames: number
  total_duration_ms: number
}
export interface TimelineSource {
  storyboard_id: number
  storyboard_number: number
  previous_storyboard_id?: number | null
  video_task_id?: number | null
  url: string
  duration_ms: number
  probe: MediaProbe
  source_size?: number
  source_mtime_ms?: number
  transition?: unknown
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

/** Keep useful rational rates (including NTSC); reject bogus/unsupported metadata. */
export function parseFrameRate(value: unknown): FrameRate | null {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:\/(\d+))?$/)
  if (!match) return null
  let num = Number(match[1])
  let den = Number(match[2] || 1)
  if (!Number.isInteger(num)) { num = Math.round(num * 1000); den *= 1000 }
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null
  const divisor = gcd(num, den)
  num /= divisor
  den /= divisor
  const rate = num / den
  if (rate < 1 || rate > 240 || den > 1001 || num > 240000) return null
  return { num, den, text: `${num}/${den}`, value: rate }
}

export function probeMetadata(filePath: string): Promise<FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, ['-count_frames'], (error, metadata) => error ? reject(error) : resolve(metadata))
  })
}

/** Count decoded frames, and never use a longer audio/container duration for video. */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const metadata = await probeMetadata(filePath)
  const video = metadata.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (!video) throw new Error('没有可读的视频流')
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio')
  const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate)
  if (!fps) throw new Error('无法确定有效视频帧率（支持 1–240 fps）')
  const frameCount = Number(video.nb_read_frames)
  const width = Number(video.width)
  const height = Number(video.height)
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || !width || !height) throw new Error('无法读取视频帧数或画面尺寸')
  // For VFR sources stream duration preserves the actual timeline. Normalized CFR
  // intermediates and final output always use their measured frame_count / fps.
  const streamDuration = Number(video.duration)
  const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : frameCount / fps.value
  return {
    duration, duration_ms: duration * 1000, width, height,
    fps: fps.text, fps_num: fps.num, fps_den: fps.den, frame_count: frameCount,
    has_audio: Boolean(audio), audio_sample_rate: audio ? Number(audio.sample_rate) || null : null,
    audio_channels: audio?.channels ?? null,
    audio_duration: audio && Number.isFinite(Number(audio.duration)) ? Number(audio.duration) : null,
    timebase: video.time_base || `${fps.den}/${fps.num}`,
  }
}

export function toAbsoluteVideoPath(value: string): string {
  const clean = value.trim()
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(clean)) throw new Error('导出需要已下载的本地视频文件')
  const relative = clean.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  if (relative.startsWith('static/')) return path.resolve(DATA_ROOT, relative)
  if (path.isAbsolute(clean)) return path.resolve(clean)
  return path.resolve(STORAGE_ROOT, relative)
}

export function assertReadableVideo(filePath: string): fs.Stats {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size <= 0) throw new Error('视频文件为空或不是文件')
  fs.accessSync(filePath, fs.constants.R_OK)
  return stat
}

/** Resolution is the existing short-edge tier; the drama's ratio sets orientation. */
export function resolveCanvas(resolution: unknown, aspectRatio: unknown): MergeCanvas {
  const tier = String(resolution || '720p').trim().toLowerCase()
  if (!['480p', '720p', '1080p'].includes(tier)) throw new Error(`不支持的剧集分辨率：${tier}`)
  const text = String(aspectRatio || '16:9').trim()
  const match = text.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  const ratio = match ? Number(match[1]) / Number(match[2]) : 0
  if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 10) throw new Error(`无法确定项目画幅：${text}`)
  const shortEdge = Number(tier.slice(0, -1))
  const even = (number: number) => Math.round(number / 2) * 2
  return {
    width: ratio >= 1 ? even(shortEdge * ratio) : shortEdge,
    height: ratio >= 1 ? shortEdge : even(shortEdge / ratio),
    aspect_ratio: text, resolution: tier,
  }
}

function transitionValue(value: unknown) {
  const parsed = typeof value === 'string' && value ? JSON.parse(value) : value
  return transitionConfigSchema.parse(parsed ?? { type: 'cut', duration_ms: 0 })
}

/** Positive dissolves occupy whole frames and never exceed either short-clip bound. */
export function normalizeTransition(
  value: unknown, previousDurationMs: number, incomingDurationMs: number, fpsNum: number, fpsDen: number,
): NormalizedTransition {
  const config = transitionValue(value)
  const requested = config.duration_ms
  if (config.type === 'cut') return { type: 'cut', duration_ms: 0, requested_duration_ms: 0, overlap_frames: 0 }
  if (config.type === 'dissolve') {
    const frameMs = 1000 * fpsDen / fpsNum
    const maxFrames = Math.floor((Math.min(500, previousDurationMs / 4, incomingDurationMs / 4) + 1e-7) / frameMs)
    if (maxFrames < 1) {
      return { type: 'cut', duration_ms: 0, requested_duration_ms: requested, overlap_frames: 0,
        warning: '片段不足四帧，无法在四分之一时长内叠化，已保护为直接切镜' }
    }
    const frames = Math.min(maxFrames, Math.max(1, Math.floor((requested + 1e-7) / frameMs)))
    return { type: 'dissolve', duration_ms: frames * frameMs, requested_duration_ms: requested, overlap_frames: frames }
  }
  const samples = Math.floor(Math.min(requested, 100, previousDurationMs / 4, incomingDurationMs / 4) * 48)
  return { type: 'audio_fade', duration_ms: samples / 48, requested_duration_ms: requested, overlap_frames: 0 }
}

export function buildTimelineManifest(args: {
  episodeId: number; dramaId: number; createdAt: string; canvas: MergeCanvas;
  sources: TimelineSource[]; overrides?: TransitionOverride[];
}): MergeManifest {
  const sources = [...args.sources].sort((a, b) => a.storyboard_number - b.storyboard_number || a.storyboard_id - b.storyboard_id)
  const fps = parseFrameRate(sources[0]?.probe.fps)
  if (!fps || !sources.length) throw new Error('没有可用的视频时间轴')
  const explicit = new Map<number, TransitionOverride>()
  for (const override of args.overrides || []) {
    if (explicit.has(override.storyboard_id)) throw new Error('同一分镜只能有一个转场覆盖')
    if (!sources.some(source => source.storyboard_id === override.storyboard_id)) throw new Error(`转场分镜 ${override.storyboard_id} 不在本次选段中`)
    transitionValue(override)
    explicit.set(override.storyboard_id, override)
  }
  const clips: TimelineClip[] = []
  const boundaries: TimelineBoundary[] = []
  let totalFrames = 0
  for (const [index, source] of sources.entries()) {
    const frames = Math.max(1, Math.round(source.duration_ms * fps.value / 1000))
    const durationMs = frames * 1000 / fps.value
    const previous = clips[index - 1]
    const adjacent = source.previous_storyboard_id === undefined
      ? previous?.storyboard_number === source.storyboard_number - 1
      : previous?.storyboard_id === source.previous_storyboard_id
    const config = explicit.get(source.storyboard_id) ?? (adjacent ? source.transition : undefined)
    const transition = previous ? normalizeTransition(config, previous.duration_ms, durationMs, fps.num, fps.den)
      : { type: 'cut' as const, duration_ms: 0, requested_duration_ms: 0, overlap_frames: 0 }
    const startFrame = totalFrames - transition.overlap_frames
    if (previous) boundaries.push({
      previous_storyboard_id: previous.storyboard_id, storyboard_id: source.storyboard_id,
      type: transition.type, duration_ms: transition.duration_ms, requested_duration_ms: transition.requested_duration_ms,
      offset_ms: startFrame * 1000 / fps.value, overlap_ms: transition.overlap_frames * 1000 / fps.value,
      overlap_frames: transition.overlap_frames, ...(transition.warning ? { warning: transition.warning } : {}),
    })
    clips.push({
      storyboard_id: source.storyboard_id, storyboard_number: source.storyboard_number,
      video_task_id: source.video_task_id ?? null, url: source.url,
      source_duration_ms: source.duration_ms, source_frame_count: source.probe.frame_count, source_fps: source.probe.fps,
      ...(source.source_size === undefined ? {} : { source_size: source.source_size, source_mtime_ms: source.source_mtime_ms }),
      duration_ms: durationMs, frame_count: frames, fps: fps.text, width: args.canvas.width, height: args.canvas.height,
      has_audio: source.probe.has_audio, offset_ms: startFrame * 1000 / fps.value, offset_frames: startFrame, transition,
    })
    totalFrames = startFrame + frames
  }
  return {
    version: 2, episode_id: args.episodeId, drama_id: args.dramaId, created_at: args.createdAt,
    timing: 'preflight', fps: fps.text, timebase: `${fps.den}/${fps.num}`, canvas: args.canvas,
    clips, boundaries, total_frames: totalFrames, total_duration_ms: totalFrames * 1000 / fps.value,
  }
}

/** Old scenes arrays (IDs or URLs) remain available alongside new structured manifests. */
export function readMergeManifest(value: string | null): MergeManifest | { version: 1; clips: unknown[] } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return { version: 1, clips: parsed }
    if (parsed?.version === 2 && Array.isArray(parsed.clips)) return parsed as MergeManifest
  } catch { /* Historic invalid scenes must not break listing existing output files. */ }
  return null
}

function seconds(milliseconds: number): string { return (milliseconds / 1000).toFixed(9) }
function run(command: FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => command
    .on('end', () => resolve())
    .on('error', (error, _stdout, stderr) => {
      const detail = typeof stderr === 'string' && stderr.trim() ? `\\n${stderr.trim().slice(-4000)}` : ''
      reject(new Error(`${error instanceof Error ? error.message : String(error)}${detail}`))
    })
    .run())
}

const ownedTempDirs = new Map<string, string>()
export function createMergeTempDir(tempRoot: string): string {
  fs.mkdirSync(tempRoot, { recursive: true })
  const root = fs.realpathSync(tempRoot)
  const directory = fs.mkdtempSync(path.join(root, 'merge-'))
  ownedTempDirs.set(directory, root)
  return directory
}

/** Only delete an exact directory allocated by this process for this merge attempt. */
export function cleanupMergeTempDir(tempDir: string, tempRoot: string): void {
  const directory = path.resolve(tempDir)
  const expectedRoot = ownedTempDirs.get(directory)
  if (!expectedRoot || fs.realpathSync(tempRoot) !== expectedRoot || path.dirname(directory) !== expectedRoot) {
    throw new Error('拒绝清理未经本次导出分配的临时目录')
  }
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error('拒绝清理已被替换的临时目录')
  }
  fs.rmSync(directory, { recursive: true })
  ownedTempDirs.delete(directory)
}

async function normalizeClip(manifest: MergeManifest, clip: TimelineClip, output: string): Promise<MediaProbe> {
  const source = toAbsoluteVideoPath(clip.url)
  const stat = assertReadableVideo(source)
  if (clip.source_size !== undefined && (stat.size !== clip.source_size || stat.mtimeMs !== clip.source_mtime_ms)) {
    throw new Error(`S${clip.storyboard_number} 的视频在预检后发生变化，请重新导出`)
  }
  const fps = parseFrameRate(manifest.fps)!
  const samples = Math.round(clip.frame_count * 48000 / fps.value)
  const video = `[0:v:0]setpts=PTS-STARTPTS,fps=fps=${manifest.fps}:round=near,` +
    `scale=${manifest.canvas.width}:${manifest.canvas.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${manifest.canvas.width}:${manifest.canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=${seconds(clip.duration_ms)},trim=end_frame=${clip.frame_count},settb=${manifest.timebase},setpts=N[v]`
  const audio = clip.has_audio
    ? `[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[a]`
  await run(ffmpeg(source).inputOptions(['-threads', '2']).complexFilter([video, audio], ['v', 'a'])
    .outputOptions(['-filter_complex_threads', '1', '-c:v', 'ffv1', '-threads', '2', '-level', '3', '-c:a', 'pcm_s16le', '-f', 'nut'])
    .output(output))
  const result = await probeMedia(output)
  if (result.frame_count !== clip.frame_count || result.fps !== manifest.fps) {
    throw new Error(`S${clip.storyboard_number} 归一化帧数/帧率不符：${result.frame_count}@${result.fps}`)
  }
  return result
}

/** Render normalized, measured inputs with one shared frame clock and one audio sample clock. */
export async function executeMergeManifest(
  frozen: MergeManifest, outputPath: string,
  options: { tempRoot?: string; onNormalized?: (manifest: MergeManifest) => Promise<void> } = {},
): Promise<{ probe: MediaProbe; manifest: MergeManifest }> {
  if (!frozen.clips.length) throw new Error('没有可导出的片段')
  if (fs.existsSync(outputPath)) throw new Error('输出路径已存在，拒绝覆盖旧成片')
  const manifest: MergeManifest = structuredClone(frozen)
  const fps = parseFrameRate(manifest.fps)!
  const toSamples = (frames: number) => Math.round(frames * 48000 * fps.den / fps.num)
  const tempRoot = options.tempRoot || path.join(STORAGE_ROOT, 'temp')
  const tempDir = createMergeTempDir(tempRoot)
  try {
    const normalized: string[] = []
    for (const [index, clip] of manifest.clips.entries()) {
      const filename = path.join(tempDir, `clip-${index}.nut`)
      const measured = await normalizeClip(manifest, clip, filename)
      clip.duration_ms = measured.frame_count * 1000 / fps.value
      normalized.push(filename)
    }
    manifest.timing = 'normalized'
    await options.onNormalized?.(manifest)
    const command = ffmpeg()
    const filters: string[] = []
    for (const [index, clip] of manifest.clips.entries()) {
      command.input(normalized[index]).inputOptions(['-threads', '2'])
      filters.push(`[${index}:v:0]setpts=PTS-STARTPTS,fps=fps=${manifest.fps},settb=AVTB[v${index}]`)
      // Absolute timeline boundaries make rounding telescopic: fractional fps can
      // never accumulate one resampling error per clip or per overlap.
      const samples = toSamples(clip.offset_frames + clip.frame_count) - toSamples(clip.offset_frames)
      const audioFilters = [`aresample=48000`, `aformat=sample_rates=48000:channel_layouts=stereo`, 'apad', `atrim=end_sample=${samples}`, 'asetpts=N/SR/TB']
      const incoming = manifest.boundaries[index - 1]
      const outgoing = manifest.boundaries[index]
      if (incoming?.type === 'audio_fade') audioFilters.push(`afade=t=in:ss=0:ns=${Math.round(incoming.duration_ms * 48)}`)
      if (outgoing?.type === 'audio_fade') {
        const fadeSamples = Math.round(outgoing.duration_ms * 48)
        audioFilters.push(`afade=t=out:ss=${samples - fadeSamples}:ns=${fadeSamples}`)
      }
      filters.push(`[${index}:a:0]${audioFilters.join(',')}[a${index}]`)
    }
    let video = 'v0'
    let audio = 'a0'
    for (let index = 1; index < manifest.clips.length; index += 1) {
      const clip = manifest.clips[index]
      const boundary = manifest.boundaries[index - 1]
      if (boundary.type === 'dissolve') {
        filters.push(`[${video}][v${index}]xfade=transition=fade:duration=${seconds(boundary.duration_ms)}:offset=${seconds(boundary.offset_ms)}[rawv${index}]`)
        const samples = toSamples(clip.offset_frames + boundary.overlap_frames) - toSamples(clip.offset_frames)
        filters.push(`[${audio}][a${index}]acrossfade=ns=${samples}:c1=tri:c2=tri[xa${index}]`)
      } else {
        filters.push(`[${video}][v${index}]concat=n=2:v=1:a=0[rawv${index}]`)
        filters.push(`[${audio}][a${index}]concat=n=2:v=0:a=1[xa${index}]`)
      }
      // fps sets its own timebase, so restore AVTB last just as on each input.
      // Otherwise a later xfade receives 1/fps from this chain and AVTB from vN.
      filters.push(`[rawv${index}]setpts=PTS-STARTPTS,fps=fps=${manifest.fps},settb=AVTB[xv${index}]`)
      video = `xv${index}`
      audio = `xa${index}`
    }
    filters.push(`[${video}]fps=fps=${manifest.fps},trim=end_frame=${manifest.total_frames},setpts=PTS-STARTPTS,settb=${manifest.timebase}[outv]`)
    filters.push(`[${audio}]apad,atrim=end_sample=${toSamples(manifest.total_frames)},asetpts=N/SR/TB[outa]`)
    const stagedOutput = path.join(tempDir, 'output.mp4')
    await run(command.complexFilter(filters, ['outv', 'outa']).outputOptions([
      '-filter_complex_threads', '1', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-threads', '2', '-pix_fmt', 'yuv420p', '-r', manifest.fps, '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-b:a', '192k', '-video_track_timescale', String(fps.num), '-movflags', '+faststart',
    ]).output(stagedOutput))
    const probe = await probeMedia(stagedOutput)
    if (Math.abs(probe.frame_count - manifest.total_frames) > 1 || probe.fps !== manifest.fps) {
      throw new Error(`成片时间轴校验失败：期望 ${manifest.total_frames}@${manifest.fps}，实际 ${probe.frame_count}@${probe.fps}`)
    }
    if (probe.audio_duration != null && Math.abs(probe.audio_duration - probe.frame_count / fps.value) > 1 / fps.value + 1 / 48000) {
      throw new Error('成片音视频时长差超过一帧')
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.copyFileSync(stagedOutput, outputPath, fs.constants.COPYFILE_EXCL)
    return { probe, manifest }
  } finally {
    cleanupMergeTempDir(tempDir, tempRoot)
  }
}
