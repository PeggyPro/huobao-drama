<template>
  <div class="text-provider-picker">
    <div class="picker-label-row">
      <span class="field-label">{{ t('settings.providers.commonTitle') }}</span>
      <button type="button" class="provider-link" :aria-expanded="catalogOpen" @click="toggleCatalog">
        {{ t('settings.providers.browseAll', { n: TEXT_PROVIDERS.length }) }} <ChevronDown :size="13" />
      </button>
    </div>
    <div class="provider-shortcuts">
      <button v-for="provider in quickProviders" :key="provider.id" type="button" class="provider-shortcut" :class="{ selected: modelValue === provider.id }" :aria-pressed="modelValue === provider.id" @click="pick(provider)">
        <img :src="providerIconUrl(provider.id, 'text')" alt="" />{{ copy(provider, 'short') }}
      </button>
    </div>

    <section v-if="catalogOpen" class="provider-catalog" :aria-label="t('settings.providers.catalogTitle')">
      <div class="catalog-heading">
        <div><strong>{{ t('settings.providers.catalogTitle') }}</strong><p>{{ t('settings.providers.catalogSubtitle', { n: TEXT_PROVIDERS.length }) }}</p></div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="t('settings.providers.closeCatalog')" @click="catalogOpen = false"><X :size="16" /></button>
      </div>
      <div v-for="group in PROVIDER_GROUPS" :key="group" class="catalog-section">
        <h4>{{ t(`settings.providers.groups.${group}`) }}</h4>
        <div class="catalog-grid">
          <button v-for="provider in TEXT_PROVIDERS.filter(p => p.group === group)" :key="provider.id" type="button" class="catalog-provider" :class="{ selected: modelValue === provider.id }" :aria-pressed="modelValue === provider.id" @click="pick(provider)">
            <img :src="providerIconUrl(provider.id, 'text')" alt="" /><span><strong>{{ copy(provider, 'label') }}</strong><small>{{ copy(provider, 'company') }}</small></span>
          </button>
        </div>
      </div>
    </section>

    <div class="picker-label-row provider-field-label">
      <label :id="`${pickerId}-label`" :for="`${pickerId}-trigger`" class="field-label">{{ t('settings.cfg.provider') }}</label>
      <span class="field-hint search-hint">{{ t('settings.providers.searchHint') }}</span>
    </div>
    <button :id="`${pickerId}-trigger`" ref="anchorEl" type="button" class="provider-trigger" :class="{ open: isOpen }" aria-haspopup="listbox" :aria-expanded="isOpen" :aria-controls="`${pickerId}-options`" @click="toggle" @keydown.down.prevent="open">
      <img v-if="selected" :src="providerIconUrl(selected.id, 'text')" alt="" />
      <span class="provider-trigger-copy"><strong>{{ selected ? copy(selected, 'label') : modelValue || t('settings.cfg.providerPlaceholder') }}</strong><small v-if="selected">{{ copy(selected, 'company') }}</small></span>
      <span v-if="apiFormat" class="format-badge">{{ t(`settings.providers.formats.${apiFormat}`) }}</span>
      <ChevronDown :size="16" class="trigger-chevron" />
    </button>
    <span v-if="modelValue && !selected" class="field-hint">{{ t('settings.providers.savedLegacyProvider') }}</span>

    <Teleport to="body">
      <div v-if="isOpen" ref="panelEl" class="app-menu provider-menu" :style="panelStyle" :data-placement="placement" @keydown="onMenuKeydown">
        <div class="provider-search">
          <Search :size="16" />
          <input ref="searchInput" v-model="query" :placeholder="t('settings.providers.searchPlaceholder')" :aria-label="t('settings.providers.searchLabel')" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="`${pickerId}-options`" :aria-activedescendant="highlighted ? `${pickerId}-${highlighted.id}` : undefined" autocomplete="off" />
          <kbd>Esc</kbd>
        </div>
        <div class="provider-filters">
          <button v-for="group in ['all', ...PROVIDER_GROUPS]" :key="group" type="button" :class="{ selected: filter === group }" :aria-pressed="filter === group" @click="filter = group">{{ group === 'all' ? t('settings.providers.all') : t(`settings.providers.groups.${group}`) }}</button>
        </div>
        <div :id="`${pickerId}-options`" class="provider-options" role="listbox" :aria-labelledby="`${pickerId}-label`">
          <template v-for="group in groups" :key="group.id">
            <div v-if="group.providers.length" role="group" :aria-label="t(`settings.providers.groups.${group.id}`)">
              <div class="provider-group-label">{{ t(`settings.providers.groups.${group.id}`) }} <span>· {{ group.providers.length }}</span></div>
              <div class="provider-option-grid">
                <button v-for="provider in group.providers" :id="`${pickerId}-${provider.id}`" :key="provider.id" type="button" role="option" :aria-selected="provider.id === modelValue" :tabindex="-1" class="provider-option" :class="{ selected: provider.id === modelValue, highlighted: highlighted?.id === provider.id }" @mousemove="highlight = matching.findIndex(p => p.id === provider.id)" @click="pick(provider)">
                  <img :src="providerIconUrl(provider.id, 'text')" alt="" /><span><strong>{{ copy(provider, 'label') }}</strong><small>{{ copy(provider, 'company') }} · {{ provider.id }}</small></span><Check v-if="provider.id === modelValue" :size="14" class="provider-check" />
                </button>
              </div>
            </div>
          </template>
          <p v-if="!matching.length" class="provider-empty">{{ t('settings.providers.noMatch') }}</p>
        </div>
        <div class="provider-menu-footer"><span>{{ t('settings.providers.optionCount', { n: matching.length }) }}</span><span>{{ t('settings.providers.keyboardHint') }}</span></div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Search, X } from 'lucide-vue-next'
import { usePopover } from '~/composables/usePopover'
import { providerIconUrl } from '~/composables/useProviderIcon'
import { TEXT_PROVIDERS, QUICK_TEXT_PROVIDER_IDS, PROVIDER_GROUPS, textProviderById, type TextProvider, type TextApiFormat } from '~/utils/textProviderCatalog'

const props = defineProps<{ modelValue: string; apiFormat: TextApiFormat }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const { t } = useI18n()
const pickerId = `provider-${useId()}`
const { isOpen, anchorEl, panelEl, panelStyle, placement, open, close, toggle } = usePopover({ matchWidth: true, maxHeight: 460, fitViewport: true })
const selected = computed(() => textProviderById(props.modelValue))
const quickProviders = TEXT_PROVIDERS.filter(p => QUICK_TEXT_PROVIDER_IDS.includes(p.id))
const catalogOpen = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const query = ref('')
const filter = ref('all')
const highlight = ref(0)
const copy = (provider: TextProvider, field: string) => t(`settings.providers.catalog.${provider.id}.${field}`)
const groups = computed(() => PROVIDER_GROUPS.map(id => ({
  id,
  providers: TEXT_PROVIDERS.filter(provider => {
    const terms = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const haystack = `${provider.id} ${provider.label} ${provider.search} ${copy(provider, 'label')} ${copy(provider, 'company')}`.toLocaleLowerCase()
    return provider.group === id && (filter.value === 'all' || provider.group === filter.value) && terms.every(term => haystack.includes(term))
  }),
})))
const matching = computed(() => groups.value.flatMap(group => group.providers))
const highlighted = computed(() => matching.value[highlight.value])
watch([query, filter], () => { highlight.value = 0 })
watch(isOpen, async value => {
  if (!value) return
  catalogOpen.value = false
  query.value = ''
  filter.value = 'all'
  await nextTick()
  highlight.value = Math.max(0, matching.value.findIndex(p => p.id === props.modelValue))
  searchInput.value?.focus()
  scrollHighlighted()
})
function scrollHighlighted() {
  nextTick(() => document.getElementById(`${pickerId}-${highlighted.value?.id}`)?.scrollIntoView({ block: 'nearest' }))
}
function pick(provider: TextProvider) {
  emit('update:modelValue', provider.id)
  close()
  catalogOpen.value = false
  nextTick(() => anchorEl.value?.focus())
}
function toggleCatalog() {
  close()
  catalogOpen.value = !catalogOpen.value
}
function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    anchorEl.value?.focus()
  } else if (event.key === 'Tab') {
    close()
    anchorEl.value?.focus()
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (event.key === 'Home') highlight.value = 0
    else if (event.key === 'End') highlight.value = matching.value.length - 1
    else highlight.value = Math.min(Math.max(0, highlight.value + (event.key === 'ArrowDown' ? 1 : -1)), matching.value.length - 1)
    scrollHighlighted()
  } else if (event.key === 'Enter' && event.target === searchInput.value) {
    event.preventDefault()
    if (highlighted.value) pick(highlighted.value)
  }
}
</script>

<style scoped>
.text-provider-picker { min-width: 0; }
.picker-label-row { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.field-label { margin:0; }
.provider-link { display:inline-flex; align-items:center; gap:4px; border:0; padding:0; background:none; color:var(--accent); font:inherit; font-size:12px; cursor:pointer; }
.provider-shortcuts { display:flex; flex-wrap:wrap; gap:7px; }
.provider-shortcut { display:flex; align-items:center; gap:6px; border:1px solid var(--border); border-radius:var(--radius-pill); padding:7px 12px; background:var(--bg-2); color:var(--text-1); font:inherit; font-size:12px; cursor:pointer; }
.provider-shortcut img { width:18px; height:18px; object-fit:contain; }
.provider-shortcut.selected, .catalog-provider.selected { border-color:var(--accent); background:var(--accent-bg); color:var(--accent); }
.provider-field-label { margin-top:20px; }
.provider-trigger { display:flex; align-items:center; gap:11px; width:100%; min-width:0; min-height:56px; padding:10px 14px; border:1px solid var(--border-strong); border-radius:var(--radius-lg); background:var(--bg-input); color:var(--text-0); text-align:left; font:inherit; cursor:pointer; }
.provider-trigger.open, .provider-trigger:focus-visible { border-color:var(--accent); outline:2px solid var(--accent-bg); }
.provider-trigger img, .provider-option img, .catalog-provider img { width:26px; height:26px; flex-shrink:0; object-fit:contain; }
.provider-trigger-copy { display:flex; flex:1; flex-wrap:wrap; align-items:baseline; gap:5px 9px; min-width:0; }
.provider-trigger-copy strong { font-size:14px; }
.provider-trigger-copy small { color:var(--text-2); font-size:12px; }
.format-badge { flex-shrink:0; padding:3px 8px; font-size:10px; background:var(--bg-3); border-radius:var(--radius-pill); color:var(--text-2); }
.trigger-chevron { flex-shrink:0; color:var(--text-2); }
.provider-menu { display:flex; flex-direction:column; padding:0; overflow:hidden; max-width:calc(100vw - 24px); }
.provider-search { display:flex; align-items:center; gap:9px; padding:13px 15px; border-bottom:1px solid var(--border); color:var(--text-2); flex-shrink:0; }
.provider-search input { min-width:0; flex:1; border:0; outline:none; background:none; font:inherit; font-size:13px; color:var(--text-0); }
.provider-search kbd { font-size:10px; border:1px solid var(--border); border-radius:4px; padding:0 4px; }
.provider-filters { display:flex; flex-wrap:wrap; gap:4px; padding:9px 12px 4px; flex-shrink:0; }
.provider-filters button { border:0; padding:5px 9px; border-radius:var(--radius-pill); background:none; color:var(--text-2); font:inherit; font-size:11px; cursor:pointer; }
.provider-filters button.selected { color:var(--accent); background:var(--accent-bg); }
.provider-options { overflow-y:auto; min-height:0; max-height:310px; padding:6px 10px 10px; }
.provider-group-label { padding:9px 5px 7px; font-size:11px; color:var(--text-2); font-weight:600; }
.provider-group-label span { font-weight:400; }
.provider-option-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; }
.provider-option { display:flex; align-items:center; gap:9px; min-width:0; padding:10px; border:1px solid transparent; border-radius:var(--radius-md); background:none; color:var(--text-0); text-align:left; font:inherit; cursor:pointer; }
.provider-option > span { min-width:0; flex:1; }
.provider-option strong, .catalog-provider strong { display:block; font-size:12px; line-height:1.4; font-weight:600; }
.provider-option small, .catalog-provider small { display:block; font-size:10px; color:var(--text-2); line-height:1.4; overflow-wrap:anywhere; margin-top:3px; }
.provider-option.highlighted { background:var(--bg-3); }
.provider-option.selected { background:var(--accent-bg); border-color:var(--border-focus); }
.provider-check { color:var(--accent); flex-shrink:0; }
.provider-menu-footer { display:flex; justify-content:space-between; gap:10px; padding:10px 15px; border-top:1px solid var(--border); color:var(--text-2); font-size:10px; flex-shrink:0; }
.provider-empty { padding:25px 10px; color:var(--text-2); font-size:12px; text-align:center; }
.provider-catalog { margin-top:15px; padding:16px; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--bg-2); }
.catalog-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; font-size:13px; }
.catalog-heading p { color:var(--text-2); font-size:11px; margin:5px 0 0; }
.catalog-section h4 { color:var(--text-2); font-size:11px; margin:16px 0 8px; }
.catalog-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
.catalog-provider { display:flex; align-items:center; gap:8px; min-width:0; padding:10px 9px; border:1px solid var(--border); border-radius:var(--radius-md); background:var(--bg-1); color:var(--text-0); font:inherit; text-align:left; cursor:pointer; }
.catalog-provider > span { min-width:0; }
button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (max-width:640px) {
  .search-hint { display:none; }
  .provider-shortcut { padding:6px 9px; font-size:11px; }
  .provider-trigger-copy { display:block; }
  .provider-trigger-copy small { display:block; margin-top:3px; }
  .format-badge { display:none; }
  .provider-option-grid { grid-template-columns:1fr; }
  .provider-options { max-height:280px; }
  .catalog-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .provider-catalog { padding:12px; }
  .catalog-provider { padding:9px 7px; gap:6px; }
  .catalog-provider img { width:22px; height:22px; }
}
</style>
