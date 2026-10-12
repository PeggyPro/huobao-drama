import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { extractVideoLastFrame } from '../utils/video-continuity.js'
import { ContinuityConflict } from './continuity-plans.js'
import { blockingVideoTask, localVideoArtifact } from './video-task-input.js'

/** The default follows the preceding shot's current version; an explicit task pins history. */
export async function getStoryboardContinuityFrame(
  storyboardId: number,
  sourceTaskId?: number,
  extractTail: typeof extractVideoLastFrame = extractVideoLastFrame,
) {
  if (!Number.isSafeInteger(storyboardId) || storyboardId <= 0) throw new Error('分镜 ID 无效')
  if (sourceTaskId !== undefined && (!Number.isSafeInteger(sourceTaskId) || sourceTaskId <= 0)) {
    throw new Error('source_task_id 必须为正整数')
  }

  const selection = () => {
    const target = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).get()
    if (!target || target.deletedAt) throw new Error('当前分镜不存在')
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, target.episodeId)).get()
    if (!episode || episode.deletedAt) throw new Error('当前分镜所属剧集不存在')
    const previous = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, target.episodeId)).all()
      .filter(row => !row.deletedAt && row.storyboardNumber < target.storyboardNumber)
      .sort((a, b) => b.storyboardNumber - a.storyboardNumber || b.id - a.id)[0]
    if (!previous) throw new Error('当前分镜没有上一分镜，不能自动续接')
    if (sourceTaskId === undefined && blockingVideoTask(previous.id)) {
      throw new ContinuityConflict('上一分镜正在生成或提交结果待确认，请等待完成后再提取当前版本尾帧')
    }

    const taskId = sourceTaskId ?? previous.videoTaskId ?? null
    const task = taskId == null ? null : db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
    if (taskId != null && (!task || task.type !== 'video' || task.storyboardId !== previous.id || task.deletedAt
      || task.status !== 'completed' || task.phase === 'completed_stale' || !task.localPath)) {
      throw new ContinuityConflict('尾帧来源必须是上一分镜已完成、未删除且未失效的视频任务版本')
    }
    const videoUrl = task?.localPath ?? previous.videoUrl
    if (!videoUrl) throw new Error(`请先完成分镜 ${previous.storyboardNumber} 的视频，再提取尾帧`)
    if (sourceTaskId === undefined && task && previous.videoUrl !== task.localPath) {
      throw new ContinuityConflict('上一分镜当前视频与任务版本不一致，请重新选择来源')
    }
    return { target, previous, taskId, videoUrl }
  }

  const frozen = selection()
  const physical = await localVideoArtifact(frozen.videoUrl)
  const assertSelection = () => {
    const current = selection()
    if (current.target.episodeId !== frozen.target.episodeId || current.previous.id !== frozen.previous.id
      || current.taskId !== frozen.taskId || current.videoUrl !== frozen.videoUrl) {
      throw new ContinuityConflict('提取期间分镜邻接关系或来源视频版本已改变，请重新提取尾帧')
    }
    return current
  }
  // Filesystem operations yield; recheck the selected rows immediately before and after extraction.
  assertSelection()
  const image = await extractTail(frozen.videoUrl, frozen.taskId ?? undefined)
  const after = await localVideoArtifact(frozen.videoUrl)
  if (after.identity !== physical.identity || after.file !== physical.file) {
    throw new ContinuityConflict('提取期间来源视频文件已改变，请重新提取尾帧')
  }
  const current = assertSelection()
  return {
    first_frame_url: image,
    source_task_id: frozen.taskId,
    source_storyboard_id: current.previous.id,
    source_storyboard_number: current.previous.storyboardNumber,
    source_video_url: frozen.videoUrl,
  }
}
