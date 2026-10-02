/**
 * Local ComfyUI workflow adapter.
 *
 * The ComfyUI API is a queue API: /prompt returns a prompt_id and
 * /history/:prompt_id exposes the saved output files. Workflow JSON files are
 * kept in ComfyUI's user/default/toonflow_api directory and selected by the
 * configured model name.
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  AIConfig,
  ImageGenResponse,
  ImageGenerationRecord,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'

export const COMFYUI_IMAGE_WORKFLOW = 'V4-09_Z-Image_Turbo_文生图_4K'
export const COMFYUI_VIDEO_WORKFLOW = 'zib+zit+最大程度保持原样双采+'

/** Public model-to-workflow mapping used by Huobao clients and settings. */
export const COMFYUI_WORKFLOWS = {
  image: {
    serviceType: 'image',
    provider: 'comfyui',
    model: COMFYUI_IMAGE_WORKFLOW,
    workflowFile: `${COMFYUI_IMAGE_WORKFLOW}.json`,
    outputType: 'image',
  },
  video: {
    serviceType: 'video',
    provider: 'comfyui',
    model: COMFYUI_VIDEO_WORKFLOW,
    workflowFile: `${COMFYUI_VIDEO_WORKFLOW}.json`,
    outputType: 'video',
  },
} as const

const WORKFLOW_ALIASES: Record<string, string> = {
  [COMFYUI_IMAGE_WORKFLOW]: `${COMFYUI_IMAGE_WORKFLOW}.json`,
  [`${COMFYUI_IMAGE_WORKFLOW}.json`]: `${COMFYUI_IMAGE_WORKFLOW}.json`,
  [COMFYUI_VIDEO_WORKFLOW]: `${COMFYUI_VIDEO_WORKFLOW}.json`,
  [`${COMFYUI_VIDEO_WORKFLOW}.json`]: `${COMFYUI_VIDEO_WORKFLOW}.json`,
}

const DEFAULT_WORKFLOW_DIR = process.env.COMFYUI_WORKFLOW_DIR
  || 'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\user\\default\\toonflow_api'

function baseUrl(config: AIConfig): string {
  return config.baseUrl.replace(/\/+$/, '')
}

function url(config: AIConfig, suffix: string): string {
  return `${baseUrl(config)}${suffix}`
}

function headers(config: AIConfig, withJson = false): Record<string, string> {
  const output: Record<string, string> = {}
  if (withJson) output['Content-Type'] = 'application/json'
  if (config.apiKey) output.Authorization = `Bearer ${config.apiKey}`
  return output
}

function selectedWorkflowFile(model: string | null | undefined, fallback: string): string {
  const requested = String(model || fallback).trim() || fallback
  const alias = WORKFLOW_ALIASES[requested]
  if (alias) return alias
  // Allow adding another API workflow without changing the adapter. Keep it
  // to a basename so a database value cannot escape the configured directory.
  const basename = path.basename(requested.endsWith('.json') ? requested : `${requested}.json`)
  if (!basename || basename === '.json' || basename.includes('..')) {
    throw new Error(`Invalid ComfyUI workflow name: ${requested}`)
  }
  return basename
}

function workflowPath(model: string | null | undefined, fallback: string, envOverride?: string): string {
  const configured = envOverride || selectedWorkflowFile(model, fallback)
  const candidate = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(DEFAULT_WORKFLOW_DIR, configured)
  if (!fs.existsSync(candidate)) {
    throw new Error(`ComfyUI workflow not found: ${candidate}`)
  }
  return candidate
}

function loadWorkflow(model: string | null | undefined, fallback: string, envOverride?: string): Record<string, any> {
  const file = workflowPath(model, fallback, envOverride)
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error: any) {
    throw new Error(`Invalid ComfyUI workflow JSON ${file}: ${error.message}`)
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Invalid ComfyUI API workflow: ${file}`)
  }
  return value as Record<string, any>
}

function isNegativeNode(node: Record<string, any>): boolean {
  const title = String(node._meta?.title || '').toLowerCase()
  return /negative|负面|反向|bad prompt/.test(title)
}

function injectPrompt(workflow: Record<string, any>, prompt: string | null | undefined): void {
  const text = String(prompt || '').trim()
  if (!text) return
  const nodes = Object.values(workflow)

  // The double-sampling workflow deliberately routes one primitive string to
  // both positive conditioning stages. Updating it preserves that topology.
  const primitive = nodes.find((node: any) => (
    node?.class_type === 'PrimitiveStringMultiline' && typeof node.inputs?.value === 'string'
  )) as Record<string, any> | undefined
  if (primitive) {
    primitive.inputs.value = text
    return
  }

  // The image workflow has one direct positive CLIPTextEncode input.
  const positive = nodes.find((node: any) => (
    node?.class_type === 'CLIPTextEncode'
      && typeof node.inputs?.text === 'string'
      && !isNegativeNode(node)
  )) as Record<string, any> | undefined
  if (positive) positive.inputs.text = text
}

function injectImageSize(workflow: Record<string, any>, size: string | null | undefined): void {
  const match = String(size || '').trim().match(/^(\d+)x(\d+)$/i)
  if (!match) return
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return

  // Only update literal latent dimensions. The double-sampling workflow's
  // ResolutionSelector is linked and must keep its own aspect-ratio logic.
  for (const node of Object.values(workflow) as Record<string, any>[]) {
    if (node?.class_type !== 'EmptySD3LatentImage') continue
    if (typeof node.inputs?.width === 'number') node.inputs.width = width
    if (typeof node.inputs?.height === 'number') node.inputs.height = height
  }
}

function buildWorkflowPrompt(
  config: AIConfig,
  model: string | null | undefined,
  prompt: string | null | undefined,
  size: string | null | undefined,
  fallback: string,
  envOverride?: string,
): Record<string, any> {
  const workflow = JSON.parse(JSON.stringify(loadWorkflow(model, fallback, envOverride))) as Record<string, any>
  injectPrompt(workflow, prompt)
  injectImageSize(workflow, size)
  return workflow
}

function viewUrl(config: AIConfig, file: Record<string, any>): string {
  const query = new URLSearchParams({
    filename: String(file.filename || ''),
    subfolder: String(file.subfolder || ''),
    type: String(file.type || 'output'),
  })
  return url(config, `/view?${query.toString()}`)
}

function historyEntry(result: any): Record<string, any> | null {
  if (!result || typeof result !== 'object') return null
  const entries = Object.values(result).filter((value): value is Record<string, any> => (
    !!value && typeof value === 'object' && !Array.isArray(value)
  ))
  return (entries[0] as Record<string, any> | undefined) || null
}

function outputFile(entry: Record<string, any>, keys: string[]): Record<string, any> | null {
  const outputs = entry.outputs
  if (!outputs || typeof outputs !== 'object') return null
  for (const output of Object.values(outputs) as Record<string, any>[]) {
    for (const key of keys) {
      const files = output?.[key]
      if (Array.isArray(files) && files[0]?.filename) return files[0]
    }
  }
  return null
}

function historyStatus(entry: Record<string, any>): 'pending' | 'processing' | 'completed' | 'failed' {
  const status = entry.status || {}
  const statusString = String(status.status_str || '').toLowerCase()
  if (statusString === 'error' || statusString === 'failed') return 'failed'
  if (statusString === 'success' || status.completed === true) return 'completed'
  return 'processing'
}

function errorMessage(entry: Record<string, any>): string {
  const status = entry.status || {}
  const messages = Array.isArray(status.messages) ? status.messages : []
  const executionError = messages.find((message: any) => Array.isArray(message) && message[0] === 'execution_error')
  return String(executionError?.[1]?.exception_message || status.error || 'ComfyUI execution failed')
}

function parseHistoryImage(result: any, config?: AIConfig): ImagePollResponse {
  const entry = historyEntry(result)
  if (!entry) return { status: 'pending' }
  const status = historyStatus(entry)
  if (status === 'failed') return { status, error: errorMessage(entry) }
  if (status !== 'completed') return { status }
  const file = outputFile(entry, ['images'])
  if (!file || !config) return file ? { status: 'completed' } : { status: 'failed', error: 'ComfyUI returned no image output' }
  return { status: 'completed', imageUrl: viewUrl(config, file) }
}

function parseHistoryVideo(result: any, config?: AIConfig): VideoPollResponse {
  const entry = historyEntry(result)
  if (!entry) return { status: 'pending' }
  const status = historyStatus(entry)
  if (status === 'failed') return { status, error: errorMessage(entry) }
  if (status !== 'completed') return { status }
  const file = outputFile(entry, ['videos', 'gifs', 'video'])
  if (!file || !config) {
    // The named double-sampling workflow currently ends in SaveImage. Fail
    // clearly instead of storing a PNG in Huobao's video column.
    const imageOutput = outputFile(entry, ['images'])
    return imageOutput
      ? { status: 'failed', error: 'ComfyUI workflow returned image output, not a video output' }
      : { status: 'failed', error: 'ComfyUI returned no video output' }
  }
  return { status: 'completed', videoUrl: viewUrl(config, file) }
}

abstract class ComfyUIAdapterBase {
  protected buildRequest(config: AIConfig, workflow: Record<string, any>, clientId: string): ProviderRequest {
    return {
      url: url(config, '/prompt'),
      method: 'POST',
      headers: headers(config, true),
      body: { prompt: workflow, client_id: clientId },
    }
  }

  protected pollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: url(config, `/history/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: headers(config),
      body: undefined,
    }
  }

  protected parsePromptResponse(result: any): string {
    if (result?.prompt_id) return String(result.prompt_id)
    const error = result?.error?.message || result?.error || 'ComfyUI did not return prompt_id'
    throw new Error(String(error))
  }
}

export class ComfyUIImageAdapter extends ComfyUIAdapterBase implements ImageProviderAdapter {
  provider = 'comfyui'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const workflow = buildWorkflowPrompt(
      config,
      record.model || config.model,
      record.prompt,
      record.size,
      COMFYUI_IMAGE_WORKFLOW,
      process.env.COMFYUI_IMAGE_WORKFLOW,
    )
    return this.buildRequest(config, workflow, `huobao-image-${record.id}`)
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    return { isAsync: true, taskId: this.parsePromptResponse(result) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.pollRequest(config, taskId)
  }

  parsePollResponse(result: any, config?: AIConfig): ImagePollResponse {
    return parseHistoryImage(result, config)
  }

  extractImageUrl(result: any): string | null {
    return result?.image_url || result?.imageUrl || null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}

export class ComfyUIVideoAdapter extends ComfyUIAdapterBase implements VideoProviderAdapter {
  provider = 'comfyui'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const workflow = buildWorkflowPrompt(
      config,
      record.model || config.model,
      record.prompt,
      undefined,
      COMFYUI_VIDEO_WORKFLOW,
      process.env.COMFYUI_VIDEO_WORKFLOW,
    )
    return this.buildRequest(config, workflow, `huobao-video-${record.id}`)
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    return { isAsync: true, taskId: this.parsePromptResponse(result) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.pollRequest(config, taskId)
  }

  parsePollResponse(result: any, config?: AIConfig): VideoPollResponse {
    return parseHistoryVideo(result, config)
  }

  extractVideoUrl(result: any): string | null {
    return result?.video_url || result?.videoUrl || null
  }
}

export const comfyuiImageAdapter = new ComfyUIImageAdapter()
export const comfyuiVideoAdapter = new ComfyUIVideoAdapter()
