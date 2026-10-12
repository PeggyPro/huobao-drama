import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import {
  buildTimelineManifest,
  executeMergeManifest,
  probeMedia,
  resolveCanvas,
  type MediaProbe,
  type TimelineSource,
} from '../src/services/ffmpeg-merge-helper.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegBin = process.env.FFMPEG_BIN || require('ffmpeg-static')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-merge-v2-'))
const canvas = resolveCanvas('480p', '16:9')
const clips = new Map<string, string>()

async function makeClip(name: string, duration: number, fps: number, color: string, audio: boolean): Promise<string> {
  const output = path.join(tempRoot, `${name}.mp4`)
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=${fps}`]
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${400 + fps * 10}:sample_rate=32000`)
  args.push('-t', String(duration), '-map', '0:v:0')
  if (audio) args.push('-map', '1:a:0')
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  if (audio) args.push('-c:a', 'aac', '-ar', '32000', '-ac', '1')
  else args.push('-an')
  args.push(output)
  await execFileAsync(ffmpegBin, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  clips.set(name, output)
  return output
}

async function source(id: number, number: number, name: string, transition?: unknown, previousId?: number): Promise<TimelineSource> {
  const url = clips.get(name)!
  const probe = await probeMedia(url)
  const stat = fs.statSync(url)
  return {
    storyboard_id: id, storyboard_number: number, previous_storyboard_id: previousId,
    url, duration_ms: probe.duration_ms, probe, transition,
    source_size: stat.size, source_mtime_ms: stat.mtimeMs,
  }
}

function mergeSources(sources: TimelineSource[], overrides = []) {
  return buildTimelineManifest({
    episodeId: 1, dramaId: 1, createdAt: new Date().toISOString(), canvas, sources, overrides,
  })
}

before(async () => {
  await makeClip('red', 1, 15, 'red', true)
  await makeClip('green', 0.7, 30, 'green', false)
  await makeClip('blue', 0.8, 24, 'blue', true)
  await makeClip('yellow', 1, 30, 'yellow', true)
  await makeClip('purple', 1, 30, 'purple', true)
})

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

test('cut timeline normalizes mixed fps and fills missing audio', async () => {
  const sources = [await source(1, 1, 'red'), await source(2, 2, 'green', { type: 'cut' }, 1), await source(3, 3, 'blue', { type: 'cut' }, 2)]
  const manifest = mergeSources(sources)
  assert.equal(manifest.fps, sources[0].probe.fps)
  assert.equal(manifest.boundaries.every(boundary => boundary.type === 'cut'), true)
  assert.equal(manifest.total_frames, manifest.clips.reduce((sum, clip) => sum + clip.frame_count, 0))
  const output = path.join(tempRoot, 'cut.mp4')
  const result = await executeMergeManifest(manifest, output, { tempRoot: path.join(tempRoot, 'tasks') })
  assert.ok(fs.existsSync(output))
  assert.ok(Math.abs(result.probe.frame_count - manifest.total_frames) <= 1)
  assert.equal(result.probe.fps, manifest.fps)
  assert.equal(result.probe.has_audio, true)
  assert.ok(result.probe.audio_duration != null)
  assert.ok(Math.abs(result.probe.audio_duration! - result.probe.duration) <= 1 / result.probe.fps_num + 1 / 48000)
})

test('dissolve quantizes to source fps and shortens both streams once', async () => {
  const sources = [await source(10, 1, 'yellow'), await source(11, 2, 'purple', { type: 'dissolve' }, 10)]
  const manifest = mergeSources(sources)
  assert.equal(manifest.boundaries[0].type, 'dissolve')
  assert.ok(manifest.boundaries[0].overlap_frames >= 1)
  assert.ok(manifest.boundaries[0].duration_ms <= 250)
  assert.equal(manifest.total_frames, manifest.clips[0].frame_count + manifest.clips[1].frame_count - manifest.boundaries[0].overlap_frames)
  const result = await executeMergeManifest(manifest, path.join(tempRoot, 'dissolve.mp4'), { tempRoot: path.join(tempRoot, 'tasks-dissolve') })
  assert.ok(Math.abs(result.probe.frame_count - manifest.total_frames) <= 1)
})

test('audio_fade keeps the cut duration and fades each edge', async () => {
  const sources = [await source(20, 1, 'yellow'), await source(21, 2, 'purple', { type: 'audio_fade', duration_ms: 30 }, 20)]
  const manifest = mergeSources(sources)
  assert.equal(manifest.boundaries[0].type, 'audio_fade')
  assert.equal(manifest.total_frames, manifest.clips[0].frame_count + manifest.clips[1].frame_count)
  const result = await executeMergeManifest(manifest, path.join(tempRoot, 'audio-fade.mp4'), { tempRoot: path.join(tempRoot, 'tasks-audio') })
  assert.ok(Math.abs(result.probe.frame_count - manifest.total_frames) <= 1)
})

test('nonconsecutive persisted transition defaults to cut but explicit override applies', async () => {
  // The incoming storyboard's actual full-episode predecessor is omitted from the selection.
  const nonconsecutive = [await source(30, 1, 'yellow'), await source(31, 3, 'purple', { type: 'dissolve' }, 999)]
  const cut = mergeSources(nonconsecutive)
  assert.equal(cut.boundaries[0].type, 'cut')
  const explicit = mergeSources(nonconsecutive, [{ storyboard_id: 31, type: 'dissolve' }])
  assert.equal(explicit.boundaries[0].type, 'dissolve')
})

test('missing source is rejected and never filtered into a successful output', async () => {
  const missing = path.join(tempRoot, 'missing.mp4')
  const probe = await probeMedia(clips.get('red')!)
  const sources: TimelineSource[] = [{ storyboard_id: 40, storyboard_number: 1, url: missing, duration_ms: probe.duration_ms, probe }]
  const manifest = mergeSources(sources)
  await assert.rejects(() => executeMergeManifest(manifest, path.join(tempRoot, 'missing-out.mp4'), { tempRoot: path.join(tempRoot, 'tasks-missing') }), /ENOENT|不可读|no such file/i)
  assert.equal(fs.existsSync(path.join(tempRoot, 'missing-out.mp4')), false)
})
