import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { after, beforeEach, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import sharp from 'sharp'

const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'huobao-storyboard-tail-test-'))
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
process.env.HUOBAO_DATA_DIR = tempDir
process.env.STORAGE_PATH = path.join(tempDir, 'static')
process.env.WORKSPACE_PATH = path.join(tempDir, 'workspace')
fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'videos'), { recursive: true })
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('Network is forbidden in storyboard continuity tests') }
const { db, dbPath, schema } = await import('../src/db/index.js')
const { STORAGE_ROOT } = await import('../src/utils/paths.js')
const { getStoryboardContinuityFrame } = await import('../src/services/storyboard-continuity.js')
const { extractVideoLastFrame } = await import('../src/utils/video-continuity.js')
const { default: storyboardRoutes } = await import('../src/routes/storyboards.js')
const { storyboardFingerprint } = await import('../src/services/video-task-input.js')
const { runVideoTask } = await import('../src/services/video-task-worker.js')
const { claimVideoTask } = await import('../src/services/video-queue.js')
const app = new Hono().route('/storyboards', storyboardRoutes)
assert.equal(dbPath, ':memory:')
assert.equal(STORAGE_ROOT, process.env.STORAGE_PATH)
assert.equal((db.$client.pragma('database_list') as { name: string; file: string }[]).find(row => row.name === 'main')?.file, '')
after(() => {
  assert.equal(networkCalls, 0)
  globalThis.fetch = originalFetch
  db.$client.close()
  assert.equal(path.dirname(fs.realpathSync(tempDir)), tempParent)
  assert.match(path.basename(tempDir), /^huobao-storyboard-tail-test-/)
  fs.rmSync(tempDir, { recursive: true })
})

// A two-second 32px fixture exercises the real last-frame cache, without a model or server.
const fixtureVideo = path.join(STORAGE_ROOT, 'videos', 'red-then-blue.mp4')
const require = createRequire(import.meta.url)
const generated = spawnSync(process.env.FFMPEG_BIN || require('ffmpeg-static'), [
  '-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1',
  '-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=4:d=1',
  '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=4:d=1',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
  '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fixtureVideo,
], { stdio: 'inherit', windowsHide: true, timeout: 15_000 })
assert.equal(generated.status, 0, generated.error?.message)

const ts = () => new Date().toISOString()
type TaskInput = Partial<typeof schema.sysTask.$inferInsert>
type ShotInput = Partial<typeof schema.storyboards.$inferInsert>
const patchTask = (id: number, input: TaskInput) => db.update(schema.sysTask).set(input).where(eq(schema.sysTask.id, id)).run()
const patchShot = (id: number, input: ShotInput) => db.update(schema.storyboards).set(input).where(eq(schema.storyboards.id, id)).run()
let sequence = 0
function video() {
  const filename = `source-${++sequence}.mp4`
  fs.copyFileSync(fixtureVideo, path.join(STORAGE_ROOT, 'videos', filename))
  return `/static/videos/${filename}`
}
function localFile(url: string) { return path.join(STORAGE_ROOT, url.replace(/^\/?static\//, '')) }
function task(storyboardId: number, localPath = video(), extra: TaskInput = {}) {
  return db.insert(schema.sysTask).values({ type: 'video', storyboardId, status: 'completed', phase: 'completed', localPath,
    createdAt: ts(), updatedAt: ts(), ...extra }).returning().get()
}
function fixture() {
  const drama = db.insert(schema.dramas).values({ title: 'isolated tail source', createdAt: ts(), updatedAt: ts() }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'episode', createdAt: ts(), updatedAt: ts() }).returning().get()
  const shots = [1, 3, 5].map(storyboardNumber => db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber,
    videoPrompt: 'frame test', createdAt: ts(), updatedAt: ts() }).returning().get())
  const [earlier, source, target] = shots
  const current = task(source.id)
  patchShot(source.id, { videoUrl: current.localPath, videoTaskId: current.id })
  return { episode, earlier, source, target, current }
}
const noExtract: typeof extractVideoLastFrame = async () => { throw new Error('Extraction must not run') }
const frame: typeof extractVideoLastFrame = async () => 'static/images/mocked-tail.png'
beforeEach(() => {
  db.delete(schema.sysTask).run()
  db.delete(schema.storyboards).run()
  db.delete(schema.episodes).run()
  db.delete(schema.dramas).run()
})

test('default extraction pins the immediate preceding current task and returns its version', async () => {
  const f = fixture()
  const older = task(f.earlier.id)
  patchShot(f.earlier.id, { videoUrl: older.localPath, videoTaskId: older.id })
  let extracted = 0
  const result = await getStoryboardContinuityFrame(f.target.id, undefined, async (url, id) => {
    extracted++
    assert.equal(url, f.current.localPath)
    assert.equal(id, f.current.id)
    return 'static/images/exact-tail.png'
  })
  assert.equal(extracted, 1)
  assert.deepEqual(result, { first_frame_url: 'static/images/exact-tail.png', source_task_id: f.current.id,
    source_storyboard_id: f.source.id, source_storyboard_number: f.source.storyboardNumber, source_video_url: f.current.localPath })
})

test('legacy local video remains usable without inventing a task version or trusting an old context flag', async () => {
  const f = fixture()
  patchShot(f.source.id, { videoTaskId: null })
  patchTask(f.current.id, { params: JSON.stringify({ h3_motion_context_version: 1 }) })
  const result = await getStoryboardContinuityFrame(f.target.id, undefined, async (url, id) => {
    assert.equal(url, f.current.localPath)
    assert.equal(id, undefined)
    return 'static/images/legacy-tail.png'
  })
  assert.equal(result.source_task_id, null)
})

for (const [status, phase] of [['queued', 'queued'], ['processing', 'polling'], ['downloading', 'downloading'], ['blocked', 'submission_unknown']]) {
  test(`default refuses the old frame during ${status}/${phase}, while an explicit completed version remains selectable`, async () => {
    const f = fixture()
    task(f.source.id, video(), { status, phase })
    await assert.rejects(getStoryboardContinuityFrame(f.target.id, undefined, noExtract), (error: any) => error.status === 409)
    const result = await getStoryboardContinuityFrame(f.target.id, f.current.id, frame)
    assert.equal(result.source_task_id, f.current.id)
  })
}

test('an explicit historical task does not follow current version changes during extraction', async () => {
  const f = fixture(), historical = task(f.source.id)
  const result = await getStoryboardContinuityFrame(f.target.id, historical.id, async (url, id) => {
    assert.equal(url, historical.localPath)
    assert.equal(id, historical.id)
    const newCurrent = task(f.source.id)
    patchShot(f.source.id, { videoTaskId: newCurrent.id, videoUrl: newCurrent.localPath })
    return 'static/images/history-tail.png'
  })
  assert.equal(result.source_video_url, historical.localPath)
  assert.equal(result.source_task_id, historical.id)
})

test('sources from an earlier nonadjacent shot or another episode are rejected', async () => {
  const f = fixture(), other = fixture()
  for (const source of [task(f.earlier.id), other.current]) {
    await assert.rejects(getStoryboardContinuityFrame(f.target.id, source.id, noExtract), /上一分镜已完成/)
  }
})

for (const invalid of [
  { status: 'processing' }, { status: 'cancelled' }, { status: 'failed' }, { deletedAt: '2026-01-01' },
  { phase: 'completed_stale' }, { type: 'image' }, { localPath: null },
] satisfies TaskInput[]) {
  test(`explicit source rejects an unavailable task: ${JSON.stringify(invalid)}`, async () => {
    const f = fixture()
    patchTask(f.current.id, invalid)
    await assert.rejects(getStoryboardContinuityFrame(f.target.id, f.current.id, noExtract), /已完成、未删除且未失效/)
  })
}

test('a dangling current task pointer or mismatched current video is not silently treated as legacy', async () => {
  const f = fixture()
  patchShot(f.source.id, { videoTaskId: 999999 })
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, undefined, noExtract), /已完成、未删除且未失效/)
  patchShot(f.source.id, { videoTaskId: f.current.id, videoUrl: video() })
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, undefined, noExtract), /当前视频与任务版本不一致/)
})

for (const sameFile of [false, true]) {
  test(`default rejects a version switch during extraction even if the video path ${sameFile ? 'stays the same' : 'changes'}`, async () => {
    const f = fixture()
    await assert.rejects(getStoryboardContinuityFrame(f.target.id, undefined, async () => {
      const replacement = task(f.source.id, sameFile ? f.current.localPath! : video())
      patchShot(f.source.id, { videoUrl: replacement.localPath, videoTaskId: replacement.id })
      return 'static/images/stale.png'
    }), /来源视频版本已改变/)
  })
}

test('a source switch during filesystem preparation is rejected before extraction starts', async (t) => {
  const f = fixture(), actualStat = fsPromises.stat
  let intercepted = false
  t.mock.method(fsPromises, 'stat', (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (!intercepted && String(args[0]) === localFile(f.current.localPath!)) {
      intercepted = true
      const replacement = task(f.source.id)
      patchShot(f.source.id, { videoTaskId: replacement.id, videoUrl: replacement.localPath })
    }
    return actualStat(...args)
  }) as typeof fsPromises.stat)
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, undefined, noExtract), /来源视频版本已改变/)
  assert.equal(intercepted, true)
})

for (const change of ['target_deleted', 'target_moved', 'episode_deleted', 'source_deleted', 'source_shot_deleted', 'reordered', 'new_predecessor', 'source_cancelled', 'source_stale', 'source_path'] as const) {
  test(`extraction revalidates task state and adjacency after ${change}`, async () => {
    const f = fixture()
    await assert.rejects(getStoryboardContinuityFrame(f.target.id, f.current.id, async () => {
      if (change === 'target_deleted') patchShot(f.target.id, { deletedAt: ts() })
      if (change === 'target_moved') patchShot(f.target.id, { episodeId: 999999 })
      if (change === 'source_shot_deleted') patchShot(f.source.id, { deletedAt: ts() })
      if (change === 'episode_deleted') db.update(schema.episodes).set({ deletedAt: ts() }).where(eq(schema.episodes.id, f.episode.id)).run()
      if (change === 'source_deleted') patchTask(f.current.id, { deletedAt: ts() })
      if (change === 'reordered') patchShot(f.source.id, { storyboardNumber: 0 })
      if (change === 'new_predecessor') db.insert(schema.storyboards).values({ episodeId: f.episode.id, storyboardNumber: 4, createdAt: ts(), updatedAt: ts() }).run()
      if (change === 'source_cancelled') patchTask(f.current.id, { status: 'cancelled' })
      if (change === 'source_stale') patchTask(f.current.id, { phase: 'completed_stale' })
      if (change === 'source_path') patchTask(f.current.id, { localPath: video() })
      return 'static/images/stale.png'
    }), /不存在|已完成、未删除且未失效|邻接关系或来源视频版本已改变/)
  })
}

test('a generation starting during default extraction blocks the old frame', async () => {
  const f = fixture()
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, undefined, async () => {
    task(f.source.id, video(), { status: 'queued', phase: 'queued' })
    return 'static/images/stale.png'
  }), /正在生成或提交结果待确认/)
})

test('a source file modified during extraction cannot be returned under its old identity', async () => {
  const f = fixture()
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, f.current.id, async () => {
    fs.appendFileSync(localFile(f.current.localPath!), 'changed bytes')
    return 'static/images/stale.png'
  }), /来源视频文件已改变/)
})

test('missing previous shots, deleted targets, remote URLs, empty files and traversal fail before extraction', async () => {
  const f = fixture()
  await assert.rejects(getStoryboardContinuityFrame(f.earlier.id, undefined, noExtract), /没有上一分镜/)
  await assert.rejects(getStoryboardContinuityFrame(999999, undefined, noExtract), /当前分镜不存在/)
  patchTask(f.current.id, { localPath: 'https://example.invalid/video.mp4' })
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, f.current.id, noExtract), /本地视频/)
  const empty = video()
  fs.writeFileSync(localFile(empty), '')
  patchTask(f.current.id, { localPath: empty })
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, f.current.id, noExtract), /为空或不可读/)
  const outside = path.join(tempDir, 'outside.mp4')
  fs.copyFileSync(fixtureVideo, outside)
  patchTask(f.current.id, { localPath: 'static/videos/../../outside.mp4' })
  await assert.rejects(getStoryboardContinuityFrame(f.target.id, f.current.id, noExtract), /超出素材目录/)
})

test('last-frame cache distinguishes task versions, reuses one version, and invalidates a changed file', async () => {
  const url = video()
  const [first, second, legacy] = await Promise.all([extractVideoLastFrame(url, 71), extractVideoLastFrame(url, 72), extractVideoLastFrame(url)])
  assert.equal(new Set([first, second, legacy]).size, 3)
  assert.match(first, /^static\/images\/continuity-[a-f0-9]+\.png$/)
  const imageFile = localFile(first), stamp = fs.statSync(imageFile).mtimeMs
  assert.equal(await extractVideoLastFrame(url.slice(1), 71), first)
  assert.equal(fs.statSync(imageFile).mtimeMs, stamp)
  const metadata = await sharp(imageFile).metadata(), { channels } = await sharp(imageFile).stats()
  assert.equal(metadata.width, 32)
  assert.equal(metadata.height, 32)
  assert.ok(channels[2].mean > 240 && channels[0].mean < 15, 'cache must contain the blue last frame, not the red poster')
  const input = localFile(url), current = fs.statSync(input)
  fs.utimesSync(input, current.atime, new Date(current.mtimeMs + 2000))
  assert.notEqual(await extractVideoLastFrame(url, 71), first)
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(extractVideoLastFrame(url, id), /source_task_id 必须为正整数/)
  }
})

test('POST continuity-frame accepts an empty body and returns the exact explicit historical version', async () => {
  const f = fixture(), historical = task(f.source.id)
  const request = async (body?: object) => app.request(`/storyboards/${f.target.id}/continuity-frame`, { method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const currentResponse = await request()
  assert.equal(currentResponse.status, 200)
  const current = (await currentResponse.json() as any).data
  assert.equal(current.source_task_id, f.current.id)
  assert.equal(current.source_video_url, f.current.localPath)
  task(f.source.id, video(), { status: 'queued', phase: 'queued' })
  assert.equal((await request()).status, 409)
  const historicalResponse = await request({ source_task_id: historical.id })
  assert.equal(historicalResponse.status, 200)
  const selected = (await historicalResponse.json() as any).data
  assert.equal(selected.source_task_id, historical.id)
  assert.equal(selected.source_storyboard_id, f.source.id)
  assert.equal(selected.source_video_url, historical.localPath)
  assert.notEqual(selected.first_frame_url, current.first_frame_url)
})

test('POST rejects nonobject bodies, malformed JSON and every non-positive-integer source ID', async () => {
  const f = fixture()
  for (const body of ['null', '[]', '"text"', '{', ...[null, 0, -1, 1.5, '1', true, Number.MAX_SAFE_INTEGER + 1].map(source_task_id => JSON.stringify({ source_task_id }))]) {
    const result = await app.request(`/storyboards/${f.target.id}/continuity-frame`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(result.status, 400, body)
  }
  for (const id of [0, -1, 1.5]) await assert.rejects(getStoryboardContinuityFrame(f.target.id, id, noExtract), /source_task_id 必须为正整数/)
})

test('the queue worker passes the exact pinned source task ID to tail extraction', async () => {
  const f = fixture()
  const child = task(f.target.id, video(), { status: 'queued', phase: 'queued', dependsOnTaskId: f.current.id,
    params: JSON.stringify({ queueVersion: 1, storyboardFingerprint: storyboardFingerprint(f.target.id),
      connection: { provider: 'comfyui', baseUrl: 'http://never-submit.invalid', model: 'test', requiresAuth: false },
      continuityPlan: { mode: 'tail_frame' }, continuitySourceTaskId: f.current.id, continuitySourceStoryboardId: f.source.id,
    }) })
  const token = claimVideoTask(child.id)
  assert.ok(token)
  let invoked = false
  await assert.rejects(runVideoTask(child.id, token, { extractTail: async (url, id) => {
    invoked = true
    assert.equal(id, f.current.id)
    assert.equal(url, f.current.localPath)
    throw new Error('controlled extraction boundary')
  } }), /controlled extraction boundary/)
  assert.equal(invoked, true)
})
