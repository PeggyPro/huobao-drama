import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from './paths.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** Extract the last decoded frame at full resolution, with a cache per source task version. */
export async function extractVideoLastFrame(videoPath: string, sourceTaskId?: number): Promise<string> {
  if (sourceTaskId !== undefined && (!Number.isSafeInteger(sourceTaskId) || sourceTaskId <= 0)) {
    throw new Error('source_task_id 必须为正整数')
  }
  if (!/^\/?static\/videos\/.+\.(?:mp4|webm|mov|mkv|m4v)$/i.test(videoPath)) {
    throw new Error('上一分镜需要已下载到本地的视频，才能提取续接尾帧')
  }
  const root = await fs.realpath(path.resolve(STORAGE_ROOT))
  const input = await fs.realpath(path.resolve(root, videoPath.replace(/^\/?static\//, '')))
  const relative = path.relative(root, input)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('视频路径超出本地素材目录')
  }
  const info = await fs.stat(input)
  if (!info.isFile() || !info.size) throw new Error('来源视频文件为空或不可读')
  const digest = createHash('sha256').update(JSON.stringify({
    input, size: info.size, mtimeMs: info.mtimeMs, sourceTaskId: sourceTaskId ?? null, position: 'last',
  })).digest('hex').slice(0, 24)
  const filename = `continuity-${digest}.png`
  const output = path.join(root, 'images', filename)
  const outputRelative = `static/images/${filename}`
  try { if ((await fs.stat(output)).size > 0) return outputRelative } catch { /* not extracted yet */ }
  if (!(await checkFfmpegSuite()).ffmpeg) throw new Error('FFmpeg 不可用，无法提取上一分镜尾帧')
  await fs.mkdir(path.dirname(output), { recursive: true })
  const temporary = path.join(path.dirname(output), `continuity-${digest}-${randomUUID()}.tmp.png`)
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(input)
        .inputOptions(['-sseof -1'])
        .noAudio()
        .videoFilters('reverse')
        .outputOptions(['-frames:v 1'])
        .output(temporary)
        .on('end', () => resolve())
        .on('error', reject)
        .run()
    })
    await fs.rename(temporary, output)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw new Error(`提取上一分镜尾帧失败：${(error as Error).message}`)
  }
  return outputRelative
}
