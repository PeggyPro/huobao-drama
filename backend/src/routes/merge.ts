import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import {
  mergeEpisodeVideos,
  previewEpisodeMerge,
  publicMergePreview,
  MergePreflightError,
  type TransitionOverride,
  type TransitionType,
} from '../services/ffmpeg-merge.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

interface MergeRequestBody {
  storyboardIds?: number[]
  transitions?: TransitionOverride[]
}

function parseMergeBody(body: unknown): MergeRequestBody {
  if (!body || typeof body !== 'object') return {}
  const value = body as Record<string, unknown>
  let storyboardIds: number[] | undefined
  if (Array.isArray(value.storyboard_ids)) {
    storyboardIds = value.storyboard_ids.map(Number)
    if (storyboardIds.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('storyboard_ids 必须是正整数数组')
  }
  let transitions: TransitionOverride[] | undefined
  if (Array.isArray(value.transitions)) {
    transitions = value.transitions.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`transitions[${index}] 参数无效`)
      const record = item as Record<string, unknown>
      const storyboardId = Number(record.storyboard_id)
      const type = record.type
      if (!Number.isInteger(storyboardId) || storyboardId <= 0) throw new Error(`transitions[${index}].storyboard_id 必须是正整数`)
      if (type !== 'cut' && type !== 'dissolve' && type !== 'audio_fade') throw new Error(`transitions[${index}].type 不支持`)
      const duration = record.duration_ms === undefined ? undefined : Number(record.duration_ms)
      if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) throw new Error(`transitions[${index}].duration_ms 必须是非负数字`)
      return {
        storyboard_id: storyboardId,
        type: type as TransitionType,
        ...(duration === undefined ? {} : { duration_ms: duration }),
      }
    })
  }
  return { storyboardIds, transitions }
}

async function readMergeBody(c: Context): Promise<MergeRequestBody> {
  try {
    return parseMergeBody(await c.req.json())
  } catch (error) {
    if (error instanceof Error && /必填|必须|参数无效|不支持/.test(error.message)) throw error
    return {}
  }
}

// POST /episodes/:id/preview — ffprobe preflight and frozen timeline, no generation.
app.post('/episodes/:id/preview', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')
  let body: MergeRequestBody
  try {
    body = await readMergeBody(c)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
  try {
    const preview = await previewEpisodeMerge(episodeId, ep.dramaId, body.storyboardIds, body.transitions)
    return success(c, publicMergePreview(preview))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return badRequest(c, message)
  }
})

// POST /episodes/:id/merge — 拼接镜头视频(body.storyboard_ids 可选,只拼所选)
app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')

  let body: MergeRequestBody
  try {
    body = await readMergeBody(c)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }

  try {
    logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId, storyboardIds: body.storyboardIds })
    const mergeId = await mergeEpisodeVideos(episodeId, ep.dramaId, body.storyboardIds, body.transitions)
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: message })
    if (error instanceof MergePreflightError) {
      return c.json({ code: 400, message, data: publicMergePreview(error.preview) }, 400)
    }
    return badRequest(c, message)
  }
})

// GET /episodes/:id/merge — 查询最新拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))

  const latest = merges[merges.length - 1]
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

// GET /episodes/:id/merges — 成片列表(全部拼接记录,新的在前)
app.get('/episodes/:id/merges', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
  merges.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return success(c, merges.slice(0, 30).map(toSnakeCase))
})

export default app
