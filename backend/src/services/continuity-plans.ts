import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema, type DB } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseContinuityPlan, transitionConfigSchema, validateContinuitySource, type ContinuityPlan } from './continuity-contract.js'

type Session = Pick<DB, 'select' | 'update'>
export class ContinuityConflict extends Error { readonly status = 409 }
export const UNFINISHED_TASK_STATUSES = ['queued', 'processing', 'downloading', 'blocked']

export function assertEpisodeStructureEditable(episodeId: number, session: Session = db) {
  const tasks = session.select({ id: schema.sysTask.id }).from(schema.sysTask)
    .innerJoin(schema.storyboards, eq(schema.sysTask.storyboardId, schema.storyboards.id))
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.sysTask.deletedAt), inArray(schema.sysTask.status, UNFINISHED_TASK_STATUSES))).all()
  if (tasks.length) throw new ContinuityConflict('本集存在未完成的生成任务，请先取消任务再删除、重排或重新拆分')
}

export function buildContinuityUpdate(storyboardId: number, input: {
  continuity_plan?: unknown
  transition_config?: unknown
  continuity_revision?: unknown
}, origin: 'manual' | 'ai' = 'manual', session: Session = db) {
  const shot = session.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).get()
  if (!shot || shot.deletedAt) throw new Error('分镜不存在')
  if (!Number.isSafeInteger(input.continuity_revision) || input.continuity_revision !== shot.continuityRevision) {
    throw new ContinuityConflict('分镜已被更新，请刷新后重新确认衔接策略')
  }
  const updates: { continuityPlan?: string; transitionConfig?: string; continuityRevision: number; updatedAt: string } = {
    continuityRevision: shot.continuityRevision + 1, updatedAt: now(),
  }
  if ('continuity_plan' in input) {
    const proposed = parseContinuityPlan(input.continuity_plan)
    const siblings = session.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, shot.episodeId)).all()
    validateContinuitySource(shot, siblings, proposed)
    const current = parseContinuityPlan(shot.continuityPlan)
    const { version: _version, origin: _origin, suggestion: _suggestion, ...suggestion } = proposed
    const plan: ContinuityPlan = origin === 'ai'
      ? current.origin === 'manual' ? { ...current, suggestion } : { ...proposed, origin: 'ai', suggestion }
      : { ...proposed, origin: 'manual', suggestion: current.suggestion }
    updates.continuityPlan = JSON.stringify(plan)
  }
  if ('transition_config' in input) updates.transitionConfig = JSON.stringify(transitionConfigSchema.parse(input.transition_config))
  return updates
}

export function saveContinuityPlans(episodeId: number, items: { storyboard_id: number; continuity_revision: number; continuity_plan: unknown }[]) {
  if (!items.length) throw new Error('没有待保存的衔接策略')
  if (new Set(items.map(item => item.storyboard_id)).size !== items.length) throw new Error('不能重复保存同一分镜的衔接策略')
  return db.transaction(tx => {
    // Validate the entire batch, including ownership and revisions, before writing any row.
    const updates = items.map(item => {
      const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, item.storyboard_id)).get()
      if (!shot || shot.deletedAt || shot.episodeId !== episodeId) throw new Error('衔接策略必须属于当前集有效分镜')
      return { id: shot.id, update: buildContinuityUpdate(shot.id, item, 'ai', tx) }
    })
    for (const { id, update } of updates) tx.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, id)).run()
    return { count: updates.length, storyboard_ids: updates.map(item => item.id) }
  })
}

export function markChangedContinuityAdjacency(episodeId: number, session: Session = db) {
  const siblings = session.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
  for (const shot of siblings.filter(item => !item.deletedAt)) {
    const plan = parseContinuityPlan(shot.continuityPlan)
    try { validateContinuitySource(shot, siblings, plan) }
    catch {
      session.update(schema.storyboards).set({
        continuityPlan: JSON.stringify({ ...plan, needs_review: true, reason: '分镜顺序或来源已改变，请重新确认接续来源' }),
        continuityRevision: shot.continuityRevision + 1, updatedAt: now(),
      }).where(eq(schema.storyboards.id, shot.id)).run()
    }
  }
}
