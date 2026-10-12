import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { buildLanguageDirective } from '../agents/language.js'
import { CONTINUITY_RELATION_RULES } from '../agents/continuity-instructions.js'
import { storyboardTools } from '../agents/tools/storyboard-tools.js'
import { toolOutcome } from '../agents/chat.js'
import { getConfigById, getTextConfig, getActiveConfig } from './ai.js'
import { createTextModel } from './text-model.js'
import { assertContinuityCapability, continuitySuggestionSchema } from './continuity-contract.js'
import { ContinuityConflict, saveContinuityPlans } from './continuity-plans.js'
import { logTaskProgress } from '../utils/task-logger.js'

const running = new Set<number>()

/** This agent has no tools that can modify the script, prompt, shots, or videos. */
export async function analyzeEpisodeContinuity(episodeId: number, options: {
  model?: string; configId?: number; videoConfigId?: number; videoModel?: string
} = {}) {
  if (running.has(episodeId)) throw new ContinuityConflict('本集正在分析衔接，请等待当前分析完成')
  running.add(episodeId)
  try {
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    if (!episode || episode.deletedAt) throw new Error('剧集不存在')
    const shots = db.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt))).all()
    if (!shots.length) throw new Error('请先拆分分镜，再分析段落衔接')
    const expectedRevisions = new Map(shots.map(shot => [shot.id, shot.continuityRevision]))
    const saved = new Set<number>()
    const config = (options.configId ? await getConfigById(options.configId) : null) || await getTextConfig()
    const videoConfig = await (async () => {
      const id = options.videoConfigId ?? episode.videoConfigId
      return id ? await getConfigById(id) : await getActiveConfig('video').catch(() => null)
    })()
    const selectedVideoModel = options.videoModel || videoConfig?.model || ''
    const selectedVideoProvider = videoConfig?.provider || ''
    const supportedModes = (['independent', 'tail_frame', 'motion_context'] as const).filter(mode => {
      try { assertContinuityCapability(mode, selectedVideoProvider, selectedVideoModel); return true }
      catch { return false }
    })
    const requestContext = buildAgentRequestContext({ episodeId, dramaId: episode.dramaId, textConfigId: options.configId, modelOverride: options.model })
    // Analysis may use a temporarily selected model without changing the episode's saved model.
    // Show exactly the capabilities that saveContinuity validates for this request.
    const readStoryboardContext = createTool({
      id: 'read_storyboard_context',
      description: storyboardTools.readStoryboardContext.description,
      inputSchema: z.object({}),
      execute: async (input, context) => {
        const result = await storyboardTools.readStoryboardContext.execute!(input, context)
        if (!result || typeof result !== 'object' || 'error' in result) return result
        return { ...result, video_model: { provider: selectedVideoProvider, model: selectedVideoModel, supported_modes: supportedModes } }
      },
    })
    const saveContinuity = createTool({
      id: 'save_continuity',
      description: '只保存本集分镜衔接建议，保留人工选择，不改写分镜内容、提示词和视频。每批最多8段，必须处理所有目标分镜。',
      inputSchema: z.object({ items: z.array(z.object({
        storyboard_id: z.number().int().positive(), continuity_revision: z.number().int().nonnegative(),
        continuity_plan: continuitySuggestionSchema,
      })).min(1).max(8) }),
      execute: async ({ items }) => {
        try {
          for (const item of items) {
            if (expectedRevisions.get(item.storyboard_id) !== item.continuity_revision || saved.has(item.storyboard_id)) throw new ContinuityConflict('分镜已更新或已保存，请重新读取并分析')
            assertContinuityCapability(item.continuity_plan.mode, selectedVideoProvider, selectedVideoModel)
          }
          const result = saveContinuityPlans(episodeId, items)
          for (const id of result.storyboard_ids) saved.add(id)
          logTaskProgress('Continuity', 'saved', { episodeId, count: saved.size, total: shots.length })
          return result
        } catch (error) {
          return { error: true, message: error instanceof Error ? error.message : String(error) }
        }
      },
    })
    const agent = new Agent({
      id: 'continuity_planner', name: '段落衔接分析',
      model: createTextModel({ ...config, model: options.model || config.model }),
      instructions: `先调用 readStoryboardContext 阅读剧本及已有分镜。只分析相邻段落关系，不改写内容或视频。使用 saveContinuity 分批保存每个分镜的衔接建议，必须覆盖全部目标ID。这里使用 source_storyboard_id 实际ID，不使用 source_shot_number。保留读取的 continuity_revision。${CONTINUITY_RELATION_RULES}\n本任务仅调用 readStoryboardContext/saveContinuity，不调用拆分或其他保存工具。\n${buildLanguageDirective(requestContext.get('language') || 'zh')}`,
      tools: { readStoryboardContext, saveContinuity },
    })
    const stream = await agent.stream([{
      role: 'user', content: `请分析本集所有分镜的衔接关系并保存建议。目标ID：${shots.map(shot => shot.id).join(',')}。视频模型：${selectedVideoProvider || '未知'} / ${selectedVideoModel || '未知'}。请勿重复保存同一段。`,
    }], {
      requestContext, maxSteps: 20, toolCallConcurrency: 1,
      stopWhen: ({ steps }: { steps: Array<{ toolResults: readonly unknown[] }> }) => {
        let failures = 0
        for (const step of steps) for (const entry of step.toolResults) {
          failures = toolOutcome(entry).failed ? failures + 1 : 0
          if (failures >= 2) return true
        }
        return false
      },
    })
    const output = await stream.getFullOutput()
    if (output.error) throw output.error
    if (['error', 'length', 'tool-calls'].includes(output.finishReason || '')) throw new Error(`衔接分析未完成，已保存 ${saved.size}/${shots.length} 段`)
    if (saved.size !== shots.length) throw new Error(`衔接分析未完整保存：${saved.size}/${shots.length} 段，请刷新检查后重试`)
    return { count: saved.size, storyboard_ids: [...saved] }
  } finally { running.delete(episodeId) }
}
