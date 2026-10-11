// Existing image/video presets are kept separate from the text provider catalog.
export const MEDIA_PROVIDERS = ['gemini', 'openai', 'volcengine', 'minimax', 'aliyun', 'comfyui']
export const MEDIA_PROVIDER_PRESETS: Record<string, Record<string, { label: string; baseUrl: string; models: string[] }>> = {
  image: {
    gemini: { label: 'Gemini 官方', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-3-pro-image', 'gemini-3.1-flash-image'] },
    openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com', models: ['gpt-image-2'] },
    comfyui: { label: '本地 ComfyUI · Qwen Image 2.1', baseUrl: 'http://127.0.0.1:8188', models: ['huobao_qwen_image_2_1_api', 'V4-09_Z-Image_Turbo_文生图_4K'] },
  },
  video: {
    aliyun: { label: '阿里云百炼 Wan 3.0', baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com', models: ['wan3.0-video', 'wan3.0-video-prime'] },
    volcengine: { label: 'Seedance 2.0 官方', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128'] },
    minimax: { label: 'MiniMax H3 官方', baseUrl: 'https://api.minimaxi.com', models: ['MiniMax-H3'] },
    comfyui: { label: '本地 ComfyUI · 双采流程', baseUrl: 'http://127.0.0.1:8188', models: ['zib+zit+最大程度保持原样双采+'] },
  },
}
