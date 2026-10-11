import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import { loadTs } from './helpers/load-ts.mjs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const catalog = loadTs('app/utils/textProviderCatalog.ts')
const { TEXT_PROVIDERS, defaultTextApiFormat, resolveTextApiFormat } = catalog
const { MEDIA_PROVIDERS, MEDIA_PROVIDER_PRESETS } = loadTs('app/utils/mediaProviderPresets.ts')
const settingsPage = read('app/pages/settings.vue')
const dialog = read('app/components/AIServiceConfigDialog.vue')
const approved = JSON.parse(read('../design-previews/ai-providers/providers.json'))

const expectedIds = ['claude', 'openai', 'gemini', 'deepseek', 'aliyun', 'volcengine', 'moonshot', 'zhipu', 'minimax', 'xiaomi-token-plan-cn', 'xiaomi', 'baidu', 'hunyuan', 'xai', 'mistral', 'cohere', 'siliconflow', 'openrouter', 'ollama']

test('text catalog contains all 19 approved providers, their examples and documentation', () => {
  assert.deepEqual(TEXT_PROVIDERS.map(p => p.id), expectedIds)
  assert.equal(new Set(TEXT_PROVIDERS.map(p => p.icon)).size, 18)
  for (const preset of approved) {
    const provider = TEXT_PROVIDERS.find(p => p.id === preset.id)
    assert.equal(provider.baseUrl, preset.url, preset.id)
    assert.deepEqual(provider.models, preset.models, preset.id)
    assert.equal(provider.docs, preset.docs, preset.id)
    assert.equal(provider.keyUrl, preset.keyUrl, preset.id)
    assert.equal(provider.group, preset.group, preset.id)
  }
  assert.equal(TEXT_PROVIDERS.find(p => p.id === 'aliyun').baseUrl, '', 'workspace URL must be entered by the user')
})

test('legacy formats resolve to the provider default while saved formats stay explicit', () => {
  for (const id of expectedIds) assert.equal(defaultTextApiFormat(id), id === 'claude' ? 'anthropic' : id === 'gemini' ? 'google' : 'openai')
  assert.equal(resolveTextApiFormat('claude', 'openai'), 'openai')
  assert.equal(resolveTextApiFormat('gemini', undefined), 'google')
  assert.equal(resolveTextApiFormat('legacy-custom', undefined), 'openai')
})

test('four locales cover every provider and all new UI messages compile', () => {
  let referenceKeys
  for (const language of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${language}.json`))
    assert.deepEqual(Object.keys(locale.settings.providers.catalog), expectedIds)
    const keys = []
    function collect(value, prefix) {
      for (const [key, child] of Object.entries(value)) {
        const path = `${prefix}.${key}`
        if (typeof child === 'string') keys.push(path)
        else collect(child, path)
      }
    }
    collect(locale.settings.providers, 'settings.providers')
    referenceKeys ??= keys
    assert.deepEqual(keys, referenceKeys)
    const i18n = createI18n({ legacy: false, locale: language, messages: { [language]: locale } })
    for (const key of keys) {
      const message = i18n.global.t(key, { n: 19, max: 1 })
      assert.ok(message && message !== key, `${language}: ${key}`)
    }
  }
})

test('all provider icons resolve in both themes with a dark Kimi plate and MIT attribution', () => {
  const resolvedTheme = ref('light')
  const icons = loadTs('app/composables/useProviderIcon.ts', {
    '~/composables/useTheme': { resolvedTheme },
    '~/utils/textProviderCatalog': catalog,
  })
  for (const theme of ['light', 'dark']) {
    resolvedTheme.value = theme
    for (const provider of TEXT_PROVIDERS) {
      const url = icons.providerIconUrl(provider.id, 'text')
      assert.ok(existsSync(new URL(`../app/public${url}`, import.meta.url)), `${theme}: ${provider.id}`)
      if (provider.mono && theme === 'dark') assert.match(url, /\/dark\//)
    }
    assert.match(icons.providerIconUrl('moonshot'), /kimi-color-badge\.svg$/)
    assert.match(icons.providerIconUrl('volcengine', 'video'), /volcengine-color\.png$/)
    assert.match(icons.providerIconUrl('volcengine', 'text'), /doubao-color\.svg$/)
    assert.match(icons.modelIconUrl('openai', 'mimo-v2.6-pro'), /xiaomimimo\.svg$/)
    assert.match(icons.modelIconUrl('openrouter', 'hunyuan-turbos-latest'), /hunyuan-color\.svg$/)
  }
  const kimi = read('app/public/provider-icons/kimi-color-badge.svg')
  const plate = kimi.match(/<rect[^>]+fill="#([0-9a-f]{6})"/i)?.[1]
  assert.ok(plate && plate.match(/../g).every(channel => parseInt(channel, 16) < 60), 'white Kimi glyph needs a dark backplate')
  assert.match(read('app/public/provider-icons/LICENSE-icons.txt'), /MIT License/)
  assert.match(read('app/public/provider-icons/README.md'), /@lobehub\/icons-static-svg@1\.95\.1/)
})

test('image and video presets retain their original providers, endpoints and models', () => {
  assert.deepEqual(MEDIA_PROVIDERS, ['gemini', 'openai', 'volcengine', 'minimax', 'aliyun', 'comfyui'])
  assert.deepEqual(Object.keys(MEDIA_PROVIDER_PRESETS.image), ['gemini', 'openai', 'comfyui'])
  assert.deepEqual(Object.keys(MEDIA_PROVIDER_PRESETS.video), ['aliyun', 'volcengine', 'minimax', 'comfyui'])
  assert.equal(MEDIA_PROVIDER_PRESETS.image.openai.baseUrl, 'https://api.openai.com')
  assert.deepEqual(MEDIA_PROVIDER_PRESETS.image.openai.models, ['gpt-image-2'])
  assert.equal(MEDIA_PROVIDER_PRESETS.video.minimax.baseUrl, 'https://api.minimaxi.com')
  assert.deepEqual(MEDIA_PROVIDER_PRESETS.video.aliyun.models, ['wan3.0-video', 'wan3.0-video-prime'])
  assert.equal(MEDIA_PROVIDER_PRESETS.video.volcengine.baseUrl, 'https://ark.cn-beijing.volces.com')
  assert.deepEqual(MEDIA_PROVIDER_PRESETS.video.volcengine.models, ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128'])
})

test('saved text test action opens the explicit model test and never probes on mount', () => {
  assert.match(settingsPage, /v-if="st\.type === 'text'" class="btn btn-ghost btn-sm" @click="testExistingCfg\(c\)"/)
  assert.match(settingsPage, /function testExistingCfg\(config\) \{\s*startEditCfg\(config\)\s*cfgFocusTest\.value = true/)
  assert.doesNotMatch(settingsPage, /aiConfigAPI\.test/)
  assert.match(dialog, /if \(response\.ok\) toast\.success/)
  assert.doesNotMatch(dialog, /if \(response\.reachable\) toast\.success/)
  assert.match(dialog, /:max="maxTemperature"/)
  assert.match(dialog, /form\.api_format === 'anthropic' \? 1 : 2/)
})
