import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import sharp from 'sharp'

const parent = fs.realpathSync(os.tmpdir())
const dir = fs.mkdtempSync(path.join(parent, 'huobao-tail-test-'))
process.env.STORAGE_PATH = path.join(dir, 'static')
fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'videos'), { recursive: true })
const { extractVideoLastFrame } = await import('../src/utils/video-continuity.js')
const require = createRequire(import.meta.url)
const binary = process.env.FFMPEG_BIN || require('ffmpeg-static')
const input = path.join(process.env.STORAGE_PATH, 'videos', 'red-then-blue.mp4')
const generated = spawnSync(binary, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=4:d=1',
  '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=4:d=1',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
], { stdio: 'inherit', windowsHide: true })
assert.equal(generated.status, 0, generated.error?.message)
after(() => {
  assert.equal(path.dirname(fs.realpathSync(dir)), parent)
  assert.match(path.basename(dir), /^huobao-tail-test-/)
  fs.rmSync(dir, { recursive: true })
})

test('continuity frame comes from video end, retains resolution, and reuses completed extraction', async () => {
  const result = await extractVideoLastFrame('static/videos/red-then-blue.mp4')
  assert.match(result, /^static\/images\/continuity-[a-f0-9]+\.png$/)
  const absolute = path.join(process.env.STORAGE_PATH!, result.replace(/^static\//, ''))
  const metadata = await sharp(absolute).metadata()
  assert.equal(metadata.width, 64)
  assert.equal(metadata.height, 64)
  const { channels } = await sharp(absolute).stats()
  assert.ok(channels[2].mean > 240, 'last frame should be blue')
  assert.ok(channels[0].mean < 15, 'must not extract initial red frame/poster')
  assert.equal(await extractVideoLastFrame('/static/videos/red-then-blue.mp4'), result)
})

test('continuity extraction rejects remote URLs and paths outside storage', async () => {
  await assert.rejects(extractVideoLastFrame('https://example.test/movie.mp4'), /已下载到本地/)
  const outside = path.join(dir, 'outside.mp4')
  fs.copyFileSync(input, outside)
  await assert.rejects(extractVideoLastFrame('static/videos/../../outside.mp4'), /超出本地素材目录/)
})
