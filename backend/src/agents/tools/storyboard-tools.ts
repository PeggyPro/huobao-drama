/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema, type DB } from '../../db/index.js'
import { storyboardFields, saveStoryboardBatch } from '../../services/storyboard-save.js'
import { assertContinuityCapability, parseContinuityPlan } from '../../services/continuity-contract.js'
import { getConfigById, getActiveConfig } from '../../services/ai.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'

type Session = Pick<DB, 'select' | 'insert' | 'update' | 'delete'>
function syncStoryboardCharacters(storyboardId: number, characterIds: number[], tx: Session) {
  tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
  for (const characterId of new Set(characterIds.filter(Boolean))) tx.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
}
function syncStoryboardProps(storyboardId: number, propIds: number[], tx: Session) {
  tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
  for (const propId of new Set(propIds.filter(Boolean))) tx.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
}
function validateStoryboardBindings(episodeId: number, dramaId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds: number[] | undefined, tx: Session) {
  const scenes = new Set(tx.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(link => link.sceneId))
  const characters = new Set(tx.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(link => link.characterId))
  const props = new Set(tx.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all().map(link => link.propId))
  if (sceneId != null) {
    const scene = tx.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).get()
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    if (!scenes.has(sceneId)) tx.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() }).run()
  }
  for (const characterId of new Set(characterIds || [])) {
    const character = tx.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    if (!character || character.dramaId !== dramaId || character.deletedAt) throw new Error(`character_id ${characterId} 不属于当前项目`)
    if (!characters.has(characterId)) tx.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() }).run()
  }
  for (const propId of new Set(propIds || [])) {
    const prop = tx.select().from(schema.props).where(eq(schema.props.id, propId)).get()
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) throw new Error(`prop_id ${propId} 不属于当前项目`)
    if (!props.has(propId)) tx.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() }).run()
  }
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
          continuity_revision: sb.continuityRevision,
          continuity_plan: parseContinuityPlan(sb.continuityPlan),
        }
      }))

    const videoConfig = ep.videoConfigId
      ? await getConfigById(ep.videoConfigId)
      : await getActiveConfig('video').catch(() => null)
    const supportedModes = (['independent', 'tail_frame', 'motion_context'] as const).filter(mode => {
      try { assertContinuityCapability(mode, videoConfig?.provider || '', videoConfig?.model || ''); return true }
      catch { return false }
    })
    const payload = {
      video_model: { provider: videoConfig?.provider || '', model: videoConfig?.model || '', supported_modes: supportedModes },
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    // Some compatible gateways emit JSON boolean arguments as strings. Convert only
    // the two explicit literals: generic boolean coercion would turn "false" into true.
    replace_existing: z.union([z.boolean(), z.enum(['true', 'false'])])
      .transform(value => value === true || value === 'true').optional(),
    storyboards: z.array(storyboardFields).min(1).max(8),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    if (storyboards.some(shot => shot.continuity && shot.continuity.mode !== 'independent')) {
      const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
      const config = episode?.videoConfigId ? await getConfigById(episode.videoConfigId) : await getActiveConfig('video').catch(() => null)
      for (const shot of storyboards) if (shot.continuity) assertContinuityCapability(shot.continuity.mode, config?.provider || '', config?.model || '')
    }
    logTaskProgress('StoryboardTool', 'save-begin', {
      episodeId,
      dramaId,
      replaceExisting: replace_existing === true,
      count: storyboards.length,
      shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    const saved = saveStoryboardBatch(episodeId, dramaId, storyboards, replace_existing === true)
    logTaskSuccess('StoryboardTool', 'save-complete', {
      episodeId, count: saved.count, totalDuration: saved.total_duration,
    })
    return saved
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    return db.transaction(tx => {
    const storyboard = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).get()
    if (!storyboard || storyboard.deletedAt || storyboard.episodeId !== episodeId) return { error: `Storyboard ${storyboard_id} not found in current episode` }

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const currentCharacterIds = 'character_ids' in fields
      ? fields.character_ids
      : tx.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
          .map(link => link.characterId)

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : tx.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)).all()
          .map(link => link.propId)

    validateStoryboardBindings(
      episodeId,
      dramaId,
      'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
      currentCharacterIds,
      currentPropIds,
      tx,
    )

    const updates: Record<string, any> = { updatedAt: now(), continuityRevision: storyboard.continuityRevision + 1 }
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    tx.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
    if ('character_ids' in fields) syncStoryboardCharacters(storyboard_id, fields.character_ids || [], tx)
    if ('prop_ids' in fields) syncStoryboardProps(storyboard_id, fields.prop_ids || [], tx)
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
    })
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
