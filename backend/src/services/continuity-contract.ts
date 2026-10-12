import { z } from 'zod'

export const continuityModeSchema = z.enum(['independent', 'tail_frame', 'motion_context'])
export const continuityRelationSchema = z.enum(['continuous_action', 'same_scene_cut', 'scene_change', 'time_change', 'unknown'])
const stateSchema = z.string().max(4000).default('')
export const continuitySuggestionSchema = z.object({
  mode: continuityModeSchema,
  relation: continuityRelationSchema.default('unknown'),
  source_storyboard_id: z.number().int().positive().nullable().default(null),
  reason: z.string().max(2000).default(''),
  needs_review: z.union([z.boolean(), z.enum(['true', 'false'])]).transform(value => value === true || value === 'true').default(false),
  start_state: stateSchema,
  end_state: stateSchema,
})
export const continuityPlanSchema = continuitySuggestionSchema.extend({
  version: z.literal(1).default(1),
  origin: z.enum(['ai', 'manual']).default('manual'),
  suggestion: continuitySuggestionSchema.nullable().default(null),
})
export type ContinuityPlan = z.infer<typeof continuityPlanSchema>
export type ContinuityMode = z.infer<typeof continuityModeSchema>

export const transitionConfigSchema = z.object({
  type: z.enum(['cut', 'dissolve', 'audio_fade']),
  duration_ms: z.number().finite().min(0).max(500).optional(),
}).transform(value => ({
  ...value,
  duration_ms: value.duration_ms ?? (value.type === 'dissolve' ? 250 : value.type === 'audio_fade' ? 30 : 0),
})).superRefine((value, ctx) => {
  if (value.type === 'cut' && value.duration_ms !== 0) ctx.addIssue({ code: 'custom', message: '直接切镜的重叠时长必须为 0' })
  if (value.type !== 'cut' && value.duration_ms <= 0) ctx.addIssue({ code: 'custom', message: '转场时长必须大于 0' })
  if (value.type === 'audio_fade' && value.duration_ms > 100) ctx.addIssue({ code: 'custom', message: '音频边缘淡化不能超过 100ms' })
})

export function parseContinuityPlan(value: unknown): ContinuityPlan {
  if (value == null || value === '') return continuityPlanSchema.parse({ mode: 'independent', origin: 'ai' })
  return continuityPlanSchema.parse(typeof value === 'string' ? JSON.parse(value) : value)
}

export interface ContinuityShot {
  id: number
  episodeId: number
  storyboardNumber: number
  deletedAt?: string | null
}

/** Requiring the immediate predecessor also makes cycles and cross-episode links impossible. */
export function validateContinuitySource(target: ContinuityShot, siblings: ContinuityShot[], plan: ContinuityPlan): void {
  const previous = siblings.filter(shot => shot.episodeId === target.episodeId && !shot.deletedAt && shot.storyboardNumber < target.storyboardNumber)
    .sort((a, b) => b.storyboardNumber - a.storyboardNumber)[0]
  if (plan.mode === 'independent') {
    if (plan.source_storyboard_id != null) throw new Error('独立生成不能绑定接续来源')
    return
  }
  if (!previous) throw new Error('第一段必须独立生成')
  if (plan.source_storyboard_id !== previous.id) throw new Error('接续来源必须是同一集紧邻的前一段')
  if (plan.relation === 'scene_change' || plan.relation === 'time_change') throw new Error('换场景或换时间请使用独立生成')
}

export function assertContinuityCapability(mode: ContinuityMode, provider: string, model: string): void {
  if (mode === 'independent') return
  const comfy = provider.toLowerCase() === 'comfyui'
  const h3 = /minimax[_-]?h3/i.test(model)
  const wan = /wan[._-]?2[._-]?2.*5b/i.test(model)
  if (mode === 'motion_context' && (!comfy || !h3)) throw new Error('动作上下文接续需要 ComfyUI MiniMax H3 模型')
  if (mode === 'tail_frame' && (!comfy || (!h3 && !wan))) throw new Error('尾帧接续需要支持首帧约束的 ComfyUI H3 或 Wan 2.2 5B 模型')
}

export function continuityPrompt(plan: ContinuityPlan, previousEndState?: string): string {
  const mode = plan.mode === 'motion_context' ? '延续前段的动作上下文，不重演前段动作或台词'
    : plan.mode === 'tail_frame' ? '从已绑定的前段尾帧姿态和构图开始，再执行后续动作'
      : '按当前段落的机位生成，保持同场景人物位置、视线和持物关系'
  return [
    '\n【段落衔接约束】', mode,
    previousEndState && `前段最后一个子镜头结束状态：${previousEndState}`,
    plan.start_state && `本段第一个子镜头开始状态：${plan.start_state}`,
    plan.end_state && `本段最后一个子镜头结束状态：${plan.end_state}`,
    '上述约束适用于段落交界；段落内部按分镜描述正常切换子镜头。',
  ].filter(Boolean).join('\n')
}
