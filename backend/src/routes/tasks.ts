import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateImage } from '../services/generation.js'
import { cancelVideoTask, enqueueSingleVideo, enqueueVideoBatch, previewVideoBatch, retryVideoTask, reconcileVideoTask } from '../services/video-queue.js'
import { ContinuityConflict } from '../services/continuity-plans.js'
import { logTaskError, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()
function failure(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  logTaskError('TaskAPI', 'request-failed', { error: message })
  return error instanceof ContinuityConflict ? c.json({ code: 409, message }, 409) : badRequest(c, message)
}

app.post('/batch/preview', async c => {
  try { return success(c, await previewVideoBatch(await c.req.json())) }
  catch (error) { return failure(c, error) }
})
app.post('/batch', async c => {
  try { return created(c, await enqueueVideoBatch(await c.req.json())) }
  catch (error) { return failure(c, error) }
})
app.post('/:id/retry', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    return created(c, await retryVideoTask(Number(c.req.param('id')), body.continue_dependents === true))
  } catch (error) { return failure(c, error) }
})
app.post('/:id/reconcile', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    return success(c, await reconcileVideoTask(Number(c.req.param('id')), body.continue_dependents === true))
  } catch (error) { return failure(c, error) }
})
app.post('/:id/cancel', async c => {
  try { return success(c, cancelVideoTask(Number(c.req.param('id')))) }
  catch (error) { return failure(c, error) }
})

// Existing single-image and single-video endpoint; videos share the persistent batch queue.
app.post('/', async c => {
  try {
    const body = await c.req.json()
    if (body.type !== 'image' && body.type !== 'video') return badRequest(c, 'type 必须为 image 或 video')
    let id: number
    if (body.type === 'video') id = await enqueueSingleVideo(body)
    else {
      if (!body.prompt) return badRequest(c, '提示词必填')
      let configId = body.config_id
      if (body.storyboard_id && configId == null) {
        const shot = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).get()
        const episode = shot ? db.select().from(schema.episodes).where(eq(schema.episodes.id, shot.episodeId)).get() : null
        configId = episode?.imageConfigId ?? undefined
      }
      id = await generateImage({ storyboardId: body.storyboard_id, dramaId: body.drama_id, sceneId: body.scene_id,
        characterId: body.character_id, propId: body.prop_id, prompt: body.prompt, model: body.model,
        size: body.size, referenceImages: body.reference_images, frameType: body.frame_type, configId })
    }
    const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type: body.type, provider: record?.provider })
    return created(c, record)
  } catch (error) { return failure(c, error) }
})
app.get('/:id', c => {
  const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(c.req.param('id')))).get()
  return success(c, row && !row.deletedAt ? row : null)
})
app.get('/', c => {
  const type = c.req.query('type'), storyboardId = c.req.query('storyboard_id'), dramaId = c.req.query('drama_id'), batchId = c.req.query('batch_id')
  let rows = db.select().from(schema.sysTask).all().filter(row => !row.deletedAt)
  if (type) rows = rows.filter(row => row.type === type)
  if (storyboardId) rows = rows.filter(row => row.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(row => row.dramaId === Number(dramaId))
  if (batchId) rows = rows.filter(row => row.batchId === batchId)
  return success(c, rows)
})
app.delete('/:id', c => {
  try {
    const id = Number(c.req.param('id'))
    const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    if (row?.type === 'video') cancelVideoTask(id, true)
    else db.delete(schema.sysTask).where(eq(schema.sysTask.id, id)).run()
    return success(c)
  } catch (error) { return failure(c, error) }
})
export default app
