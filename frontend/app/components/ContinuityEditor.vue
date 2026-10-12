<script setup lang="ts">
import { computed } from 'vue'
import { useContinuityText } from '~/composables/useContinuityText'
import { continuityPlan, type ContinuityPlan, type ContinuityMode, type ContinuityRelation } from '~/utils/continuity'
const props = defineProps<{ storyboard: any; previous?: any; saving: boolean; h3: boolean; wan: boolean }>()
const emit = defineEmits<{ save: [plan: ContinuityPlan] }>()
const { ct } = useContinuityText()
const plan = computed(() => continuityPlan(props.storyboard))
const unsupported = computed(() => plan.value.mode === 'motion_context' ? !props.h3 : plan.value.mode === 'tail_frame' && !props.h3 && !props.wan)
function save(patch: Partial<ContinuityPlan>) {
  const next = { ...plan.value, ...patch, origin: 'manual' as const, needs_review: false }
  next.mode = props.previous ? next.mode : 'independent'
  next.source_storyboard_id = next.mode === 'independent' ? null : Number(props.previous.id)
  emit('save', next)
}
function text(event: Event) { return (event.target as HTMLInputElement).value }
</script>

<template>
  <section class="continuity-editor" :aria-label="ct('title')">
    <div class="continuity-heading"><strong>{{ ct('title') }}</strong><span>{{ saving ? ct('saving') : ct(plan.origin) }}</span><span v-if="plan.needs_review" class="continuity-warning">{{ ct('review') }}</span></div>
    <label>{{ ct('mode') }}
      <select :value="plan.mode" :disabled="saving" @change="save({ mode: text($event) as ContinuityMode })">
        <option value="independent">{{ ct('independent') }}</option>
        <option value="tail_frame" :disabled="!previous || (!h3 && !wan)">{{ ct('tail_frame') }}</option>
        <option value="motion_context" :disabled="!previous || !h3">{{ ct('motion_context') }}</option>
      </select>
    </label>
    <p v-if="!previous">{{ ct('first') }}</p>
    <p v-else-if="plan.mode !== 'independent'">{{ ct('source', { n: previous.storyboard_number ?? previous.storyboardNumber }) }} · {{ ct('sourceQueued') }}</p>
    <p v-if="unsupported" class="continuity-warning">{{ ct(plan.mode === 'motion_context' ? 'h3Only' : 'unsupported') }}</p>
    <label>{{ ct('relation') }}
      <select :value="plan.relation" :disabled="saving" @change="save({ relation: text($event) as ContinuityRelation })">
        <option v-for="relation in ['continuous_action', 'same_scene_cut', 'scene_change', 'time_change', 'unknown']" :key="relation" :value="relation">{{ ct(relation) }}</option>
      </select>
    </label>
    <details>
      <summary>{{ ct('reason') }} · {{ ct('start') }} / {{ ct('end') }}</summary>
      <label v-for="field in ['reason', 'start_state', 'end_state'] as const" :key="field">{{ ct(field === 'start_state' ? 'start' : field === 'end_state' ? 'end' : field) }}
        <textarea :value="plan[field]" :disabled="saving" rows="2" @change="save({ [field]: text($event) })" />
      </label>
    </details>
    <div v-if="plan.suggestion" class="continuity-suggestion">
      <strong>{{ ct('suggestion') }}: {{ ct(plan.suggestion.mode) }}</strong>
      <p>{{ ct(plan.suggestion.relation) }} · {{ plan.suggestion.reason }}</p>
      <button type="button" class="btn btn-sm" :disabled="saving || (plan.suggestion.mode === 'motion_context' && !h3) || (plan.suggestion.mode === 'tail_frame' && !h3 && !wan)" @click="save({ ...plan.suggestion, suggestion: null })">{{ ct('applySuggestion') }}</button>
    </div>
  </section>
</template>

<style scoped>
.continuity-editor { display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--surface-outline); font-size: 12px; }
.continuity-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.continuity-heading span, p, summary { color: var(--text-3); font-size: 11px; line-height: 1.6; }
p { margin: 0; }
label { display: grid; gap: 5px; color: var(--text-2); }
select, textarea { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--surface-outline); border-radius: var(--radius); background: var(--bg-2); color: var(--text-0); font: inherit; }
details label { margin-top: 8px; } summary { cursor: pointer; }
.continuity-warning { color: var(--warning, #d99c39) !important; }
.continuity-suggestion { display: grid; gap: 7px; padding: 10px; background: var(--bg-2); border-radius: var(--radius); }
.continuity-suggestion button { justify-self: start; }
</style>
