import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, schema, getInsertId } from '../db/index.js'
import { now } from '../utils/response.js'
import { continuitySuggestionSchema, parseContinuityPlan } from './continuity-contract.js'
import { assertEpisodeStructureEditable, buildContinuityUpdate, markChangedContinuityAdjacency } from './continuity-plans.js'

export const storyboardFields = z.object({
  shot_number: z.number().int().positive(),
  title: z.string().optional(), shot_type: z.string().optional(), angle: z.string().optional(),
  movement: z.string().optional(), location: z.string().optional(), time: z.string().optional(),
  description: z.string().optional(), result: z.string().optional(), atmosphere: z.string().optional(),
  image_prompt: z.string().optional(), video_prompt: z.string().optional(), bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(), duration: z.number().positive().optional(),
  scene_id: z.number().int().positive().nullable().optional(),
  character_ids: z.array(z.number().int().positive()).optional(),
  prop_ids: z.array(z.number().int().positive()).optional(),
  continuity: continuitySuggestionSchema.omit({ source_storyboard_id: true }).extend({
    source_shot_number: z.number().int().positive().nullable().optional(),
  }).optional(),
})

/** Validation and all writes share one synchronous SQLite transaction. */
export function saveStoryboardBatch(episodeId: number, dramaId: number, input: z.infer<typeof storyboardFields>[], replaceExisting = false) {
  const items = z.array(storyboardFields).min(1).max(8).parse(input)
  if (new Set(items.map(item => item.shot_number)).size !== items.length) throw new Error('同一批分镜号不能重复')
  return db.transaction(tx => {
    const episode = tx.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    if (!episode || episode.deletedAt || episode.dramaId !== dramaId) throw new Error('当前集不属于指定项目')
    assertEpisodeStructureEditable(episodeId, tx)
    const previous = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
    const order = [...new Set([
      ...(replaceExisting ? [] : previous.filter(shot => !shot.deletedAt).map(shot => shot.storyboardNumber)),
      ...items.map(item => item.shot_number),
    ])].sort((a, b) => a - b)

    // Check every binding and every proposed source BEFORE clearing or inserting anything.
    for (const item of items) {
      if (item.scene_id != null) {
        const scene = tx.select().from(schema.scenes).where(eq(schema.scenes.id, item.scene_id)).get()
        if (!scene || scene.deletedAt || scene.dramaId !== dramaId) throw new Error(`scene_id ${item.scene_id} 不属于当前项目`)
      }
      for (const id of item.character_ids || []) {
        const character = tx.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
        if (!character || character.deletedAt || character.dramaId !== dramaId) throw new Error(`character_id ${id} 不属于当前项目`)
      }
      for (const id of item.prop_ids || []) {
        const prop = tx.select().from(schema.props).where(eq(schema.props.id, id)).get()
        if (!prop || prop.deletedAt || prop.dramaId !== dramaId) throw new Error(`prop_id ${id} 不属于当前项目`)
      }
      if (item.continuity) {
        const plan = item.continuity
        const predecessor = order[order.indexOf(item.shot_number) - 1]
        if (plan.mode === 'independent' && plan.source_shot_number != null) throw new Error('独立生成不能绑定接续来源')
        if (plan.mode !== 'independent' && (!predecessor || plan.source_shot_number !== predecessor)) throw new Error('接续来源必须是本集紧邻的前一段，首段必须独立生成')
        if (plan.mode !== 'independent' && ['scene_change', 'time_change'].includes(plan.relation)) throw new Error('换场景或换时间请使用独立生成')
      }
    }
    const ts = now()
    if (replaceExisting) {
      for (const shot of previous) {
        tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, shot.id)).run()
        tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, shot.id)).run()
      }
      tx.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
    }
    const shotIds = new Map((replaceExisting ? [] : previous.filter(shot => !shot.deletedAt)).map(shot => [shot.storyboardNumber, shot.id]))
    const sceneIds = new Set(tx.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(link => link.sceneId))
    const characterIds = new Set(tx.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(link => link.characterId))
    const propIds = new Set(tx.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all().map(link => link.propId))
    for (const item of items) {
      if (item.scene_id != null && !sceneIds.has(item.scene_id)) {
        tx.insert(schema.episodeScenes).values({ episodeId, sceneId: item.scene_id, createdAt: ts }).run()
        sceneIds.add(item.scene_id)
      }
      for (const id of item.character_ids || []) if (!characterIds.has(id)) {
        tx.insert(schema.episodeCharacters).values({ episodeId, characterId: id, createdAt: ts }).run()
        characterIds.add(id)
      }
      for (const id of item.prop_ids || []) if (!propIds.has(id)) {
        tx.insert(schema.episodeProps).values({ episodeId, propId: id, createdAt: ts }).run()
        propIds.add(id)
      }
      const values = {
        title: item.title, shotType: item.shot_type, angle: item.angle, movement: item.movement,
        location: item.location, time: item.time, description: item.description, result: item.result,
        atmosphere: item.atmosphere, imagePrompt: item.image_prompt, videoPrompt: item.video_prompt,
        bgmPrompt: item.bgm_prompt, soundEffect: item.sound_effect, sceneId: item.scene_id,
        duration: item.duration ?? 10, updatedAt: ts,
      }
      let id = shotIds.get(item.shot_number)
      if (id != null) {
        const old = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()!
        tx.update(schema.storyboards).set({ ...values, continuityRevision: old.continuityRevision + 1 }).where(eq(schema.storyboards.id, id)).run()
      } else {
        id = getInsertId(tx.insert(schema.storyboards).values({ ...values, episodeId, storyboardNumber: item.shot_number, createdAt: ts }).run())
        shotIds.set(item.shot_number, id)
      }
      tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
      tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id)).run()
      for (const characterId of new Set(item.character_ids || [])) tx.insert(schema.storyboardCharacters).values({ storyboardId: id, characterId }).run()
      for (const propId of new Set(item.prop_ids || [])) tx.insert(schema.storyboardProps).values({ storyboardId: id, propId }).run()
    }
    // All IDs now exist, including sources earlier in this same batch.
    for (const item of items) {
      if (!item.continuity) continue
      const id = shotIds.get(item.shot_number)!
      const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()!
      const { source_shot_number, ...suggestion } = item.continuity
      const plan = parseContinuityPlan({ ...suggestion, origin: 'ai', source_storyboard_id: source_shot_number == null ? null : shotIds.get(source_shot_number) })
      const update = buildContinuityUpdate(id, { continuity_plan: plan, continuity_revision: shot.continuityRevision }, 'ai', tx)
      tx.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, id)).run()
    }
    // An inserted segment can invalidate the next segment's previously adjacent source.
    // Preserve the original source and manual choice, but require review instead of redirecting it.
    markChangedContinuityAdjacency(episodeId, tx)
    const totalDuration = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter(shot => !shot.deletedAt).reduce((sum, shot) => sum + (shot.duration || 0), 0)
    tx.update(schema.episodes).set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts }).where(eq(schema.episodes.id, episodeId)).run()
    return { message: `Saved ${items.length} storyboards`, count: items.length, total_duration: totalDuration }
  })
}
