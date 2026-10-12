import { Hono, type Context } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema, type DB } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskSuccess } from '../utils/task-logger.js'
import { getStoryboardContinuityFrame } from '../services/storyboard-continuity.js'
import { blockingVideoTask } from '../services/video-task-input.js'
import { assertEpisodeStructureEditable, buildContinuityUpdate, ContinuityConflict, markChangedContinuityAdjacency } from '../services/continuity-plans.js'

type Session = Pick<DB, 'select' | 'insert' | 'update' | 'delete'>
const app = new Hono()
function failure(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof ContinuityConflict ? c.json({ code: 409, message }, 409) : badRequest(c, message)
}
function characterIds(id: number, session: Session = db) {
  return session.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).all().map(link => link.characterId)
}
function propIds(id: number, session: Session = db) {
  return session.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id)).all().map(link => link.propId)
}
function validateBindings(episodeId: number, sceneId: number | null | undefined, characters: number[], props: number[], session: Session) {
  const scenes = new Set(session.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(link => link.sceneId))
  const allowedCharacters = new Set(session.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(link => link.characterId))
  const allowedProps = new Set(session.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all().map(link => link.propId))
  if (sceneId != null && !scenes.has(sceneId)) throw new Error('scene_id 必须来自当前集已关联场景')
  if (!Array.isArray(characters) || characters.some(id => !allowedCharacters.has(id))) throw new Error('character_ids 必须来自当前集已关联角色')
  if (!Array.isArray(props) || props.some(id => !allowedProps.has(id))) throw new Error('prop_ids 必须来自当前集已关联道具')
}
function syncBindings(id: number, body: Record<string, any>, session: Session) {
  if ('character_ids' in body) {
    session.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
    for (const characterId of new Set<number>(body.character_ids || [])) session.insert(schema.storyboardCharacters).values({ storyboardId: id, characterId }).run()
  }
  if ('prop_ids' in body) {
    session.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id)).run()
    for (const propId of new Set<number>(body.prop_ids || [])) session.insert(schema.storyboardProps).values({ storyboardId: id, propId }).run()
  }
}
function responseShot(id: number) {
  const shot = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()!
  return { ...toSnakeCase(shot), character_ids: characterIds(id), prop_ids: propIds(id) }
}
app.post('/', async c => {
  try {
    const body = await c.req.json()
    const id = db.transaction(tx => {
      const episode = tx.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).get()
      if (!episode || episode.deletedAt) throw new Error('剧集不存在')
      assertEpisodeStructureEditable(episode.id, tx)
      validateBindings(episode.id, body.scene_id, body.character_ids || [], body.prop_ids || [], tx)
      const number = body.storyboard_number ?? 1
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error('分镜序号必须为正整数')
      if (tx.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, episode.id), eq(schema.storyboards.storyboardNumber, number), isNull(schema.storyboards.deletedAt))).get()) throw new Error('分镜序号已存在')
      const id = getInsertId(tx.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: number,
        title: body.title, description: body.description, sceneId: body.scene_id, duration: body.duration || 10, createdAt: now(), updatedAt: now() }).run())
      syncBindings(id, body, tx)
      if ('continuity_plan' in body || 'transition_config' in body) tx.update(schema.storyboards).set(buildContinuityUpdate(id, { ...body, continuity_revision: 0 }, 'manual', tx)).where(eq(schema.storyboards.id, id)).run()
      markChangedContinuityAdjacency(episode.id, tx)
      return id
    })
    return created(c, responseShot(id))
  } catch (error) { return failure(c, error) }
})
app.post('/:id/continuity-frame', async c => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) return badRequest(c, '分镜 ID 无效')
  try {
    const raw = await c.req.text(), body = raw.trim() ? JSON.parse(raw) : {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须为 JSON 对象')
    if ('source_task_id' in body && (!Number.isSafeInteger(body.source_task_id) || body.source_task_id <= 0)) {
      throw new Error('source_task_id 必须为正整数')
    }
    return success(c, await getStoryboardContinuityFrame(id, body.source_task_id))
  } catch (error) { return failure(c, error) }
})
app.put('/:id', async c => {
  try {
    const id = Number(c.req.param('id')), body = await c.req.json()
    db.transaction(tx => {
      const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
      if (!shot || shot.deletedAt) throw new Error('镜头不存在')
      if (body.continuity_revision != null && body.continuity_revision !== shot.continuityRevision) throw new ContinuityConflict('分镜已更新，请刷新后再保存')
      const updates: Record<string, any> = { updatedAt: now(), continuityRevision: shot.continuityRevision+1 }
      const fieldMap: Record<string, string> = { title: 'title', description: 'description', shot_type: 'shotType', angle: 'angle', movement: 'movement', duration: 'duration',
        video_prompt: 'videoPrompt', image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location', time: 'time', atmosphere: 'atmosphere', result: 'result', bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect' }
      for (const [key, field] of Object.entries(fieldMap)) if (key in body) updates[field] = body[key]
      if ('continuity_plan' in body || 'transition_config' in body) Object.assign(updates, buildContinuityUpdate(id, body, 'manual', tx))
      if ('storyboard_number' in body) {
        assertEpisodeStructureEditable(shot.episodeId, tx)
        if (!Number.isSafeInteger(body.storyboard_number) || body.storyboard_number <= 0) throw new Error('分镜序号必须为正整数')
        const duplicate = tx.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, shot.episodeId), eq(schema.storyboards.storyboardNumber, body.storyboard_number), isNull(schema.storyboards.deletedAt))).get()
        if (duplicate && duplicate.id !== id) throw new Error('分镜序号已存在')
        updates.storyboardNumber = body.storyboard_number
      }
      if ('video_url' in body) {
        if (blockingVideoTask(id)) throw new ContinuityConflict('本段有未结束的视频任务，请完成、核查或取消后再切换主视频')
        updates.videoUrl = body.video_url || null
        updates.videoTaskId = null
        updates.pendingVideoTaskId = null
        if (body.video_task_id != null) {
          const task = tx.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(body.video_task_id))).get()
          if (!task || task.deletedAt || task.type !== 'video' || task.storyboardId !== id || task.status !== 'completed' || task.localPath !== body.video_url) throw new Error('视频必须对应当前分镜已完成的任务版本')
          updates.videoTaskId = task.id
        }
      }
      validateBindings(shot.episodeId, 'scene_id' in body ? body.scene_id : shot.sceneId,
        'character_ids' in body ? body.character_ids : characterIds(id, tx), 'prop_ids' in body ? body.prop_ids : propIds(id, tx), tx)
      tx.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id)).run()
      syncBindings(id, body, tx)
      if ('storyboard_number' in body) markChangedContinuityAdjacency(shot.episodeId, tx)
    })
    logTaskSuccess('StoryboardAPI', 'update', { storyboardId: id, fields: Object.keys(body) })
    return success(c, responseShot(id))
  } catch (error) { return failure(c, error) }
})
app.delete('/:id', c => {
  try {
    const id = Number(c.req.param('id'))
    db.transaction(tx => {
      const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
      if (!shot || shot.deletedAt) throw new Error('镜头不存在')
      assertEpisodeStructureEditable(shot.episodeId, tx)
      tx.update(schema.storyboards).set({ deletedAt: now(), updatedAt: now(), continuityRevision: shot.continuityRevision+1 }).where(eq(schema.storyboards.id, id)).run()
      markChangedContinuityAdjacency(shot.episodeId, tx)
    })
    return success(c)
  } catch (error) { return failure(c, error) }
})
export default app
