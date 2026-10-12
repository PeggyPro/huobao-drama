import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('volcengine video adapter only supports Seedance 2.0 models and reference mode only', () => {
  const adapter = read('src/services/adapters/volcengine-video.ts')

  // 模型白名单：仅 doubao-seedance-2-0-* 前缀
  assert.match(adapter, /SEEDANCE2_MODEL_PREFIX = 'doubao-seedance-2-0'/)
  assert.match(adapter, /startsWith\(SEEDANCE2_MODEL_PREFIX\)/)

  // 只保留多模态参考：其他模式分支与历史映射已清理
  assert.doesNotMatch(adapter, /mode === 'text'/)
  assert.doesNotMatch(adapter, /mode === 'first_frame'/)
  assert.doesNotMatch(adapter, /mode === 'first_last'/)
  assert.doesNotMatch(adapter, /LEGACY_MODE_MAP/)
  assert.doesNotMatch(adapter, /first_frame/)
  assert.doesNotMatch(adapter, /last_frame/)

  // 多模态 content 项角色
  assert.match(adapter, /role: 'reference_image'/)
  assert.match(adapter, /role: 'reference_video'/)
  assert.match(adapter, /role: 'reference_audio'/)

  // 素材上限 9/3/3、音频需视觉素材约束、至少一个素材或 prompt
  assert.match(adapter, /REF_LIMITS = \{ images: 9, videos: 3, audios: 3 \}/)
  assert.match(adapter, /参考音频需要至少 1 个参考图片或视频/)
  assert.match(adapter, /多模态参考模式需要至少一个参考素材或 prompt/)

  // generate_audio 可配置（默认开），时长支持 4-15 秒；分辨率随集固定（480p/720p，默认 720p）
  assert.match(adapter, /generate_audio:\s*record\.generateAudio/)
  assert.match(adapter, /Math\.min\(15, Math\.max\(4, parsed\)\)/)
  assert.match(adapter, /resolution: record\.resolution === '480p' \? '480p' : '720p'/)
})

test('video generation service resolves reference media and persists new fields', () => {
  const service = read('src/services/generation.ts')
  const queue = read('src/services/video-queue.ts')
  const input = read('src/services/video-task-input.ts')
  const worker = read('src/services/video-task-worker.ts')

  // 旧服务入口委托同一持久队列；云端媒体解析在真正提交前执行。
  assert.match(service, /return enqueueSingleVideo\(\{/)
  assert.match(queue, /prepareVideoInputs\(body\.tasks, body\.episode_id\)/)
  assert.match(queue, /params: JSON\.stringify\(params\)/)
  assert.match(worker, /PUBLIC_BASE_URL/)
  assert.match(worker, /prepared\.referenceVideoUrls = \(params\.referenceVideoUrls \|\| \[\]\)\.map\(publicMedia\)/)
  assert.match(worker, /prepared\.referenceAudioUrls = \(params\.referenceAudioUrls \|\| \[\]\)\.map\(publicMedia\)/)
  assert.match(input, /referenceVideoUrls: input\.reference_video_urls/)
  assert.match(input, /referenceAudioUrls: input\.reference_audio_urls/)
  assert.match(input, /generateAudio: input\.generate_audio === false \? 0 : 1/)
  assert.match(input, /referenceMode: 'reference'/)
  assert.match(worker, /adapter\.buildGenerateRequest\(config, videoRecord\(id, task\.storyboardId, prepared\)\)/)
})

test('video resolution is fixed per episode, editable, and locked into video tasks', () => {
  const episodes = read('src/routes/episodes.ts')
  const service = read('src/services/generation.ts')
  const input = read('src/services/video-task-input.ts')
  const queue = read('src/services/video-queue.ts')
  const adapter = read('src/services/adapters/volcengine-video.ts')

  // 集分辨率白名单保持；Seedance 自身将 1080p 收敛到 720p。
  assert.match(episodes, /\['480p', '720p', '1080p'\]\.includes\(body\.resolution\)/)
  assert.match(episodes, /'status', 'resolution'\]/)
  assert.match(episodes, /resolution 只支持 480p \/ 720p/)
  // 同一输入入口读取所属集，并在入队前将其优先分辨率写进 params。
  assert.match(input, /eq\(schema\.episodes\.id, shot\.episodeId\)/)
  assert.match(input, /resolution: episode\?\.resolution \|\| input\.resolution/)
  assert.match(queue, /params: JSON\.stringify\(params\)/)
  assert.match(service, /resolution: normalizeStoredVideoResolution\(params\.resolution\)/)
  assert.match(adapter, /resolution: record\.resolution === '480p' \? '480p' : '720p'/)
})

test('upload route exposes validated video and audio endpoints', () => {
  const route = read('src/routes/upload.ts')

  assert.match(route, /app\.post\('\/video'/)
  assert.match(route, /app\.post\('\/audio'/)
  assert.match(route, /VIDEO_EXT = new Set\(\['\.mp4', '\.mov', '\.webm', '\.m4v'\]\)/)
  assert.match(route, /AUDIO_EXT = new Set\(\['\.mp3', '\.wav', '\.m4a', '\.aac'\]\)/)
  assert.match(route, /50 \* 1024 \* 1024/)
  assert.match(route, /20 \* 1024 \* 1024/)
})

test('tasks route validates reference-mode requirements for video tasks', () => {
  const route = read('src/routes/tasks.ts')
  const queue = read('src/services/video-queue.ts')
  const input = read('src/services/video-task-input.ts')

  // 统一任务入口：image 维持原路径，video 经单任务队列共享校验。
  assert.match(route, /type 必须为 image 或 video/)
  assert.match(route, /generateImage\(\{/)
  assert.match(route, /enqueueSingleVideo\(body\)/)
  assert.match(queue, /enqueueVideoBatch\(\{ request_key: input\.request_key, tasks: \[input\] \}, true\)/)
  assert.match(queue, /prepareVideoInputs\(body\.tasks, body\.episode_id\)/)
  assert.match(input, /validateMedia\(input, config\.provider\)/)

  // 其他模式的旧校验已清理；多模态限制在共享输入入口执行。
  assert.doesNotMatch(route, /文生视频模式必须提供 prompt/)
  assert.doesNotMatch(route, /首帧模式必须提供 first_frame_url/)
  assert.doesNotMatch(route, /首尾帧模式必须同时提供/)
  assert.match(input, /参考素材超限：图片≤9、视频≤3、音频≤3/)
  assert.match(input, /参考音频需要至少一个参考图片或视频/)
  assert.match(input, /视频生成需要至少一个参考素材或 prompt/)
  assert.match(input, /referenceMode: 'reference'/)
  assert.match(input, /referenceVideoUrls: input\.reference_video_urls/)
  assert.match(input, /referenceAudioUrls: input\.reference_audio_urls/)
  assert.match(input, /generateAudio: input\.generate_audio === false \? 0 : 1/)
})

test('image/video generation tasks are unified into a single sys_task table', () => {
  const schema = read('src/db/schema.ts')
  const mysqlSchema = read('src/db/mysql-schema.ts')
  const envExample = read('.env.example')

  // sys_task：type 区分 image/video，生成参数收进 params(JSON)
  assert.match(schema, /export const sysTask = mysqlTable\('sys_task'/)
  assert.match(schema, /type: varchar\('type', \{ length: 16 \}\)\.notNull\(\)/)
  assert.match(schema, /params: text\('params'\)/)
  assert.match(schema, /resultUrl: text\('result_url'\)/)
  assert.match(schema, /localPath: text\('local_path'\)/)

  // 旧的 image_generations / video_generations 表定义与回填已移除
  assert.doesNotMatch(schema, /imageGenerations/)
  assert.doesNotMatch(schema, /videoGenerations/)
  assert.doesNotMatch(mysqlSchema, /CREATE TABLE IF NOT EXISTS image_generations/)
  assert.doesNotMatch(mysqlSchema, /CREATE TABLE IF NOT EXISTS video_generations/)
  assert.doesNotMatch(mysqlSchema, /column: 'reference_video_urls'/)

  // DDL 与旧表清理（不迁移历史）
  assert.match(mysqlSchema, /CREATE TABLE IF NOT EXISTS sys_task \(/)
  assert.match(mysqlSchema, /type VARCHAR\(16\) NOT NULL/)
  assert.match(mysqlSchema, /params TEXT/)
  assert.match(mysqlSchema, /result_url TEXT/)
  assert.match(mysqlSchema, /DROP TABLE IF EXISTS `image_generations`/)
  assert.match(mysqlSchema, /DROP TABLE IF EXISTS `video_generations`/)

  // 路由与服务只操作 sys_task（统一 /tasks 入口，type 过滤）
  const tasksRoute = read('src/routes/tasks.ts')
  const service = read('src/services/generation.ts')
  assert.match(tasksRoute, /schema\.sysTask/)
  assert.match(tasksRoute, /r\.type === type/)
  assert.match(service, /db\.insert\(schema\.sysTask\)/)

  assert.match(envExample, /PUBLIC_BASE_URL/)
})
