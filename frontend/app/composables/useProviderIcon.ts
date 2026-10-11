/**
 * 厂商图标 — 文本品牌来自 app/public/provider-icons/（LobeHub，MIT），媒体保留现有双主题图标
 * resolvedTheme 是模块级 computed，模板中调用本函数会随主题切换响应式更新
 */
import { resolvedTheme } from '~/composables/useTheme'
import { textProviderById } from '~/utils/textProviderCatalog'

const FILENAMES: Record<string, string> = {
  openai: 'openai.png',
  gemini: 'gemini-color.png',
  volcengine: 'volcengine-color.png',
  minimax: 'minimax-color.png',
  claude: 'claude-color.png',
  deepseek: 'deepseek-color.png',
  doubao: 'doubao-color.png',
  moonshot: 'kimi-color.png',
  qwen: 'qwen-color.png',
  aliyun: 'qwen-color.png',  // 阿里云 Wan 系列与 Qwen 同属阿里，共用图标
  zhipu: 'zhipu-color.png',
  xai: 'grok.png',
  xiaomi: 'xiaomi-color.png',
  vidu: 'vidu-color.png',
  ollama: 'ollama.png',
  midjourney: 'midjourney.png',
}

/** provider → 当前主题下的图标 URL；未知厂商返回 undefined（调用方回退字母徽标） */
export function providerIconUrl(provider?: string | null, serviceType?: string): string | undefined {
  const id = (provider || '').toLowerCase()
  const brand = textProviderById(id === 'qwen' ? 'aliyun' : id === 'doubao' ? 'volcengine' : id)
  // Keep the existing Volcengine mark for media; text uses the reviewed Doubao mark.
  if (brand && !(id === 'volcengine' && serviceType !== 'text')) {
    if (id === 'moonshot') return '/provider-icons/kimi-color-badge.svg'
    const directory = brand.mono && resolvedTheme.value === 'dark' ? 'dark/' : ''
    return `/provider-icons/${directory}${brand.icon}.svg`
  }
  const file = FILENAMES[id]
  return file ? `/icons/${resolvedTheme.value}/${file}` : undefined
}

/**
 * 模型名 → 厂商推断（按优先级从上到下，命中即返回）。
 * 场景：配置走 openai 兼容网关（provider=openai）但模型实为 deepseek/gemini 等，
 * 此时图标应按模型名而非 provider 展示。
 * 不含 doubao/seedance：它们由 volcengine 服务，provider 图标更准确。
 */
const MODEL_PROVIDER_HINTS: [RegExp, string][] = [
  [/deepseek/i, 'deepseek'],
  [/claude/i, 'claude'],
  [/gemini/i, 'gemini'],
  [/kimi|moonshot/i, 'moonshot'],
  [/qwen|^wan[\d.-]/i, 'qwen'],
  [/glm|zhipu|chatglm/i, 'zhipu'],
  [/grok/i, 'xai'],
  [/mimo/i, 'xiaomi'],
  [/minimax/i, 'minimax'],
  [/ernie/i, 'baidu'],
  [/hunyuan/i, 'hunyuan'],
  [/mistral|mixtral|codestral|devstral/i, 'mistral'],
  [/^command[-_]/i, 'cohere'],
  [/^(gpt|chatgpt|o[1-9])/i, 'openai'],
]

/** 模型感知的图标：模型名可识别厂商时优先，否则回退 provider */
export function modelIconUrl(provider?: string | null, model?: string | null): string | undefined {
  const m = model || ''
  for (const [re, p] of MODEL_PROVIDER_HINTS) {
    if (re.test(m)) return providerIconUrl(p)
  }
  return providerIconUrl(provider)
}
