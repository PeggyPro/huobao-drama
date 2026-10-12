export type ContinuityMode = 'independent' | 'tail_frame' | 'motion_context'
export type ContinuityRelation = 'continuous_action' | 'same_scene_cut' | 'scene_change' | 'time_change' | 'unknown'
export interface ContinuityChoice {
  mode: ContinuityMode
  relation: ContinuityRelation
  source_storyboard_id: number | null
  reason: string
  needs_review: boolean
  start_state: string
  end_state: string
}
export interface ContinuityPlan extends ContinuityChoice {
  version: 1
  origin: 'ai' | 'manual'
  suggestion: ContinuityChoice | null
}
export type TransitionType = 'cut' | 'dissolve' | 'audio_fade'
export interface TransitionConfig { type: TransitionType; duration_ms: number }
export interface BatchPreviewItem {
  storyboard_id: number
  storyboard_number: number
  mode: ContinuityMode
  source_storyboard_id: number | null
  source_task_id: number | null
  depends_on_storyboard_id: number | null
  blockers: string[]
}
export interface BatchPreview { items: BatchPreviewItem[]; blockers: string[] }
export interface MergeRequest {
  storyboard_ids?: number[]
  transitions?: Array<TransitionConfig & { storyboard_id: number }>
}

/** Old rows and HTTP endpoints may expose raw JSON strings or decoded objects. */
export function jsonObject(value: unknown): Record<string, any> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
export function continuityPlan(sb: any): ContinuityPlan {
  const raw = jsonObject(sb?.continuity_plan ?? sb?.continuityPlan)
  return {
    version: 1,
    mode: ['independent', 'tail_frame', 'motion_context'].includes(raw.mode) ? raw.mode : 'independent',
    relation: ['continuous_action', 'same_scene_cut', 'scene_change', 'time_change', 'unknown'].includes(raw.relation) ? raw.relation : 'unknown',
    source_storyboard_id: raw.source_storyboard_id ? Number(raw.source_storyboard_id) : null,
    reason: String(raw.reason || ''),
    needs_review: raw.needs_review === true,
    start_state: String(raw.start_state || ''),
    end_state: String(raw.end_state || ''),
    origin: raw.origin === 'manual' ? 'manual' : 'ai',
    suggestion: raw.suggestion && typeof raw.suggestion === 'object' ? raw.suggestion : null,
  }
}
export function continuityRevision(sb: any): number {
  return Number(sb?.continuity_revision ?? sb?.continuityRevision ?? 0)
}
export function transitionConfig(sb: any): TransitionConfig {
  const raw = jsonObject(sb?.transition_config ?? sb?.transitionConfig)
  const type: TransitionType = ['cut', 'dissolve', 'audio_fade'].includes(raw.type) ? raw.type : 'cut'
  const defaultMs = type === 'dissolve' ? 250 : type === 'audio_fade' ? 30 : 0
  const duration = Number(raw.duration_ms ?? defaultMs)
  return { type, duration_ms: type === 'cut' ? 0 : Math.max(0, Math.min(type === 'dissolve' ? 500 : 100, Number.isFinite(duration) ? duration : defaultMs)) }
}
export function orderedStoryboards<T extends Record<string, any>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(a.storyboard_number ?? a.storyboardNumber ?? a.id) - Number(b.storyboard_number ?? b.storyboardNumber ?? b.id) || Number(a.id) - Number(b.id))
}
export function mergeRequest(storyboards: any[], ids: number[]): MergeRequest {
  const all = orderedStoryboards(storyboards)
  const selected = all.filter(sb => ids.includes(Number(sb.id)))
  return {
    storyboard_ids: selected.map(sb => Number(sb.id)),
    transitions: selected.map((sb, i) => {
      const previous = all[all.findIndex(item => item.id === sb.id) - 1]
      const adjacent = i > 0 && previous?.id === selected[i - 1]?.id
      return { storyboard_id: Number(sb.id), ...(adjacent ? transitionConfig(sb) : { type: 'cut' as const, duration_ms: 0 }) }
    }),
  }
}
export function normalizeTask(row: any) {
  return {
    ...row,
    storyboard_id: row.storyboard_id ?? row.storyboardId,
    depends_on_task_id: row.depends_on_task_id ?? row.dependsOnTaskId,
    retry_of_task_id: row.retry_of_task_id ?? row.retryOfTaskId,
    batch_id: row.batch_id ?? row.batchId,
    blocked_reason: row.blocked_reason ?? row.blockedReason ?? '',
    error_msg: row.error_msg ?? row.errorMsg ?? '',
    created_at: row.created_at ?? row.createdAt ?? '',
    completed_at: row.completed_at ?? row.completedAt ?? '',
    local_path: row.local_path ?? row.localPath,
    result_url: row.result_url ?? row.resultUrl,
    params: jsonObject(row.params),
  }
}
export function taskIsActive(task: any): boolean {
  return ['queued', 'processing', 'downloading', 'pending'].includes(task?.status)
}
export function taskCanRetry(task: any): boolean {
  return ['failed', 'blocked', 'cancelled'].includes(task?.status) && task?.phase !== 'submission_unknown'
}
export function staleContinuitySource(task: any, storyboards: any[]): boolean {
  const params = jsonObject(task?.params)
  const sourceTaskId = params.continuitySourceTaskId ?? params.continuity_source_task_id
  const sourceId = params.continuitySourceStoryboardId ?? params.continuity_source_storyboard_id
  const source = storyboards.find(sb => Number(sb.id) === Number(sourceId))
  const currentId = source?.video_task_id ?? source?.videoTaskId
  return !!sourceTaskId && !!source && String(sourceTaskId) !== String(currentId || '')
}

/** The same builder is used for one shot and for every batch preview/submission. */
export function videoTaskPayload(options: {
  storyboard: any; dramaId: number; prompt: string; references: string[];
  model?: string; configId?: number; aspectRatio: string; wan: boolean;
}) {
  const { storyboard, references, wan } = options
  const independent = continuityPlan(storyboard).mode === 'independent'
  return {
    type: 'video' as const,
    storyboard_id: Number(storyboard.id),
    continuity_revision: continuityRevision(storyboard),
    drama_id: options.dramaId,
    prompt: options.prompt,
    duration: Number(storyboard.duration || 10),
    aspect_ratio: options.aspectRatio,
    generate_audio: true,
    model: options.model || undefined,
    config_id: options.configId,
    reference_image_urls: wan ? [] : references,
    // A normal Wan reference is a first frame. Continuity inputs are resolved by the queue.
    ...(independent && wan && references[0] ? { first_frame_url: references[0] } : {}),
  }
}

/** Keep the key after an ambiguous HTTP error; a changed body always gets a new key. */
export function batchRequestIdentity() {
  let signature = ''
  let key = ''
  return (body: unknown) => {
    const next = JSON.stringify(body)
    if (next !== signature || !key) {
      key = crypto.randomUUID()
      signature = next
    }
    return key
  }
}
