import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'huobao-comfyui-test-'))
process.env.STORAGE_PATH = path.join(tempDir, 'static')
process.env.COMFYUI_VIDEO_WORKFLOW = path.join(tempDir, 'video.json')
fs.writeFileSync(process.env.COMFYUI_VIDEO_WORKFLOW, JSON.stringify({
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } },
  '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { length: 121 } },
  '133': { class_type: 'PrimitiveFloat', inputs: { value: 5 }, _meta: { title: 'Float (duration)' } },
}))
const { comfyuiVideoAdapter } = await import('../src/services/adapters/comfyui.js')
const { downloadFile, getAbsolutePath } = await import('../src/utils/storage.js')
const config = { provider: 'comfyui', baseUrl: 'http://localhost:8188', apiKey: '', model: 'video' }
const saved = (filename: string) => ({ filename, subfolder: 'video\\toonflow', type: 'output' })
const history = (outputs: object) => ({ job: { status: { status_str: 'success', completed: true }, outputs } })

after(() => {
  // Delete only the temporary directory created by this test file.
  assert.equal(path.dirname(fs.realpathSync(tempDir)), tempParent)
  assert.match(path.basename(tempDir), /^huobao-comfyui-test-/)
  fs.rmSync(tempDir, { recursive: true })
})

test('SaveVideo MP4 is found even after an image preview in history', () => {
  const result = comfyuiVideoAdapter.parsePollResponse(history({
    preview: { images: [saved('poster.png')] },
    output: { images: [saved('another-preview.png'), saved('clip.MP4')] },
  }), config)
  assert.equal(result.status, 'completed')
  const url = new URL(result.videoUrl!)
  assert.equal(url.searchParams.get('filename'), 'clip.MP4')
  assert.equal(url.searchParams.get('subfolder'), 'video\\toonflow')
})

test('GIF previews are not mistaken for playable video', () => {
  const gifOnly = comfyuiVideoAdapter.parsePollResponse(history({ out: { images: [saved('preview.gif')] } }), config)
  assert.equal(gifOnly.status, 'failed')
  assert.match(gifOnly.error!, /image output, not a video output/)
  const mixed = comfyuiVideoAdapter.parsePollResponse(history({ out: { images: [saved('preview.gif'), saved('clip.mp4')] } }), config)
  assert.equal(mixed.status, 'completed')
  assert.equal(new URL(mixed.videoUrl!).searchParams.get('filename'), 'clip.mp4')
})

test('legacy video output fields remain supported', () => {
  for (const key of ['videos', 'gifs', 'video']) {
    assert.equal(comfyuiVideoAdapter.parsePollResponse(history({ out: { [key]: [saved('clip.webm')] } }), config).status, 'completed')
  }
})

test('an image-only workflow still fails instead of claiming video success', () => {
  const result = comfyuiVideoAdapter.parsePollResponse(history({ out: { images: [saved('picture.png')] } }), config)
  assert.equal(result.status, 'failed')
  assert.match(result.error!, /image output, not a video output/)
})

test('missing history stays pending and execution failures retain the actual error', () => {
  assert.equal(comfyuiVideoAdapter.parsePollResponse({}, config).status, 'pending')
  const result = comfyuiVideoAdapter.parsePollResponse({ job: { status: {
    status_str: 'error', messages: [['execution_error', { exception_message: 'model missing' }]],
  } } }, config)
  assert.deepEqual(result, { status: 'failed', error: 'model missing' })
})

test('storyboard duration reaches Wan and H3 without mutating the workflow template', async () => {
  const build = async (duration?: number) => (await comfyuiVideoAdapter.buildGenerateRequest(config, { id: 1, prompt: 'test', duration })).body.prompt
  const twelve = await build(12)
  assert.equal(twelve['7'].inputs.length, 289)
  assert.equal(twelve['133'].inputs.value, 12)
  for (const duration of [undefined, 0, NaN]) {
    const defaults = await build(duration)
    assert.equal(defaults['7'].inputs.length, 121)
    assert.equal(defaults['133'].inputs.value, 5)
  }
})

test('downloaded media keeps playable extensions for ComfyUI and signed URLs', async (t) => {
  const cases = [
    ['http://localhost/view?filename=clip.mp4', 'video/mp4', '.mp4'],
    ['http://localhost/view?filename=clip.webm', 'application/octet-stream', '.webm'],
    ['http://localhost/download?token=test', 'video/mp4; charset=binary', '.mp4'],
    ['http://localhost/picture.png', 'image/png', '.png'],
    ['http://localhost/file', 'application/octet-stream', '.bin'],
  ]
  for (const [url, contentType, ext] of cases) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('media bytes', { headers: { 'content-type': contentType } }))
    try {
      const local = await downloadFile(url, 'videos')
      assert.equal(path.extname(local), ext)
      assert.equal(fs.readFileSync(getAbsolutePath(local), 'utf8'), 'media bytes')
    } finally {
      mock.mock.restore()
    }
  }
})
