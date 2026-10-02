import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'huobao-comfyui-adapter-'))
const imageWorkflowPath = join(tempDir, 'image.json')
const videoWorkflowPath = join(tempDir, 'video.json')
const previousImageWorkflow = process.env.COMFYUI_IMAGE_WORKFLOW
const previousVideoWorkflow = process.env.COMFYUI_VIDEO_WORKFLOW

writeFileSync(imageWorkflowPath, JSON.stringify({
  positive: {
    inputs: { text: 'old image prompt' },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Positive prompt' },
  },
  latent: {
    inputs: { width: 1024, height: 1024 },
    class_type: 'EmptySD3LatentImage',
    _meta: { title: 'Image size' },
  },
}))
writeFileSync(videoWorkflowPath, JSON.stringify({
  prompt: {
    inputs: { value: 'old video prompt' },
    class_type: 'PrimitiveStringMultiline',
    _meta: { title: 'Prompt' },
  },
}))
process.env.COMFYUI_IMAGE_WORKFLOW = imageWorkflowPath
process.env.COMFYUI_VIDEO_WORKFLOW = videoWorkflowPath

const {
  COMFYUI_IMAGE_WORKFLOW,
  COMFYUI_VIDEO_WORKFLOW,
  COMFYUI_WORKFLOWS,
  ComfyUIImageAdapter,
  ComfyUIVideoAdapter,
} = await import('../src/services/adapters/comfyui.ts')

const config = {
  provider: 'comfyui',
  baseUrl: 'http://127.0.0.1:8188',
  apiKey: '',
  model: '',
}

const history = (output: Record<string, unknown>) => ({
  'prompt-id': {
    status: { status_str: 'success', completed: true },
    outputs: { output },
  },
})

after(() => {
  if (previousImageWorkflow === undefined) delete process.env.COMFYUI_IMAGE_WORKFLOW
  else process.env.COMFYUI_IMAGE_WORKFLOW = previousImageWorkflow
  if (previousVideoWorkflow === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW
  else process.env.COMFYUI_VIDEO_WORKFLOW = previousVideoWorkflow
  rmSync(tempDir, { recursive: true, force: true })
})

test('ComfyUI workflow names stay mapped to their public service APIs', () => {
  assert.equal(COMFYUI_IMAGE_WORKFLOW, 'V4-09_Z-Image_Turbo_文生图_4K')
  assert.equal(COMFYUI_VIDEO_WORKFLOW, 'zib+zit+最大程度保持原样双采+')
  assert.deepEqual(COMFYUI_WORKFLOWS.image, {
    serviceType: 'image',
    provider: 'comfyui',
    model: COMFYUI_IMAGE_WORKFLOW,
    workflowFile: 'V4-09_Z-Image_Turbo_文生图_4K.json',
    outputType: 'image',
  })
  assert.deepEqual(COMFYUI_WORKFLOWS.video, {
    serviceType: 'video',
    provider: 'comfyui',
    model: COMFYUI_VIDEO_WORKFLOW,
    workflowFile: 'zib+zit+最大程度保持原样双采+.json',
    outputType: 'video',
  })
})

test('ComfyUI image adapter injects prompt and preserves request/poll URLs', () => {
  const adapter = new ComfyUIImageAdapter()
  const request = adapter.buildGenerateRequest(config, {
    id: 7,
    model: 'test-image-workflow',
    prompt: 'new image prompt',
    size: '768x512',
    frameType: undefined,
    referenceImages: null,
  } as any) as any

  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'http://127.0.0.1:8188/prompt')
  assert.equal(request.body.client_id, 'huobao-image-7')
  assert.equal(request.body.prompt.positive.inputs.text, 'new image prompt')
  assert.equal(request.body.prompt.latent.inputs.width, 768)
  assert.equal(request.body.prompt.latent.inputs.height, 512)
  assert.deepEqual(adapter.parseGenerateResponse({ prompt_id: 'prompt-id' }), {
    isAsync: true,
    taskId: 'prompt-id',
  })
  assert.deepEqual(adapter.buildPollRequest(config, 'prompt-id'), {
    method: 'GET',
    url: 'http://127.0.0.1:8188/history/prompt-id',
    headers: {},
    body: undefined,
  })
  assert.deepEqual(adapter.parsePollResponse({
    'prompt-id': {
      status: { status_str: 'success', completed: true },
      outputs: {
        preview: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
        saved: { images: [{ filename: 'result.png', subfolder: 'batch', type: 'output' }] },
      },
    },
  }, config), {
    status: 'completed',
    imageUrl: 'http://127.0.0.1:8188/view?filename=result.png&subfolder=batch&type=output',
  })
})

test('ComfyUI video adapter injects the double-sampling prompt and exposes video outputs', () => {
  const adapter = new ComfyUIVideoAdapter()
  const request = adapter.buildGenerateRequest(config, {
    id: 8,
    model: 'test-video-workflow',
    prompt: 'new video prompt',
  } as any) as any

  assert.equal(request.url, 'http://127.0.0.1:8188/prompt')
  assert.equal(request.body.client_id, 'huobao-video-8')
  assert.equal(request.body.prompt.prompt.inputs.value, 'new video prompt')
  assert.deepEqual(adapter.parsePollResponse(history({
    videos: [{ filename: 'result.mp4', subfolder: 'batch', type: 'output' }],
  }), config), {
    status: 'completed',
    videoUrl: 'http://127.0.0.1:8188/view?filename=result.mp4&subfolder=batch&type=output',
  })
})

test('ComfyUI video adapter rejects the named workflow when it returns an image', () => {
  const adapter = new ComfyUIVideoAdapter()
  assert.deepEqual(adapter.parsePollResponse(history({
    images: [{ filename: 'result.png', subfolder: '', type: 'output' }],
  }), config), {
    status: 'failed',
    error: 'ComfyUI workflow returned image output, not a video output',
  })
})
