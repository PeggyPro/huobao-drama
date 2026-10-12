import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { ContinuityConflict } from './continuity-plans.js'
import { activeVideoStates, blockingVideoTask, frozenVideoConfig, jsonRecord, prepareVideoInputs, stableHash, storyboardFingerprint, type JsonRecord } from './video-task-input.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'

export type VideoTask = typeof schema.sysTask.$inferSelect
const LEASE_MS = 60_000
const concurrency = Math.max(1, Math.min(4, Number(process.env.COMFYUI_SUBMIT_CONCURRENCY) || 2))
let timer: ReturnType<typeof setInterval> | undefined
let pumping = false
const running = new Set<number>()
export function getVideoTask(id: number): VideoTask | undefined { return db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get() }
export class LostVideoLease extends Error { constructor() { super('任务已取消、删除或交由其他工作进程接管') } }
export function requireVideoLease(id: number, token: string): VideoTask {
  const task = getVideoTask(id)
  if (!task || task.deletedAt || task.workerToken !== token || !activeVideoStates.includes(task.status || '') || !(Date.parse(task.leaseExpiresAt || '') > Date.now())) throw new LostVideoLease()
  return task
}
export function updateLeasedVideo(id: number, token: string, values: Partial<typeof schema.sysTask.$inferInsert>): VideoTask {
  return db.transaction(tx => {
    requireVideoLease(id, token)
    const row = tx.update(schema.sysTask).set({ ...values, updatedAt: now() }).where(eq(schema.sysTask.id, id)).returning().get()
    if (!row) throw new LostVideoLease()
    return row
  })
}
export async function previewVideoBatch(body: JsonRecord) {
  if (!Number.isInteger(body.episode_id) || body.episode_id <= 0) throw new Error('episode_id 必须为有效剧集 ID')
  const result = await prepareVideoInputs(body.tasks, body.episode_id)
  return { items: result.items, blockers: result.blockers }
}

function requestIdentity(key: unknown): string {
  if (key == null) return randomUUID()
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_.:-]{8,160}$/.test(key)) throw new Error('request_key 必须是8–160位字母、数字、点、冒号或连字符')
  return key
}
function existingBatch(batchId: string, hash: string) {
  const rows = db.select().from(schema.sysTask).where(eq(schema.sysTask.batchId, batchId)).all()
  if (!rows.length) return null
  const originals = rows.filter(row => !row.retryOfTaskId)
  if (!originals.length || originals.some(row => row.requestHash !== hash)) throw new ContinuityConflict('同一 request_key 已用于不同输入，请刷新后重新提交')
  return { batch_id: batchId, task_ids: originals.map(row => row.id) }
}
export async function enqueueVideoBatch(body: JsonRecord, single = false) {
  if (!single && (!Number.isInteger(body.episode_id) || body.episode_id <= 0)) throw new Error('episode_id 必须为有效剧集 ID')
  const batchId = `video:${requestIdentity(body.request_key)}`
  const hash = stableHash({ episode_id: body.episode_id, tasks: body.tasks })
  const prior = existingBatch(batchId, hash)
  if (prior) return prior
  const result = await prepareVideoInputs(body.tasks, body.episode_id)
  if (result.blockers.length) throw new ContinuityConflict(result.blockers.join('\n'))
  const ordered = result.prepared.sort((a,b) => a.preview.storyboard_number-b.preview.storyboard_number)
  const enqueued = db.transaction(tx => {
    const duplicate = existingBatch(batchId, hash)
    if (duplicate) return duplicate
    const ids = new Map<number, number>(), taskIds: number[] = []
    for (const item of ordered) {
      if (item.storyboardId && storyboardFingerprint(item.storyboardId) !== item.params.storyboardFingerprint) throw new ContinuityConflict('预检期间分镜已变更，请刷新后重试')
      if (item.storyboardId) {
        const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, item.storyboardId)).get()!
        if (shot.continuityRevision !== item.params.storyboardRevision) throw new ContinuityConflict('预检期间分镜已变更，请刷新后重试')
        if (blockingVideoTask(shot.id)) throw new ContinuityConflict('该分镜已有未结束任务，请等待、核查上游或取消后再提交')
      }
      const dependency = item.preview.depends_on_storyboard_id ? ids.get(item.preview.depends_on_storyboard_id) : item.params.waitForSourceTask ? item.params.continuitySourceTaskId : null
      if (item.preview.depends_on_storyboard_id && !dependency) throw new Error('批量来源依赖未找到，未创建任何任务')
      const requestKey = `${batchId}:${item.storyboardId || 'single'}`
      const params: JsonRecord = { ...item.params, requestKey,
        continuitySourceTaskId: dependency ?? item.params.continuitySourceTaskId ?? null,
        __huobaoConfig: item.params.connection,
      }
      const id = getInsertId(tx.insert(schema.sysTask).values({ type: 'video', storyboardId: item.storyboardId, dramaId: item.dramaId,
        provider: item.config.provider, prompt: params.prompt, model: item.config.model, params: JSON.stringify(params),
        batchId, dependsOnTaskId: dependency || null, requestKey, requestHash: hash, status: 'queued', phase: dependency ? 'waiting_source' : 'queued',
        createdAt: now(), updatedAt: now(),
      }).run())
      taskIds.push(id)
      if (item.storyboardId) {
        ids.set(item.storyboardId, id)
        tx.update(schema.storyboards).set({ pendingVideoTaskId: id, updatedAt: now() }).where(eq(schema.storyboards.id, item.storyboardId)).run()
      }
    }
    return { batch_id: batchId, task_ids: taskIds }
  })
  logTaskProgress('VideoQueue', 'enqueued', { batchId, count: enqueued.task_ids.length })
  if (process.env.VIDEO_QUEUE_AUTOSTART !== 'false') startVideoQueue()
  wakeVideoQueue()
  return enqueued
}
export async function enqueueSingleVideo(input: JsonRecord) {
  const result = await enqueueVideoBatch({ request_key: input.request_key, tasks: [input] }, true)
  return result.task_ids[0]!
}
function clearPending(task: VideoTask) {
  if (task.storyboardId) db.update(schema.storyboards).set({ pendingVideoTaskId: null })
    .where(and(eq(schema.storyboards.id, task.storyboardId), eq(schema.storyboards.pendingVideoTaskId, task.id))).run()
}
function blockDescendants(parentId: number, reason: string) {
  const children = db.select().from(schema.sysTask).where(eq(schema.sysTask.dependsOnTaskId, parentId)).all()
  for (const child of children) {
    if (child.deletedAt || child.taskId || ['submitting', 'submission_unknown'].includes(child.phase || '') || !['queued','blocked','processing'].includes(child.status || '')) continue
    db.update(schema.sysTask).set({ status: 'blocked', phase: 'dependency_failed', blockedReason: reason, workerToken: null, leaseExpiresAt: null, updatedAt: now() }).where(eq(schema.sysTask.id, child.id)).run()
    blockDescendants(child.id, `来源任务 #${child.id} 被阻止：${reason}`)
  }
}
export function cancelVideoTask(id: number, deleting = false) {
  return db.transaction(tx => {
    const task = getVideoTask(id)
    if (!task || task.deletedAt) throw new Error('任务不存在')
    if (task.type !== 'video') throw new Error('此操作仅用于视频任务')
    if (!deleting && task.status === 'completed') throw new Error('已完成的任务不能取消')
    tx.update(schema.sysTask).set({ ...(task.status !== 'completed' ? { status: 'cancelled', phase: 'cancelled', errorMsg: '用户取消任务；上游已提交任务可能继续运行，结果不会回写' } : {}),
      ...(deleting ? { deletedAt: now() } : {}), workerToken: null, leaseExpiresAt: null, updatedAt: now(),
    }).where(eq(schema.sysTask.id, id)).run()
    clearPending(task)
    blockDescendants(id, `来源任务 #${id} 已${deleting ? '删除' : '取消'}`)
    return { id, status: task.status === 'completed' ? 'completed' : 'cancelled' }
  })
}
function continueVideoDependants(parentId: number, replacementId: number) {
  for (const child of db.select().from(schema.sysTask).where(eq(schema.sysTask.dependsOnTaskId, parentId)).all()) {
    if (child.deletedAt || child.taskId || child.workerToken || !['queued','blocked'].includes(child.status || '') || child.phase === 'submission_unknown') continue
    const params = jsonRecord(child.params)
    params.continuitySourceTaskId = replacementId
    delete params.sourceVideo; delete params.continuitySourceArtifact; delete params.resolvedFirstFrameUrl
    db.update(schema.sysTask).set({ dependsOnTaskId: replacementId, params: JSON.stringify(params), status: 'queued', phase: 'waiting_source',
      errorMsg: null, blockedReason: null, updatedAt: now() }).where(eq(schema.sysTask.id, child.id)).run()
    continueVideoDependants(child.id, child.id)
  }
}
export async function retryVideoTask(id: number, continueDependents = false) {
  const old = getVideoTask(id)
  if (!old || old.deletedAt || old.type !== 'video') throw new Error('视频任务不存在')
  if (jsonRecord(old.params).resumedFromFailure && [...activeVideoStates, 'completed'].includes(old.status || '')) return { id: old.id, retry_of_task_id: old.retryOfTaskId }
  const existingRetry = db.select().from(schema.sysTask).where(eq(schema.sysTask.retryOfTaskId, id)).all().find(row => !row.deletedAt && [...activeVideoStates, 'completed'].includes(row.status || ''))
  if (existingRetry) return { id: existingRetry.id, retry_of_task_id: id }
  if (!['failed','blocked','cancelled'].includes(old.status || '')) throw new Error('只能重试失败、被阻止或已取消的任务')
  if (old.phase === 'submission_unknown') throw new ContinuityConflict('上游是否接受请求尚未确认，禁止盲目重复提交；请先确认上游队列与历史记录')
  const params = jsonRecord(old.params)
  if (params.queueVersion !== 1) throw new Error('旧任务没有完整输入快照，请从分镜重新生成')
  if (old.storyboardId && storyboardFingerprint(old.storyboardId) !== params.storyboardFingerprint) throw new ContinuityConflict('分镜内容或衔接策略已更新，请从分镜重新生成')
  await frozenVideoConfig(params)
  const newId = db.transaction(tx => {
    const current = getVideoTask(id)
    if (current?.status !== old.status || current?.updatedAt !== old.updatedAt) throw new ContinuityConflict('任务状态已改变，请刷新')
    if (old.storyboardId) {
      const pending = blockingVideoTask(old.storyboardId)
      if (pending && pending.id !== old.id) throw new ContinuityConflict('该分镜已有未结束的生成任务')
    }
    if (old.taskId && old.status !== 'cancelled' && ['polling', 'downloading'].includes(params.failurePhase || '')) {
      tx.update(schema.sysTask).set({ status: 'queued', phase: params.failurePhase, errorMsg: null, blockedReason: null,
        params: JSON.stringify({ ...params, resumedFromFailure: true }), workerToken: null, leaseExpiresAt: null, updatedAt: now() }).where(eq(schema.sysTask.id, old.id)).run()
      if (old.storyboardId) tx.update(schema.storyboards).set({ pendingVideoTaskId: old.id }).where(eq(schema.storyboards.id, old.storyboardId)).run()
      if (continueDependents) continueVideoDependants(old.id, old.id)
      return old.id
    }
    const requestKey = randomUUID()
    const next: JsonRecord = { ...params, artifactUuid: randomUUID(), requestKey }
    delete next.resolvedFirstFrameUrl
    const newId = getInsertId(tx.insert(schema.sysTask).values({ type: 'video', storyboardId: old.storyboardId, dramaId: old.dramaId,
      provider: old.provider, prompt: old.prompt, model: old.model, params: JSON.stringify(next), batchId: old.batchId,
      dependsOnTaskId: old.dependsOnTaskId, requestKey, requestHash: stableHash(next), retryOfTaskId: old.id,
      status: 'queued', phase: old.dependsOnTaskId ? 'waiting_source' : 'queued', createdAt: now(), updatedAt: now(),
    }).run())
    if (old.storyboardId) tx.update(schema.storyboards).set({ pendingVideoTaskId: newId }).where(eq(schema.storyboards.id, old.storyboardId)).run()
    if (continueDependents) continueVideoDependants(old.id, newId)
    return newId
  })
  wakeVideoQueue()
  return { id: newId, retry_of_task_id: id }
}

/** Recheck an uncertain submission at its original endpoint. This function never submits a prompt. */
export async function reconcileVideoTask(id: number, continueDependents = false) {
  const task = getVideoTask(id)
  if (!task || task.deletedAt || task.type !== 'video') throw new Error('视频任务不存在')
  if (task.taskId && task.phase !== 'submission_unknown') return { id, reconciled: true, status: task.status }
  if (task.status !== 'blocked' || task.phase !== 'submission_unknown') throw new ContinuityConflict('仅待确认提交的任务需要核查上游')
  if (task.provider !== 'comfyui' || !task.requestKey) throw new ContinuityConflict('此任务没有可核查的 ComfyUI 请求标识，请人工核实上游记录')
  const params = jsonRecord(task.params)
  const config = await frozenVideoConfig(params)
  const { reconcileComfySubmission } = await import('./video-task-worker.js')
  const externalId = await reconcileComfySubmission(config, task.requestKey)
  if (!externalId) return { id, reconciled: false, status: 'blocked' }
  db.transaction(tx => {
    const current = getVideoTask(id)
    if (!current || current.deletedAt || current.status !== task.status || current.phase !== task.phase || current.updatedAt !== task.updatedAt) throw new ContinuityConflict('任务状态已改变，请刷新')
    tx.update(schema.sysTask).set({ taskId: externalId, status: 'queued', phase: 'polling', blockedReason: null, errorMsg: null,
      workerToken: null, leaseExpiresAt: null, updatedAt: now() }).where(eq(schema.sysTask.id, id)).run()
    if (task.storyboardId) {
      const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, task.storyboardId)).get()
      // A newer primary/pending version wins; recovering old output must not replace it.
      if (shot && !shot.deletedAt && (!shot.pendingVideoTaskId || shot.pendingVideoTaskId === id) && (!shot.videoTaskId || shot.videoTaskId < id)
        && storyboardFingerprint(shot.id) === params.storyboardFingerprint) tx.update(schema.storyboards).set({ pendingVideoTaskId: id }).where(eq(schema.storyboards.id, shot.id)).run()
    }
    if (continueDependents) continueVideoDependants(id, id)
  })
  wakeVideoQueue()
  return { id, reconciled: true, status: 'queued' }
}

/** Atomic lease claim, also used to exercise crash recovery without starting an HTTP server. */
export function claimVideoTask(id: number): string | null {
  return db.transaction(tx => {
    const task = getVideoTask(id)
    if (!task || task.deletedAt || !activeVideoStates.includes(task.status || '')) return null
    if (task.workerToken && Date.parse(task.leaseExpiresAt || '') > Date.now()) return null
    const params = jsonRecord(task.params)
    if (params.queueVersion !== 1) return null
    // Dependencies gate submission; accepted or uncertain jobs must still recover their original result.
    if (task.dependsOnTaskId && !task.taskId && task.phase !== 'downloading' && !['submitting', 'submission_unknown'].includes(task.phase || '')) {
      const parent = getVideoTask(task.dependsOnTaskId)
      if (!parent || parent.deletedAt || ['failed','cancelled','blocked'].includes(parent.status || '') || parent.phase === 'completed_stale') {
        tx.update(schema.sysTask).set({ status: 'blocked', phase: 'dependency_failed', blockedReason: `来源任务 #${task.dependsOnTaskId} 不可用，请重试来源并选择继续后续`, updatedAt: now() }).where(eq(schema.sysTask.id, id)).run()
        blockDescendants(id, `来源任务 #${id} 被阻止`)
        return null
      }
      if (parent.status !== 'completed') return null
    }
    const owned = tx.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), isNull(schema.sysTask.deletedAt))).all()
      .filter(row => row.workerToken && Date.parse(row.leaseExpiresAt || '') > Date.now()).length
    if (owned >= concurrency) return null
    const token = randomUUID()
    tx.update(schema.sysTask).set({ workerToken: token, leaseExpiresAt: new Date(Date.now()+LEASE_MS).toISOString(), status: task.status === 'downloading' ? 'downloading' : 'processing', updatedAt: now() }).where(eq(schema.sysTask.id, id)).run()
    return token
  })
}
export function finishVideoFailure(id: number, token: string, error: unknown) {
  if (error instanceof LostVideoLease) return
  try {
    const task = requireVideoLease(id, token)
    const message = error instanceof Error ? error.message : String(error)
    const uncertain = task.phase === 'submitting' || task.phase === 'submission_unknown'
    updateLeasedVideo(id, token, { status: uncertain ? 'blocked' : 'failed', phase: uncertain ? 'submission_unknown' : 'failed',
      params: JSON.stringify({ ...jsonRecord(task.params), failurePhase: task.phase }),
      errorMsg: message, blockedReason: uncertain ? '上游提交结果不确定，需核实队列/历史，禁止自动重复提交' : null, workerToken: null, leaseExpiresAt: null })
    clearPending(task)
    blockDescendants(id, `来源任务 #${id} ${uncertain ? '提交待确认' : '失败'}：${message}`)
    logTaskError('VideoQueue', 'failed', { id, error: message, uncertain })
  } catch (lost) { if (!(lost instanceof LostVideoLease)) throw lost }
}
export function publishVideoResult(id: number, token: string, localPath: string, resultUrl: string, artifacts: JsonRecord) {
  return db.transaction(tx => {
    const task = requireVideoLease(id, token), params = jsonRecord(task.params)
    const shot = task.storyboardId ? tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, task.storyboardId)).get() : null
    const sourceId = params.continuitySourceTaskId || task.dependsOnTaskId
    const source = sourceId ? getVideoTask(sourceId) : null
    const sourceValid = !sourceId || !!source && !source.deletedAt && source.status === 'completed' && source.phase !== 'completed_stale'
    const publish = sourceValid && !!shot && !shot.deletedAt && shot.pendingVideoTaskId === id && params.storyboardFingerprint != null && storyboardFingerprint(shot.id) === params.storyboardFingerprint
    tx.update(schema.sysTask).set({ localPath, resultUrl, artifacts: JSON.stringify(artifacts), status: 'completed',
      phase: shot && !publish ? 'completed_stale' : 'completed', errorMsg: shot && !publish ? '分镜输入、来源版本或当前任务已改变，结果已归档，未覆盖当前视频' : null,
      completedAt: now(), updatedAt: now(), workerToken: null, leaseExpiresAt: null }).where(eq(schema.sysTask.id, id)).run()
    if (publish) tx.update(schema.storyboards).set({ videoUrl: localPath, videoTaskId: id, pendingVideoTaskId: null, updatedAt: now() }).where(eq(schema.storyboards.id, shot.id)).run()
    else clearPending(task)
    if (shot && !publish) blockDescendants(id, '来源分镜已编辑，生成结果未成为当前视频')
    return { published: publish }
  })
}
export function wakeVideoQueue() { if (timer) void pumpVideoQueue().catch(error => logTaskError('VideoQueue', 'pump', { error: String(error) })) }
export async function pumpVideoQueue() {
  if (pumping) return
  pumping = true
  try {
    const tasks = db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), isNull(schema.sysTask.deletedAt))).all().sort((a,b) => a.id-b.id)
    for (const task of tasks) {
      if (running.size >= concurrency) break
      if (running.has(task.id)) continue
      const token = claimVideoTask(task.id)
      if (!token) continue
      running.add(task.id)
      const heartbeat = setInterval(() => {
        try { updateLeasedVideo(task.id, token, { leaseExpiresAt: new Date(Date.now()+LEASE_MS).toISOString() }) }
        catch { clearInterval(heartbeat) }
      }, LEASE_MS/3)
      heartbeat.unref()
      void import('./video-task-worker.js').then(module => module.runVideoTask(task.id, token)).catch(error => finishVideoFailure(task.id, token, error)).finally(() => {
        clearInterval(heartbeat); running.delete(task.id); wakeVideoQueue()
      })
    }
  } finally { pumping = false }
}
/** Adopt only known upstream jobs. Old interrupted submissions without an ID remain ambiguous. */
export function recoverLegacyVideoTasks() {
  db.transaction(tx => {
    const candidates = tx.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), isNull(schema.sysTask.deletedAt))).all()
      .filter(task => task.status === 'processing' || (task.status === 'failed' && task.errorMsg === '服务重启，生成任务中断，请重试'))
    for (const task of candidates) {
      const params = jsonRecord(task.params)
      if (params.queueVersion === 1) continue
      const saved = params.__huobaoConfig
      const config = saved?.baseUrl ? tx.select().from(schema.aiServiceConfigs).all().find(row => row.serviceType === 'video' && row.provider === saved.provider && row.baseUrl.replace(/\/+$/, '') === saved.baseUrl.replace(/\/+$/, '')) : null
      const requestKey = randomUUID()
      Object.assign(params, { queueVersion: 1, requestKey, artifactUuid: randomUUID(), configId: config?.id,
        connection: saved ? { ...saved, requiresAuth: config ? !!config.apiKey : true } : null,
        model: task.model, prompt: task.prompt, storyboardFingerprint: null,
      })
      tx.update(schema.sysTask).set({ params: JSON.stringify(params), requestKey,
        status: task.taskId ? 'queued' : 'blocked', phase: task.taskId ? 'polling' : 'submission_unknown',
        workerToken: null, leaseExpiresAt: null, errorMsg: null,
        blockedReason: task.taskId ? null : '旧任务未保存上游 ID，无法确定是否已经提交，禁止自动重复生成', updatedAt: now(),
      }).where(eq(schema.sysTask.id, task.id)).run()
    }
  })
}
export function startVideoQueue() {
  if (timer) return
  timer = setInterval(wakeVideoQueue, 1500); timer.unref(); wakeVideoQueue()
}
export function stopVideoQueue() { if (timer) clearInterval(timer); timer = undefined }
