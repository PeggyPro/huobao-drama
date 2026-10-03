import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { extractVideoLastFrame } from '../utils/video-continuity.js'

export async function assertStoryboardMotionContextSource(targetStoryboardId: number, sourceStoryboardId: number) {
  const [target] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, targetStoryboardId))
  const [source] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sourceStoryboardId))
  if (!target || target.deletedAt) throw new Error('当前分镜不存在')
  if (!source || source.deletedAt) throw new Error('H3 Motion Context 的来源分镜不存在')
  if (target.episodeId !== source.episodeId) throw new Error('H3 Motion Context 的来源必须属于同一集')
  if (source.storyboardNumber >= target.storyboardNumber) throw new Error('H3 Motion Context 的来源必须是当前分镜之前的镜头')
  if (!source.videoUrl) throw new Error(`请先完成分镜 ${source.storyboardNumber} 的视频，再使用 H3 Motion Context`)
  const active = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.storyboardId, source.id), eq(schema.sysTask.type, 'video'), eq(schema.sysTask.status, 'processing'),
  ))
  if (active.length) throw new Error('H3 Motion Context 的来源分镜正在生成，请等待完成')
  const completed = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.storyboardId, source.id), eq(schema.sysTask.type, 'video'), eq(schema.sysTask.status, 'completed'),
  ))
  const hasSavedContext = completed.some(task => {
    if (task.localPath !== source.videoUrl) return false
    try { return JSON.parse(task.params || '{}').h3_motion_context_version === 1 }
    catch { return false }
  })
  if (!hasSavedContext) {
    throw new Error(`分镜 ${source.storyboardNumber} 的视频没有 H3 Motion Context latent，请用当前 H3 流程重新生成后再接续`)
  }
  return {
    sourceStoryboardId: source.id,
    sourceStoryboardNumber: source.storyboardNumber,
    sourceVideoUrl: source.videoUrl,
  }
}

export async function getStoryboardContinuityFrame(storyboardId: number) {
  const [target] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!target || target.deletedAt) throw new Error('当前分镜不存在')
  const siblings = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, target.episodeId))
  const previous = siblings
    .filter(row => !row.deletedAt && row.storyboardNumber < target.storyboardNumber)
    .sort((a, b) => b.storyboardNumber - a.storyboardNumber)[0]
  if (!previous) throw new Error('当前分镜没有上一分镜，不能自动续接')
  if (!previous.videoUrl) throw new Error(`请先完成分镜 ${previous.storyboardNumber} 的视频，再提取尾帧`)

  const assertReady = async () => {
    const tasks = await db.select().from(schema.sysTask).where(and(
      eq(schema.sysTask.storyboardId, previous.id), eq(schema.sysTask.type, 'video'), eq(schema.sysTask.status, 'processing'),
    ))
    if (tasks.length) throw new Error('上一分镜正在生成，请等待完成后再提取尾帧')
    const [current] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, previous.id))
    if (!current || current.deletedAt || current.videoUrl !== previous.videoUrl) {
      throw new Error('上一分镜的视频已更新，请重新提取尾帧')
    }
  }
  await assertReady()
  const image = await extractVideoLastFrame(previous.videoUrl)
  await assertReady()
  return {
    first_frame_url: image,
    source_storyboard_id: previous.id,
    source_storyboard_number: previous.storyboardNumber,
    source_video_url: previous.videoUrl,
  }
}
