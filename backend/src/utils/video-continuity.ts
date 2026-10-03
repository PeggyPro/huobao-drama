import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from './paths.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** Extract the last decoded frame at full resolution, not the video poster. */
export async function extractVideoLastFrame(videoPath: string): Promise<string> {
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
  const digest = createHash('sha256').update(`${input}:${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 24)
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
