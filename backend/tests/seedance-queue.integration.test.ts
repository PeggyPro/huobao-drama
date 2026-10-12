import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'

const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'huobao-seedance-queue-'))
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
process.env.HUOBAO_DATA_DIR = tempDir
process.env.STORAGE_PATH = path.join(tempDir, 'static')
process.env.WORKSPACE_PATH = path.join(tempDir, 'workspace')
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('No network is allowed in Seedance queue compatibility tests') }
const { db, dbPath } = await import('../src/db/index.js')
const { default: tasks } = await import('../src/routes/tasks.js')
const { stopVideoQueue } = await import('../src/services/video-queue.js')
const { videoRecord } = await import('../src/services/video-task-input.js')
const { VolcEngineVideoAdapter } = await import('../src/services/adapters/volcengine-video.js')
const sqlite = db.$client
const timestamp = '2026-01-01T00:00:00Z'
const model = 'doubao-seedance-2-0-mini-260615'
assert.equal(dbPath, ':memory:')
type Json = Record<string, any>

beforeEach(() => {
  stopVideoQueue()
  networkCalls = 0
  for (const table of ['sys_task', 'storyboards', 'episodes', 'dramas', 'ai_service_configs']) sqlite.prepare(`DELETE FROM ${table}`).run()
  sqlite.prepare('INSERT INTO dramas (id,title,style,created_at,updated_at) VALUES (2,\'fixture\',\'\',?,?)').run(timestamp, timestamp)
  sqlite.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,video_config_id,resolution,created_at,updated_at) VALUES (9,2,1,\'fixture\',12,\'480p\',?,?)').run(timestamp, timestamp)
  sqlite.prepare('INSERT INTO storyboards (id,episode_id,storyboard_number,video_prompt,duration,created_at,updated_at) VALUES (100,9,1,\'fixture\',6,?,?)').run(timestamp, timestamp)
  sqlite.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,is_active,priority,created_at,updated_at)
    VALUES (12,'video','volcengine','fixture','https://seedance.invalid','test-only-key',?,1,1,?,?)`).run(JSON.stringify([model]), timestamp, timestamp)
})
after(() => {
  stopVideoQueue()
  sqlite.close()
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(tempDir), tempParent)
  assert.ok(path.basename(tempDir).startsWith('huobao-seedance-queue-'))
  fs.rmSync(tempDir, { recursive: true, force: true })
})
async function enqueue(extra: Json = {}) {
  const response = await tasks.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'video', storyboard_id: 100, drama_id: 2, prompt: '@图片1场景 @图片2角色', config_id: 12, model, duration: 6, ...extra }) })
  return { status: response.status, json: await response.json() as Json }
}
const rows = () => sqlite.prepare('SELECT * FROM sys_task').all() as Json[]

test('single Seedance route freezes ordered references, episode resolution and audio=false through the adapter', async () => {
  const images = ['https://assets.invalid/scene.png', 'https://assets.invalid/character.png']
  const videos = ['https://assets.invalid/b.mp4', 'https://assets.invalid/a.mp4']
  const audios = ['https://assets.invalid/b.wav', 'https://assets.invalid/a.wav']
  const result = await enqueue({ reference_image_urls: images, reference_video_urls: videos, reference_audio_urls: audios, generate_audio: false, resolution: '720p' })
  assert.equal(result.status, 201, JSON.stringify(result.json))
  assert.equal(rows().length, 1)
  const row = rows()[0], params = JSON.parse(row.params)
  assert.equal(row.status, 'queued')
  assert.deepEqual(params.referenceImageUrls, images)
  assert.deepEqual(params.referenceVideoUrls, videos)
  assert.deepEqual(params.referenceAudioUrls, audios)
  assert.equal(params.generateAudio, 0)
  assert.equal(params.resolution, '480p')
  assert.match(params.prompt, /@图片1场景 @图片2角色/)
  const request = new VolcEngineVideoAdapter().buildGenerateRequest({ provider: 'volcengine', baseUrl: 'https://seedance.invalid', apiKey: 'test-only-key', model }, videoRecord(row.id, 100, params))
  const body = request.body as Json
  assert.equal(body.generate_audio, false)
  assert.equal(body.resolution, '480p')
  assert.deepEqual(body.content.filter((item: Json) => item.role).map((item: Json) => ({ role: item.role, url: item.image_url?.url || item.video_url?.url || item.audio_url?.url })), [
    ...images.map(url => ({ role: 'reference_image', url })), ...videos.map(url => ({ role: 'reference_video', url })), ...audios.map(url => ({ role: 'reference_audio', url })),
  ])
  assert.equal(networkCalls, 0)
})

for (const [key, limit] of [['reference_image_urls', 9], ['reference_video_urls', 3], ['reference_audio_urls', 3]] as const) {
  test(`single Seedance route rejects ${key} above ${limit} without inserting a task`, async () => {
    const result = await enqueue({ reference_image_urls: ['https://assets.invalid/scene.png'], [key]: Array.from({ length: limit + 1 }, (_, i) => `https://assets.invalid/${i}`) })
    assert.equal(result.status, 409)
    assert.match(result.json.message, /参考素材超限/)
    assert.equal(rows().length, 0)
    assert.equal(networkCalls, 0)
  })
}
test('audio-only references fail atomically and require a visual reference', async () => {
  const result = await enqueue({ reference_audio_urls: ['https://assets.invalid/a.wav'] })
  assert.equal(result.status, 409)
  assert.match(result.json.message, /参考音频需要至少一个参考图片或视频/)
  assert.equal(rows().length, 0)
  assert.equal(networkCalls, 0)
})
test('text-only Seedance still works with audio enabled by default', async () => {
  const result = await enqueue()
  assert.equal(result.status, 201, JSON.stringify(result.json))
  assert.equal(JSON.parse(rows()[0].params).generateAudio, 1)
  assert.equal(networkCalls, 0)
})
