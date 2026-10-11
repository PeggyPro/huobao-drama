export type TextApiFormat = 'anthropic' | 'openai' | 'google'
export type ProviderGroup = 'domestic' | 'international' | 'platform'

export interface TextProvider {
  id: string
  label: string
  group: ProviderGroup
  icon: string
  mono?: boolean
  apiFormat: TextApiFormat
  baseUrl: string
  models: string[]
  search: string
  docs: string
  keyUrl: string
  keyPlaceholder?: string
  urlPlaceholder?: string
  customModel?: boolean
}

// Reviewed presets from design-previews/ai-providers. Models are editable examples,
// not an assertion that an account can access them. Never apply these on edit/load.
export const TEXT_PROVIDERS: TextProvider[] = [
  { id: 'claude', label: 'Claude', group: 'international', icon: 'claude-color', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-6'], search: 'anthropic 克劳德', docs: 'https://platform.claude.com/docs/en/api/overview', keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', group: 'international', icon: 'openai', mono: true, apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini'], search: 'chatgpt gpt', docs: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', label: 'Gemini', group: 'international', icon: 'gemini-color', apiFormat: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash'], search: 'google 谷歌 ai studio', docs: 'https://ai.google.dev/gemini-api/docs/text-generation', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', label: 'DeepSeek', group: 'domestic', icon: 'deepseek-color', apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash'], search: '深度求索 deep seek', docs: 'https://api-docs.deepseek.com/', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'aliyun', label: 'Qwen', group: 'domestic', icon: 'qwen-color', apiFormat: 'openai', baseUrl: '', urlPlaceholder: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', models: ['qwen3.8-max'], search: '阿里 阿里巴巴 aliyun alibaba bailian dashscope 通义 千问 qwen', docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope', keyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'volcengine', label: 'Doubao', group: 'domestic', icon: 'doubao-color', apiFormat: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: [], customModel: true, search: 'doubao volcengine 字节 bytedance 火山 方舟 ark 豆包', docs: 'https://docs.volcengine.com/docs/ark/quick-start?lang=zh', keyUrl: 'https://console.volcengine.com/ark/' },
  { id: 'moonshot', label: 'Kimi', group: 'domestic', icon: 'kimi-color', apiFormat: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3'], search: 'kimi moonshot 月之暗面', docs: 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'zhipu', label: 'GLM', group: 'domestic', icon: 'zhipu-color', apiFormat: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7'], search: '智谱 glm zhipu bigmodel', docs: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7', keyUrl: 'https://open.bigmodel.cn/' },
  { id: 'minimax', label: 'MiniMax', group: 'domestic', icon: 'minimax-color', apiFormat: 'openai', baseUrl: 'https://api.minimax.cn/v1', models: ['MiniMax-M2.7'], search: 'minimax 稀宇 海螺', docs: 'https://platform.minimax.cn/docs/api-reference/text-openai-api', keyUrl: 'https://platform.minimax.cn/' },
  { id: 'xiaomi-token-plan-cn', label: 'Xiaomi MiMo Token Plan', group: 'domestic', icon: 'xiaomimimo', mono: true, apiFormat: 'openai', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], search: '小米 xiaomi mimo token plan cn 套餐', docs: 'https://platform.xiaomimimo.com/#/docs', keyUrl: 'https://platform.xiaomimimo.com/' },
  { id: 'xiaomi', label: 'Xiaomi MiMo API', group: 'domestic', icon: 'xiaomimimo', mono: true, apiFormat: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'], search: '小米 xiaomi mimo api 按量', docs: 'https://platform.xiaomimimo.com/#/docs', keyUrl: 'https://platform.xiaomimimo.com/' },
  { id: 'baidu', label: 'ERNIE', group: 'domestic', icon: 'wenxin-color', apiFormat: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', models: [], customModel: true, search: '百度 baidu 文心 ernie 千帆 qianfan', docs: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb', keyUrl: 'https://console.bce.baidu.com/qianfan/' },
  { id: 'hunyuan', label: 'Hunyuan', group: 'domestic', icon: 'hunyuan-color', apiFormat: 'openai', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: ['hunyuan-turbos-latest'], search: '腾讯 混元 hunyuan tencent', docs: 'https://cloud.tencent.com/document/product/1729/111007', keyUrl: 'https://console.cloud.tencent.com/hunyuan/' },
  { id: 'xai', label: 'Grok', group: 'international', icon: 'grok', mono: true, apiFormat: 'openai', baseUrl: 'https://api.x.ai/v1', models: [], customModel: true, search: 'xai x.ai grok', docs: 'https://docs.x.ai/overview', keyUrl: 'https://console.x.ai/' },
  { id: 'mistral', label: 'Mistral AI', group: 'international', icon: 'mistral-color', apiFormat: 'openai', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest'], search: 'mistral 米斯特拉尔', docs: 'https://docs.mistral.ai/api/endpoint/chat', keyUrl: 'https://console.mistral.ai/' },
  { id: 'cohere', label: 'Cohere', group: 'international', icon: 'cohere-color', apiFormat: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', models: ['command-a-plus-05-2026'], search: 'cohere command', docs: 'https://docs.cohere.com/docs/compatibility-api', keyUrl: 'https://dashboard.cohere.com/api-keys' },
  { id: 'siliconflow', label: 'SiliconFlow', group: 'platform', icon: 'siliconcloud-color', apiFormat: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen3.6-27B'], search: 'siliconflow siliconcloud 硅基流动', docs: 'https://docs.siliconflow.cn/cn/usercases/use-siliconcloud-in-Qoder', keyUrl: 'https://cloud.siliconflow.cn/' },
  { id: 'openrouter', label: 'OpenRouter', group: 'platform', icon: 'openrouter', mono: true, apiFormat: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: [], customModel: true, search: 'openrouter 聚合', docs: 'https://openrouter.ai/docs/quickstart', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'ollama', label: 'Ollama', group: 'platform', icon: 'ollama', mono: true, apiFormat: 'openai', baseUrl: 'http://localhost:11434/v1', models: ['qwen3:8b'], search: 'ollama 本地 local', docs: 'https://docs.ollama.com/api/openai-compatibility', keyUrl: 'https://docs.ollama.com/api/openai-compatibility' },
]

export const PROVIDER_GROUPS: ProviderGroup[] = ['domestic', 'international', 'platform']
export const QUICK_TEXT_PROVIDER_IDS = ['claude', 'openai', 'gemini', 'deepseek', 'xiaomi-token-plan-cn', 'xiaomi']
export function textProviderById(id?: string | null): TextProvider | undefined {
  return TEXT_PROVIDERS.find(provider => provider.id === id)
}
export function defaultTextApiFormat(provider?: string | null): TextApiFormat {
  return textProviderById(provider)?.apiFormat ?? 'openai'
}
export function resolveTextApiFormat(provider: string, saved?: string | null): TextApiFormat {
  return saved === 'anthropic' || saved === 'google' || saved === 'openai' ? saved : defaultTextApiFormat(provider)
}
