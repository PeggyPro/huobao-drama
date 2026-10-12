<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { mergeAPI } from '~/composables/useApi'
import { useContinuityText } from '~/composables/useContinuityText'
import { mergeRequest, orderedStoryboards, transitionConfig, type MergeRequest, type TransitionConfig, type TransitionType } from '~/utils/continuity'
const props = defineProps<{ episodeId: number; storyboards: any[]; ids: number[]; saving: boolean; submitting: boolean }>()
const emit = defineEmits<{ close: []; save: [storyboard: any, transition: TransitionConfig]; merge: [body: MergeRequest] }>()
const { t } = useI18n()
const { ct } = useContinuityText()
const loading = ref(false)
const error = ref('')
const preview = ref<any>(null)
const rows = computed(() => orderedStoryboards(props.storyboards).filter(sb => props.ids.includes(Number(sb.id))))
const request = computed(() => mergeRequest(props.storyboards, props.ids))
const signature = computed(() => JSON.stringify({
  request: request.value,
  sources: rows.value.map(sb => [sb.id, sb.video_task_id ?? sb.videoTaskId, sb.video_url ?? sb.videoUrl, sb.continuity_revision ?? sb.continuityRevision]),
}))
const checkedSignature = ref('')
let serial = 0
async function check() {
  const current = ++serial
  const body = request.value
  const expected = signature.value
  loading.value = true
  error.value = ''
  try {
    const result = await mergeAPI.preview(props.episodeId, body)
    if (current !== serial) return
    preview.value = result
    checkedSignature.value = expected
  } catch (e: any) {
    if (current === serial) { error.value = e.message || ct('exportFailed'); preview.value = null }
  } finally { if (current === serial) loading.value = false }
}
watch(signature, check, { immediate: true })
const ready = computed(() => !!preview.value && !loading.value && !error.value && !props.saving && checkedSignature.value === signature.value && !(preview.value.blockers?.length))
function config(sb: any) { return request.value.transitions?.find(item => item.storyboard_id === Number(sb.id)) || transitionConfig(sb) }
function appliedDuration(sb: any) { return preview.value?.boundaries?.find((boundary: any) => Number(boundary.storyboard_id) === Number(sb.id))?.duration_ms }
function adjacent(sb: any, index: number) {
  const all = orderedStoryboards(props.storyboards)
  return index > 0 && all[all.findIndex(item => item.id === sb.id) - 1]?.id === rows.value[index - 1]?.id
}
function setType(sb: any, event: Event) {
  const type = (event.target as HTMLSelectElement).value as TransitionType
  emit('save', sb, { type, duration_ms: type === 'dissolve' ? 250 : type === 'audio_fade' ? 30 : 0 })
}
function setDuration(sb: any, event: Event) {
  const type = config(sb).type
  const value = Number((event.target as HTMLInputElement).value)
  emit('save', sb, { type, duration_ms: Math.max(0, Math.min(type === 'dissolve' ? 500 : 100, value || 0)) })
}
const seam = ref<{ before: any; after: any } | null>(null)
const beforeVideo = ref<HTMLVideoElement>()
const afterVideo = ref<HTMLVideoElement>()
let playingSeam = false
function mediaUrl(url: string) { return !url || /^(https?:|blob:|data:|\/)/i.test(url) ? url : '/' + url }
function openSeam(index: number) {
  stopSeam()
  const clips = preview.value?.clips || []
  const before = clips.find((clip: any) => Number(clip.storyboard_id) === Number(rows.value[index - 1]?.id))
  const after = clips.find((clip: any) => Number(clip.storyboard_id) === Number(rows.value[index]?.id))
  if (before && after) seam.value = { before, after }
}
function seekTail() {
  const video = beforeVideo.value
  if (video && Number.isFinite(video.duration)) video.currentTime = Math.max(0, video.duration - 2)
}
function stopSeam() {
  playingSeam = false
  beforeVideo.value?.pause()
  afterVideo.value?.pause()
}
async function playSeam() {
  stopSeam()
  await nextTick()
  seekTail()
  if (afterVideo.value) afterVideo.value.currentTime = 0
  playingSeam = true
  try { await beforeVideo.value?.play() } catch { playingSeam = false }
}
async function playNext() {
  if (!playingSeam) return
  try { await afterVideo.value?.play() } catch { playingSeam = false }
}
function stopHead() {
  if (playingSeam && afterVideo.value && afterVideo.value.currentTime >= 2) stopSeam()
}
onBeforeUnmount(() => { serial++; stopSeam() })
</script>

<template>
  <div class="continuity-export-overlay" @click.self="!submitting && emit('close')">
    <section class="continuity-export-dialog" role="dialog" aria-modal="true" :aria-label="ct('exportTitle')">
      <header><h2>{{ ct('exportTitle') }}</h2><button class="btn" :disabled="submitting" @click="emit('close')">{{ t('common.close') }}</button></header>
      <div class="continuity-export-body">
        <p v-if="loading">{{ ct('exportLoading') }}</p>
        <p v-if="error" class="warning" role="alert">{{ error }} <button class="btn btn-sm" @click="check">{{ ct('previewAgain') }}</button></p>
        <template v-if="preview">
          <strong>{{ ct('totalDuration', { n: (Number(preview.total_duration_ms || 0) / 1000).toFixed(2) }) }}</strong>
          <ul v-if="preview.blockers?.length" class="warning"><li v-for="(blocker, index) in preview.blockers" :key="index">{{ typeof blocker === 'string' ? blocker : blocker.message }}</li></ul>
          <p v-else>{{ ct('exportReady') }}</p>
        </template>
        <div v-for="(sb, index) in rows" :key="sb.id" class="transition-row">
          <strong>{{ ct('shot', { n: sb.storyboard_number ?? sb.storyboardNumber }) }}</strong>
          <template v-if="index > 0">
            <label>{{ ct('transition') }}
              <select :value="config(sb).type" :disabled="saving || submitting || !adjacent(sb, index)" @change="setType(sb, $event)">
                <option v-for="type in ['cut', 'dissolve', 'audio_fade']" :key="type" :value="type">{{ ct(type) }}</option>
              </select>
            </label>
            <label v-if="config(sb).type !== 'cut'">{{ ct('duration') }}
              <input type="number" min="0" :max="config(sb).type === 'dissolve' ? 500 : 100" :value="config(sb).duration_ms" :disabled="saving || submitting || !adjacent(sb, index)" @change="setDuration(sb, $event)">
            </label>
            <p v-if="!loading && appliedDuration(sb) != null && appliedDuration(sb) !== config(sb).duration_ms">{{ ct('appliedDuration', { n: appliedDuration(sb) }) }}</p>
            <p v-if="!adjacent(sb, index)">{{ ct('selectionCut') }}</p>
            <p v-else-if="config(sb).type === 'dissolve'" class="warning">{{ ct('dissolveHint') }}</p>
            <p v-else-if="config(sb).type === 'audio_fade'">{{ ct('audioHint') }}</p>
            <button class="btn btn-sm" :disabled="!preview || loading" @click="openSeam(index)">{{ ct('seam') }}</button>
          </template>
        </div>
        <section v-if="seam" class="seam-preview">
          <strong>{{ ct('seamTitle') }}</strong><p>{{ ct('seamHint') }}</p>
          <div class="seam-videos">
            <label>{{ ct('previousTail') }}<video ref="beforeVideo" :key="seam.before.url" :src="mediaUrl(seam.before.url)" controls preload="metadata" @loadedmetadata="seekTail" @ended="playNext" /></label>
            <label>{{ ct('nextHead') }}<video ref="afterVideo" :key="seam.after.url" :src="mediaUrl(seam.after.url)" controls preload="metadata" @timeupdate="stopHead" /></label>
          </div>
          <button class="btn btn-sm" @click="playSeam">{{ ct('playSeam') }}</button>
        </section>
      </div>
      <footer><button class="btn" :disabled="submitting" @click="emit('close')">{{ t('common.cancel') }}</button><button class="btn btn-primary" :disabled="!ready || submitting" @click="emit('merge', request)">{{ submitting ? t('episode.export.merging') : ct('exportStart') }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.continuity-export-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); padding: 24px; }
.continuity-export-dialog { width: min(760px, 100%); max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-1); border: 1px solid var(--surface-outline); border-radius: var(--radius-lg, 12px); box-shadow: var(--shadow-card); color: var(--text-0); }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px; }
h2 { margin: 0; font-size: 16px; } footer { justify-content: flex-end; }
.continuity-export-body { padding: 0 20px 12px; overflow: auto; display: grid; gap: 12px; font-size: 12px; }
p { margin: 0; color: var(--text-3); line-height: 1.7; }
.warning { color: var(--warning, #d99c39); line-height: 1.7; }
.transition-row, .seam-preview { padding: 12px; border: 1px solid var(--surface-outline); border-radius: var(--radius); display: grid; gap: 10px; }
.transition-row > button, .seam-preview > button { justify-self: start; }
label { display: grid; gap: 6px; color: var(--text-2); }
select, input { padding: 7px 9px; border: 1px solid var(--surface-outline); border-radius: var(--radius); background: var(--bg-2); color: var(--text-0); font: inherit; }
.seam-videos { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
video { width: 100%; background: #000; max-height: 240px; }
@media(max-width: 560px) { .seam-videos { grid-template-columns: 1fr; } .continuity-export-overlay { padding: 10px; } }
</style>
