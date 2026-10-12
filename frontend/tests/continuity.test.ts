import assert from 'node:assert/strict'
import test from 'node:test'
import {
  batchRequestIdentity, continuityPlan, continuityRevision, jsonObject, mergeRequest,
  normalizeTask, staleContinuitySource, taskCanRetry, taskIsActive, transitionConfig, videoTaskPayload,
} from '../app/utils/continuity.ts'

const plan = { version: 1, mode: 'motion_context', relation: 'continuous_action', source_storyboard_id: 10, reason: 'continues', needs_review: false, start_state: 'standing', end_state: 'seated', origin: 'manual', suggestion: null }

test('legacy raw JSON and decoded continuity rows normalize identically', () => {
  assert.deepEqual(continuityPlan({ continuity_plan: JSON.stringify(plan) }), continuityPlan({ continuityPlan: plan }))
  assert.equal(continuityRevision({ continuity_revision: 3 }), 3)
  assert.equal(continuityRevision({ continuityRevision: 4 }), 4)
  assert.equal(continuityPlan({ continuity_plan: '{bad' }).mode, 'independent')
  assert.deepEqual(jsonObject(null), {})
  assert.deepEqual(jsonObject('[]'), {})
})

test('task responses retain queued dependencies and decode raw params', () => {
  const row = normalizeTask({ id: 4, status: 'queued', storyboardId: 11, dependsOnTaskId: 3, batchId: 'batch', blockedReason: 'source', retryOfTaskId: 2, params: '{"continuitySourceTaskId":7}' })
  assert.equal(row.storyboard_id, 11)
  assert.equal(row.depends_on_task_id, 3)
  assert.equal(row.batch_id, 'batch')
  assert.equal(row.blocked_reason, 'source')
  assert.equal(row.retry_of_task_id, 2)
  assert.equal(row.params.continuitySourceTaskId, 7)
  assert.equal(taskIsActive(row), true)
  assert.equal(taskIsActive({ status: 'downloading' }), true)
  assert.equal(taskIsActive({ status: 'blocked' }), false)
  assert.equal(taskCanRetry({ status: 'blocked' }), true)
  assert.equal(taskCanRetry({ status: 'cancelled' }), true)
  assert.equal(taskCanRetry({ status: 'failed', phase: 'submission_unknown' }), false)
})

test('stale source warning follows the completed source version, ignoring its pending replacement', () => {
  const task = { params: JSON.stringify({ continuitySourceStoryboardId: 10, continuitySourceTaskId: 70 }) }
  assert.equal(staleContinuitySource(task, [{ id: 10, video_task_id: 70, pending_video_task_id: 71 }]), false)
  assert.equal(staleContinuitySource(task, [{ id: 10, video_task_id: 71, pending_video_task_id: null }]), true)
  assert.equal(staleContinuitySource(task, [{ id: 10, video_task_id: null }]), true)
  assert.equal(staleContinuitySource({ params: '{}' }, [{ id: 10, video_task_id: 71 }]), false)
})

test('shared builder preserves reference order and resolved prompt without freezing a continuity source', () => {
  const references = ['scene.png', 'character-a.png', 'character-b.png', 'prop.png']
  const payload = videoTaskPayload({ storyboard: { id: 11, duration: 8, continuity_plan: plan, continuity_revision: 5 }, dramaId: 2, prompt: '@image1 scene @image2 person', references, model: 'minimax_h3', configId: 9, aspectRatio: '16:9', wan: false })
  assert.deepEqual(payload.reference_image_urls, references)
  assert.equal(payload.prompt, '@image1 scene @image2 person')
  assert.equal(payload.duration, 8)
  assert.equal(payload.config_id, 9)
  assert.equal(payload.continuity_revision, 5)
  for (const key of ['first_frame_url', 'last_frame_url', 'source_task_id', 'motion_context_source_task_id', 'continuitySourceTaskId']) assert.equal(key in payload, false)
})

test('Wan independent shot uses its normal first image and dependent shot leaves source resolution to queue', () => {
  const options = { dramaId: 2, prompt: 'walking', references: ['portrait.png'], model: 'wan2.2-i2v-5b', aspectRatio: '9:16', wan: true }
  const independent = videoTaskPayload({ ...options, storyboard: { id: 10, continuity_plan: { mode: 'independent' } } })
  const dependent = videoTaskPayload({ ...options, storyboard: { id: 11, continuity_plan: { ...plan, mode: 'tail_frame' } } })
  assert.equal(independent.first_frame_url, 'portrait.png')
  assert.deepEqual(independent.reference_image_urls, [])
  assert.equal('first_frame_url' in dependent, false)
  assert.deepEqual(dependent.reference_image_urls, [])
})

test('batch retries reuse a request key, while changes and a new submission get new keys', () => {
  const identify = batchRequestIdentity()
  const body = { episode_id: 1, tasks: [{ storyboard_id: 10, prompt: 'a' }] }
  const first = identify(body)
  assert.match(first, /^[a-f0-9-]{36}$/)
  assert.equal(identify(JSON.parse(JSON.stringify(body))), first)
  const changed = identify({ ...body, tasks: [{ storyboard_id: 10, prompt: 'b' }] })
  assert.notEqual(changed, first)
  assert.notEqual(identify(body), first)
  assert.notEqual(batchRequestIdentity()(body), first)
})

test('incoming transitions follow chronological selection and new gap boundaries use cut', () => {
  const shots = [
    { id: 30, storyboard_number: 3, transition_config: { type: 'dissolve', duration_ms: 250 } },
    { id: 10, storyboard_number: 1, transition_config: { type: 'dissolve', duration_ms: 250 } },
    { id: 20, storyboard_number: 2, transition_config: '{"type":"audio_fade","duration_ms":30}' },
  ]
  assert.deepEqual(mergeRequest(shots, [30, 10]), { storyboard_ids: [10, 30], transitions: [{ storyboard_id: 10, type: 'cut', duration_ms: 0 }, { storyboard_id: 30, type: 'cut', duration_ms: 0 }] })
  assert.deepEqual(mergeRequest(shots, [30, 20]).transitions, [{ storyboard_id: 20, type: 'cut', duration_ms: 0 }, { storyboard_id: 30, type: 'dissolve', duration_ms: 250 }])
  assert.deepEqual(shots.map(shot => shot.id), [30, 10, 20])
})

test('transition defaults and maximums are explicit while final short-clip clamp stays in preview', () => {
  assert.deepEqual(transitionConfig({}), { type: 'cut', duration_ms: 0 })
  assert.deepEqual(transitionConfig({ transition_config: { type: 'dissolve' } }), { type: 'dissolve', duration_ms: 250 })
  assert.deepEqual(transitionConfig({ transition_config: { type: 'dissolve', duration_ms: 900 } }), { type: 'dissolve', duration_ms: 500 })
  assert.deepEqual(transitionConfig({ transition_config: { type: 'audio_fade' } }), { type: 'audio_fade', duration_ms: 30 })
  assert.deepEqual(transitionConfig({ transition_config: { type: 'audio_fade', duration_ms: 250 } }), { type: 'audio_fade', duration_ms: 100 })
})
