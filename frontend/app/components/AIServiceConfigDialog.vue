<template>
  <div class="overlay ai-config-overlay" @keydown.esc.prevent.stop="onEscape">
    <form ref="dialogEl" class="dialog ai-config-dialog" role="dialog" aria-modal="true" :aria-labelledby="`${formId}-title`" @submit.prevent="save" @keydown="trapFocus">
      <div class="dialog-head">
        <div>
          <h2 :id="`${formId}-title`" class="dialog-title">{{ config?.id ? t('settings.cfg.editTitle') : t('settings.cfg.addTitle', { type: typeLabel }) }}</h2>
          <p class="dialog-sub">{{ t('settings.cfg.sub') }}</p>
        </div>
        <span class="tag tag-accent">{{ typeLabel }}</span>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="t('common.cancel')" :disabled="saving" @click="requestClose"><X :size="17" /></button>
      </div>
      <div class="dialog-body ai-config-body">
        <fieldset :disabled="saving" class="config-fields">
          <TextProviderPicker v-if="isText" :model-value="form.provider" :api-format="form.api_format" @update:model-value="chooseProvider" />
          <template v-else>
            <div class="media-presets">
              <button v-for="(preset, provider) in mediaPresets" :key="provider" type="button" class="btn btn-sm" :class="{ 'btn-primary': form.provider === provider }" @click="chooseMediaProvider(String(provider))">{{ preset.label }}</button>
            </div>
            <div class="field"><span class="field-label">{{ t('settings.cfg.provider') }}</span><BaseSelect :model-value="form.provider" :options="mediaOptions" :placeholder="t('settings.cfg.providerPlaceholder')" searchable @update:model-value="chooseMediaProvider" /></div>
          </template>
          <label class="field">
            <span class="field-label">{{ t('settings.cfg.name') }}</span>
            <input ref="nameInput" v-model="form.name" class="input" :placeholder="t('settings.cfg.namePlaceholder')" />
          </label>
          <div v-if="isText && form.provider === 'claude'" class="format-row">
            <div><span class="field-label">{{ t('settings.providers.formatLabel') }}</span><p class="field-hint">{{ t('settings.providers.formatHint') }}</p></div>
            <div class="format-choices" :aria-label="t('settings.providers.formatLabel')" role="group">
              <button v-for="format in claudeFormats" :key="format" type="button" :class="{ selected: form.api_format === format }" :aria-pressed="form.api_format === format" @click="chooseFormat(format)">{{ t(`settings.providers.formats.${format}`) }}</button>
            </div>
          </div>
          <p v-if="credentialCleared" class="credential-note" role="status"><ShieldCheck :size="14" />{{ t('settings.providers.credentialCleared') }}</p>
          <div class="field">
            <div class="field-heading"><label :for="`${formId}-key`" class="field-label">API Key</label><a v-if="provider && !claudeCompatible" :href="provider.keyUrl" target="_blank" rel="noopener noreferrer">{{ t('settings.providers.getKey') }}<ExternalLink :size="12" /></a></div>
            <div class="key-input">
              <input :id="`${formId}-key`" v-model="form.api_key" class="input" :type="showKey ? 'text' : 'password'" :placeholder="keyPlaceholder" autocomplete="new-password" spellcheck="false" @input="credentialCleared = false" />
              <button type="button" class="key-visibility" :aria-label="t(showKey ? 'settings.providers.hideKey' : 'settings.providers.showKey')" :aria-pressed="showKey" @click="showKey = !showKey"><EyeOff v-if="showKey" :size="16" /><Eye v-else :size="16" /></button>
            </div>
            <span v-if="isText" class="field-hint">{{ keyHint }}</span>
          </div>
          <div class="field">
            <div class="field-heading"><label :for="`${formId}-url`" class="field-label">Base URL</label><span v-if="isText" class="field-hint">{{ t(claudeCompatible ? 'settings.providers.customUrl' : 'settings.providers.urlCustomHint') }}</span></div>
            <input :id="`${formId}-url`" :value="form.base_url" class="input mono" :placeholder="urlPlaceholder" spellcheck="false" autocomplete="off" @input="editBaseUrl" />
            <span v-if="isText" class="field-hint">{{ urlHint }}</span>
          </div>
          <div class="field">
            <div class="field-heading"><label :for="`${formId}-model`" class="field-label">{{ t('settings.cfg.models') }}</label><a v-if="provider && !claudeCompatible" :href="provider.docs" target="_blank" rel="noopener noreferrer">{{ t('settings.providers.modelDocs') }}<ExternalLink :size="12" /></a></div>
            <div v-if="form.models.length" class="model-chips">
              <span v-for="(model, index) in form.models" :key="`${model}-${index}`" class="model-chip" :class="{ 'is-default': index === 0 }">
                <button type="button" class="model-name" :title="t('settings.cfg.modelChipHint')" @click="pinModel(index)">{{ model }}</button><em v-if="index === 0">{{ t('common.default') }}</em><button type="button" class="model-remove" :aria-label="`${t('common.delete')} ${model}`" @click="form.models.splice(index, 1)"><X :size="12" /></button>
              </span>
            </div>
            <div class="model-add-row"><input :id="`${formId}-model`" v-model="modelInput" class="input" :placeholder="modelPlaceholder" spellcheck="false" @keydown.enter.prevent="addModels()" @paste="pasteModels" /><button type="button" class="btn btn-sm" :disabled="!modelInput.trim()" @click="addModels()">{{ t('common.add') }}</button></div>
            <span class="field-hint">{{ t(isText ? 'settings.providers.modelsHint' : 'settings.cfg.modelsHint') }}</span>
          </div>
          <div class="advanced-fields">
            <label class="field"><span class="field-label">{{ t('settings.cfg.priority') }}</span><input v-model.number="form.priority" class="input" type="number" min="0" max="999" /><span class="field-hint">{{ t('settings.cfg.priorityHint') }}</span></label>
            <label v-if="isText" class="field"><span class="field-label">Temperature <span class="dim">({{ t('settings.cfg.tempHint') }})</span></span><input v-model="form.temperature" class="input" type="number" step="0.1" min="0" :max="maxTemperature" :placeholder="t('settings.cfg.tempPlaceholder')" /><span class="field-hint">{{ t('settings.cfg.tempNote') }} (0–{{ maxTemperature }})</span></label>
          </div>
        </fieldset>
        <p v-if="isText" class="probe-notice"><Info :size="14" />{{ t('settings.providers.testNotice') }}</p>
        <div v-if="result" class="test-result" :class="result.ok ? 'ok' : result.reachable ? 'warning' : 'bad'" role="status" aria-live="polite">
          <div class="test-result-head"><Check v-if="result.ok" :size="15" /><AlertCircle v-else :size="15" /><strong>{{ t(result.ok ? 'settings.providers.testSuccess' : result.reachable ? 'settings.providers.testReachable' : 'settings.providers.testFailed') }}</strong><span v-if="result.status" class="mono">{{ result.status }}</span></div>
          <p v-if="result.message">{{ result.message }}</p>
          <div v-if="result.url" class="mono test-result-url">{{ result.method }} {{ result.url }}</div>
          <pre v-if="result.response_preview" class="test-result-preview">{{ result.response_preview }}</pre>
        </div>
      </div>
      <div class="dialog-foot">
        <button ref="testButton" type="button" class="btn btn-ghost test-draft-btn" :disabled="testing || saving || (isText && !form.models.length && !modelInput.trim())" @click="testDraft"><Loader2 v-if="testing" :size="13" class="animate-spin" />{{ t(isText ? 'settings.providers.testModel' : 'settings.cfg.test') }}</button>
        <button type="button" class="btn" :disabled="saving" @click="requestClose">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn btn-primary" :disabled="saving"><Loader2 v-if="saving" :size="13" class="animate-spin" />{{ t('common.save') }}</button>
      </div>
    </form>
    <Teleport to="body">
      <div v-if="showDiscardConfirm" class="overlay ai-discard-overlay" @click.self="showDiscardConfirm = false" @keydown="trapFocus">
        <div ref="discardDialogEl" class="dialog ai-discard-dialog" role="alertdialog" aria-modal="true" tabindex="-1" :aria-labelledby="`${formId}-discard-title`" @keydown.esc.prevent.stop="showDiscardConfirm = false">
          <h2 :id="`${formId}-discard-title`" class="dialog-title">{{ t('settings.providers.unsavedTitle') }}</h2>
          <p class="discard-message">{{ t('settings.providers.unsavedMessage') }}</p>
          <div class="dialog-foot discard-foot">
            <button type="button" class="btn btn-primary" @click="showDiscardConfirm = false">{{ t('settings.providers.keepEditing') }}</button>
            <button type="button" class="btn btn-danger" @click="confirmDiscard">{{ t('settings.providers.discardChanges') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Check, ExternalLink, Eye, EyeOff, Info, Loader2, ShieldCheck, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import BaseSelect from '~/components/BaseSelect.vue'
import TextProviderPicker from '~/components/TextProviderPicker.vue'
import { aiConfigAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { useAIConfigForm, useConfigProbe, applyTextProvider, applyTextFormat, changeDraftBaseUrl, aiConfigPayload, type SavedAIConfig, type ServiceType } from '~/composables/useAIConfigForm'
import { textProviderById, type TextApiFormat } from '~/utils/textProviderCatalog'
import { MEDIA_PROVIDERS, MEDIA_PROVIDER_PRESETS } from '~/utils/mediaProviderPresets'

const props = withDefaults(defineProps<{ config?: SavedAIConfig | null; serviceType?: ServiceType; focusTest?: boolean }>(), { config: null, serviceType: 'text', focusTest: false })
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()
const formId = `ai-config-${useId()}`
const { form, modelInput, addModels, pinModel } = useAIConfigForm(props.config, props.serviceType)
const { testing, result, run, invalidate } = useConfigProbe(form, modelInput, aiConfigAPI.test)
const isText = computed(() => form.service_type === 'text')
const typeLabel = computed(() => t(`common.serviceType.${form.service_type}`))
const provider = computed(() => isText.value ? textProviderById(form.provider) : undefined)
const claudeFormats: TextApiFormat[] = ['anthropic', 'openai']
const claudeCompatible = computed(() => form.provider === 'claude' && form.api_format === 'openai')
const maxTemperature = computed(() => isText.value && form.api_format === 'anthropic' ? 1 : 2)
const mediaPresets = computed(() => MEDIA_PROVIDER_PRESETS[form.service_type] ?? {})
const mediaOptions = computed(() => [...new Set([...MEDIA_PROVIDERS, form.provider].filter(Boolean))].map(value => ({ value, label: value })))
const catalogCopy = (field: string, fallback: string) => provider.value ? t(`settings.providers.catalog.${provider.value.id}.${field}`) : t(`settings.providers.${fallback}`)
const keyHint = computed(() => claudeCompatible.value ? t('settings.providers.compatibilityKeyHint') : catalogCopy('keyHint', 'defaultKeyHint'))
const keyPlaceholder = computed(() => claudeCompatible.value ? t('settings.providers.compatibilityKeyPlaceholder') : provider.value?.keyPlaceholder ?? t('settings.providers.defaultKeyPlaceholder'))
const urlHint = computed(() => claudeCompatible.value ? t('settings.providers.compatibilityUrlHint') : catalogCopy('urlHint', 'defaultUrlHint'))
const urlPlaceholder = computed(() => claudeCompatible.value ? t('settings.providers.compatibilityUrlPlaceholder') : provider.value?.urlPlaceholder ?? 'https://…')
const modelPlaceholder = computed(() => claudeCompatible.value ? t('settings.providers.customModelPlaceholder') : isText.value ? catalogCopy('modelPlaceholder', 'customModelPlaceholder') : t('settings.cfg.modelPlaceholder'))
const credentialCleared = ref(false)
const showKey = ref(false)
const saving = ref(false)
const dialogEl = ref<HTMLFormElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const testButton = ref<HTMLButtonElement | null>(null)
let previousFocus: HTMLElement | null = null
let mounted = true

// 未保存内容保护：误触关闭弹窗不得丢失已填写内容。
function formSnapshot() {
  return JSON.stringify({ ...form, models: [...form.models], modelInput: modelInput.value })
}
const baseline = ref('')
const isDirty = computed(() => !!baseline.value && formSnapshot() !== baseline.value)
const showDiscardConfirm = ref(false)
const discardDialogEl = ref<HTMLDivElement | null>(null)
function markClean() { baseline.value = formSnapshot() }
function openDiscardConfirm() {
  showDiscardConfirm.value = true
  nextTick(() => discardDialogEl.value?.focus())
}

function chooseProvider(id: string) {
  const hadKey = !!form.api_key
  const oldDefaultName = `${textProviderById(form.provider)?.label}-text`
  if (!applyTextProvider(form, id)) return
  if (form.name === oldDefaultName) form.name = `${textProviderById(id)?.label}-text`
  modelInput.value = ''
  showKey.value = false
  credentialCleared.value = hadKey
}
function chooseFormat(format: TextApiFormat) {
  const hadKey = !!form.api_key
  if (!applyTextFormat(form, format)) return
  modelInput.value = ''
  showKey.value = false
  credentialCleared.value = hadKey
}
function chooseMediaProvider(id: string) {
  if (form.provider === id) return
  const preset = mediaPresets.value[id]
  credentialCleared.value = !!form.api_key
  form.provider = id
  form.api_key = ''
  form.base_url = preset?.baseUrl ?? ''
  form.models = [...(preset?.models ?? [])]
  if (!form.name) form.name = `${preset?.label ?? id}-${form.service_type}`
  modelInput.value = ''
  showKey.value = false
}
function editBaseUrl(event: Event) {
  if (changeDraftBaseUrl(form, (event.target as HTMLInputElement).value)) {
    credentialCleared.value = true
    showKey.value = false
  }
}
function pasteModels(event: ClipboardEvent) {
  const value = event.clipboardData?.getData('text') ?? ''
  if (!/[,，\n]/.test(value)) return
  event.preventDefault()
  addModels(value)
}
function validate() {
  if (modelInput.value.trim()) addModels()
  if (!form.provider) { toast.warning(t('settings.cfg.providerRequired')); return false }
  if (isText.value) {
    if (!form.models.length) { toast.warning(t('settings.providers.modelRequired')); return false }
    if (!form.base_url.trim()) { toast.warning(t('settings.providers.urlRequired')); return false }
    try {
      const url = new URL(form.base_url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[{}]/.test(form.base_url)) throw new Error('invalid URL')
    } catch { toast.warning(t('settings.providers.invalidUrl')); return false }
  }
  const temperature = aiConfigPayload(form).temperature
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > maxTemperature.value)) {
    toast.warning(t('settings.providers.tempInvalid', { max: maxTemperature.value })); return false
  }
  return true
}
async function testDraft() {
  if (testing.value || saving.value || !validate()) return
  try {
    const response = await run(aiConfigPayload(form))
    if (!response || !mounted) return
    if (response.ok) toast.success(t('settings.providers.testSuccess'))
    else toast.warning(t(response.reachable ? 'settings.providers.testReachable' : 'settings.providers.testFailed'))
  } catch (error) { if (mounted) toastError(error) }
}
async function save() {
  if (saving.value || !validate()) return
  saving.value = true
  invalidate()
  try {
    const payload = aiConfigPayload(form)
    if (props.config?.id) await aiConfigAPI.update(props.config.id, payload)
    else await aiConfigAPI.create(payload)
    toast.success(t('common.saved'))
    emit('saved')
  } catch (error) { toastError(error) }
  finally { saving.value = false }
}
function closeNow() {
  if (saving.value) return
  showDiscardConfirm.value = false
  invalidate()
  emit('close')
}
function requestClose() {
  if (saving.value) return
  if (isDirty.value) { openDiscardConfirm(); return }
  closeNow()
}
function onEscape() {
  if (showDiscardConfirm.value) { showDiscardConfirm.value = false; return }
  requestClose()
}
// 焦点被误点移到弹窗外部（遮罩不可聚焦，焦点会落到 body）时，
// 弹窗自身的 @keydown.esc 收不到事件；这里兜底，保证 Esc 仍可安全取消。
// 只在焦点真正丢失时介入：弹窗内部与服务商下拉等浮层（Teleport 到 body）里的 Esc
// 交由各自处理器，避免关闭浮层时误关整个弹窗。
function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (event.target !== document.body && event.target !== document.documentElement) return
  event.preventDefault()
  if (showDiscardConfirm.value) { showDiscardConfirm.value = false; return }
  requestClose()
}
function confirmDiscard() {
  showDiscardConfirm.value = false
  closeNow()
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : dialogEl.value
  if (!root) return
  const focusable = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')].filter(el => el.getClientRects().length)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
// Initial defaults only apply to a new form. Reopening an existing config never
// runs a provider/format change handler and never triggers a model request.
if (!props.config) {
  if (isText.value) chooseProvider('claude')
  else chooseMediaProvider(Object.keys(mediaPresets.value)[0] ?? MEDIA_PROVIDERS[0]!)
}
markClean()
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', onDocumentKeydown, true)
  await nextTick()
  if (props.focusTest) testButton.value?.focus()
  else nameInput.value?.focus()
})
onBeforeUnmount(() => {
  mounted = false
  document.removeEventListener('keydown', onDocumentKeydown, true)
  invalidate()
  previousFocus?.focus()
})
</script>

<style scoped>
.ai-config-dialog { width:min(820px, calc(100vw - 40px)); max-width:none; }
.dialog-head { gap:12px; }
.dialog-head > div { flex:1; min-width:0; }
.dialog-title { margin:0; }
.dialog-sub { margin:6px 0 0; }
.ai-config-body { padding:24px 28px; }
.config-fields { display:flex; flex-direction:column; gap:19px; border:0; padding:0; margin:0; min-width:0; }
.field { min-width:0; margin:0; }
.field-label { font-size:12px; }
.field-hint { font-size:11px; line-height:1.6; overflow-wrap:anywhere; }
.field-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:7px; }
.field-heading .field-label { margin:0; }
.field-heading a { display:inline-flex; align-items:center; gap:4px; flex-shrink:0; color:var(--accent); font-size:11px; text-decoration:none; }
.field-heading a:hover { text-decoration:underline; }
.media-presets { display:flex; flex-wrap:wrap; gap:7px; }
.format-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:13px 15px; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--bg-2); }
.format-row p { margin:5px 0 0; }
.format-choices { display:flex; flex-shrink:0; gap:3px; padding:3px; background:var(--bg-3); border-radius:var(--radius-md); }
.format-choices button { padding:7px 10px; border:1px solid transparent; border-radius:var(--radius-sm); background:none; color:var(--text-2); font:inherit; font-size:11px; cursor:pointer; }
.format-choices button.selected { background:var(--bg-1); border-color:var(--border); color:var(--accent); box-shadow:var(--shadow-sm); }
.key-input { position:relative; }
.key-input .input { padding-right:44px; }
.key-visibility { position:absolute; top:0; right:3px; height:100%; width:38px; display:grid; place-items:center; border:0; background:none; color:var(--text-2); cursor:pointer; }
.credential-note, .probe-notice { display:flex; gap:7px; align-items:flex-start; font-size:11px; line-height:1.7; color:var(--text-2); margin:0; }
.credential-note { color:var(--accent); }
.credential-note svg, .probe-notice svg { flex-shrink:0; margin-top:3px; }
.probe-notice { padding-top:18px; }
.model-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
.model-chip { display:inline-flex; align-items:center; gap:5px; max-width:100%; border:1px solid var(--border); border-radius:var(--radius-pill); background:var(--bg-2); padding:4px 7px 4px 10px; color:var(--text-1); }
.model-chip.is-default { color:var(--accent); background:var(--accent-bg); border-color:var(--border-focus); }
.model-name { min-width:0; background:none; border:0; padding:0; color:inherit; font-family:var(--font-mono); font-size:11px; overflow-wrap:anywhere; text-align:left; cursor:pointer; }
.model-chip em { font-style:normal; flex-shrink:0; font-size:9px; }
.model-remove { flex-shrink:0; display:grid; place-items:center; width:19px; height:19px; padding:0; border:0; border-radius:50%; background:none; color:inherit; cursor:pointer; }
.model-remove:hover { background:var(--bg-3); }
.model-add-row { display:flex; gap:8px; margin-bottom:6px; }
.model-add-row .input { min-width:0; flex:1; }
.advanced-fields { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.test-result { margin-top:16px; border:1px solid var(--border); padding:13px; border-radius:var(--radius-md); background:var(--bg-2); font-size:12px; }
.test-result.ok { border-color:var(--success); }
.test-result.warning { border-color:var(--accent); }
.test-result.bad { border-color:var(--error); }
.test-result-head { display:flex; gap:7px; align-items:center; }
.test-result-head strong { flex:1; font-size:12px; }
.test-result.ok .test-result-head { color:var(--success); }
.test-result.warning .test-result-head { color:var(--accent); }
.test-result.bad .test-result-head { color:var(--error); }
.test-result p { margin:8px 0; overflow-wrap:anywhere; }
.test-result-url, .test-result-preview { font-size:11px; overflow-wrap:anywhere; white-space:pre-wrap; }
.test-result-preview { max-height:150px; overflow:auto; margin:8px 0 0; padding-top:8px; border-top:1px solid var(--border); }
.test-draft-btn { margin-right:auto; }
.ai-discard-overlay { z-index:1300; }
.ai-discard-dialog { width:min(420px, calc(100vw - 32px)); padding:22px 22px 18px; }
.ai-discard-dialog:focus { outline:none; }
.ai-discard-dialog .dialog-title { margin:0 0 10px; font-size:15px; }
.discard-message { margin:0 0 18px; font-size:12.5px; line-height:1.75; color:var(--text-2); }
.ai-discard-dialog .discard-foot { padding:0; border-top:0; justify-content:flex-end; }
button:focus-visible, a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media(max-width:640px) {
  .ai-config-overlay { padding:10px; }
  .ai-config-dialog { width:100%; max-height:calc(100dvh - 20px); }
  .dialog-head, .dialog-foot { padding:16px 18px; }
  .dialog-head .tag { display:none; }
  .ai-config-body { padding:18px; }
  .config-fields { gap:16px; }
  .format-row { flex-direction:column; align-items:stretch; }
  .format-choices button { flex:1; }
  .advanced-fields { grid-template-columns:1fr; gap:16px; }
  .dialog-foot { gap:7px; flex-wrap:wrap; }
  .dialog-foot .btn { padding-left:12px; padding-right:12px; }
}
</style>
