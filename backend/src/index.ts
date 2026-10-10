import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import comfyui from './routes/comfyui.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { db, schema } from './db/index.js'
import { eq } from 'drizzle-orm'
import { now } from './utils/response.js'
import { DATA_ROOT } from './utils/paths.js'
import { recoverInterruptedTasks, SERVICE_RESTART_ERROR } from './services/generation.js'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// —— 监听地址 / 跨域来源 ——
// 监听网卡：默认 0.0.0.0（局域网、公网所有网卡都能访问）；只想本机访问时设 HUOBAO_HOST=127.0.0.1。
// 也兼容 HOST，但仅当取值确实是 IP / localhost 时才采用——macOS(zsh) 等环境会把 HOST
// 自动设成机器名（如 MacBook-Pro.local），照单全收会导致监听失败或悄悄退回仅本机。
const HOST_ENV = (process.env.HUOBAO_HOST || process.env.HOST || '').trim()
const HOST = process.env.HUOBAO_HOST
  ? HOST_ENV
  : (/^localhost$/i.test(HOST_ENV) || /^\d{1,3}(\.\d{1,3}){3}$/.test(HOST_ENV) || HOST_ENV.includes(':') ? HOST_ENV : '0.0.0.0')
const PORT = Number(process.env.PORT || 5679)

// 跨域白名单：CORS_ORIGINS 逗号分隔（* 表示任意来源）；不配置时按下面的默认规则放行。
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)

// 默认放行本机 + 私有网段来源（局域网用 IP / *.local 域名直连后端时不会被 CORS 拦截），
// 公网站点不在默认白名单内，避免任意网页读取本机的 AI Key 等敏感配置。
const PRIVATE_ORIGIN = /^(localhost|[\w-]+\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[::1\]|\[f[cd][0-9a-f]{2}:|\[fe80:)/i

// 局域网地址，供启动日志打印（方便其他设备直接照着访问）
function lanUrls(port: number) {
  const urls: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${port}`)
    }
  }
  return urls
}

// Middleware
app.use('*', cors({
  // 回显请求来源（credentials=true 时不能用 *）；返回 undefined 即不下发 ACAO 头
  origin: (origin) => {
    if (!origin) return origin
    if (CORS_ORIGINS.includes('*')) return origin
    if (CORS_ORIGINS.length) return CORS_ORIGINS.includes(origin) ? origin : undefined
    try {
      return PRIVATE_ORIGIN.test(new URL(origin).hostname) ? origin : undefined
    } catch {
      return undefined
    }
  },
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check（version 供部署巡检/更新检查核对当前运行版本）
app.get('/api/v1/health', (c) => c.json({
  status: 'ok',
  version: process.env.HUOBAO_VERSION || undefined,
  timestamp: new Date().toISOString(),
}))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/comfyui', comfyui)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)

app.route('/api/v1', api)

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

console.log(`🚀 Huobao Drama TS server on http://localhost:${PORT}`)
if (!/^(127\.|localhost$|::1$)/i.test(HOST)) {
  for (const url of lanUrls(PORT)) console.log(`📡 局域网访问: ${url}`)
}

// 进程重启后内存中的轮询线程全部丢失。先把没有恢复入口的 processing 任务
// 标记为中断，再让 ComfyUI 已经拿到 prompt_id 的任务重新接上 /history 轮询。
db.update(schema.sysTask)
  .set({ status: 'failed', errorMsg: SERVICE_RESTART_ERROR, updatedAt: now() })
  .where(eq(schema.sysTask.status, 'processing'))
  .then(async res => {
    const affected = res?.changes ?? 0
    if (affected > 0) console.log(`🔁 已清理 ${affected} 个中断的生成任务`)
    await recoverInterruptedTasks()
  })
  .catch(err => console.error('清理中断任务失败:', err?.message))

serve({ fetch: app.fetch, port: PORT, hostname: HOST })
