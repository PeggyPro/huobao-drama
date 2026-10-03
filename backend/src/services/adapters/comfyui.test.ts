import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  COMFYUI_QWEN_IMAGE_WORKFLOW,
  COMFYUI_WORKFLOWS,
  ComfyUIImageAdapter,
} from './comfyui.js'

test('Qwen Image 2.1 workflow is exposed with a Huobao model id', () => {
  assert.equal(COMFYUI_QWEN_IMAGE_WORKFLOW, 'huobao_qwen_image_2_1_api')
  assert.equal(COMFYUI_WORKFLOWS.image.model, COMFYUI_QWEN_IMAGE_WORKFLOW)
  assert.equal(COMFYUI_WORKFLOWS.image.workflowFile, 'huobao_qwen_image_2_1_api.json')
  assert.equal(COMFYUI_WORKFLOWS.imageLegacy.model, 'V4-09_Z-Image_Turbo_文生图_4K')
})

test('Qwen Image 2.1 API workflow accepts text-only Huobao image requests', () => {
  const workflowPath = path.resolve(process.cwd(), '../comfyui_workflows/huobao_32gb/huobao_qwen_image_2_1_api.json')
  assert.equal(fs.existsSync(workflowPath), true)

  const previousOverride = process.env.COMFYUI_IMAGE_WORKFLOW
  process.env.COMFYUI_IMAGE_WORKFLOW = workflowPath
  try {
    const request = new ComfyUIImageAdapter().buildGenerateRequest(
      { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: COMFYUI_QWEN_IMAGE_WORKFLOW },
      { id: 7, model: COMFYUI_QWEN_IMAGE_WORKFLOW, prompt: 'A red fox in a snowy forest', size: '768x1024' },
    )
    const workflow = request.body.prompt

    assert.equal(workflow['452'].class_type, 'TextEncodeQwenImage21')
    assert.equal('images' in workflow['452'].inputs, false)
    assert.equal(workflow['452'].inputs.negative_prompt, '')
    assert.equal(workflow['456'].inputs.width, 768)
    assert.equal(workflow['456'].inputs.height, 1024)
    assert.equal(workflow['458'].inputs.denoise, 1)
    assert.equal(workflow['461'].inputs.filename_prefix, 'image/huobao_qwen_image_2_1')
    assert.equal(workflow['474'].inputs.on_false, 'A red fox in a snowy forest')
    assert.equal(workflow['471'].inputs.prompt, 'A red fox in a snowy forest')
    assert.match(workflow['475'].inputs.value, /^# Image Prompt Rewriting Expert/)
    assert.equal(workflow['458'].inputs.seed, workflow['471'].inputs['sampling_mode.seed'])
    assert.equal(typeof workflow['458'].inputs.seed, 'number')
    assert.equal(workflow['471'].inputs['sampling_mode.presence_penalty'], 1.5)
  } finally {
    if (previousOverride === undefined) delete process.env.COMFYUI_IMAGE_WORKFLOW
    else process.env.COMFYUI_IMAGE_WORKFLOW = previousOverride
  }
})
