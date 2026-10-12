import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseContinuityPlan, validateContinuitySource, transitionConfigSchema, assertContinuityCapability, continuityPrompt } from '../src/services/continuity-contract.js'

const shots = [
  { id: 11, episodeId: 9, storyboardNumber: 1 },
  { id: 12, episodeId: 9, storyboardNumber: 2 },
  { id: 13, episodeId: 9, storyboardNumber: 3 },
]

test('old data remains independent, and continuation accepts only the immediate predecessor', () => {
  assert.equal(parseContinuityPlan(null).mode, 'independent')
  const plan = parseContinuityPlan({ mode: 'tail_frame', relation: 'continuous_action', source_storyboard_id: 12 })
  assert.doesNotThrow(() => validateContinuitySource(shots[2], shots, plan))
  for (const id of [11, 13, 99, null]) {
    assert.throws(() => validateContinuitySource(shots[2], shots, { ...plan, source_storyboard_id: id }), /紧邻/)
  }
  assert.throws(() => validateContinuitySource(shots[0], shots, plan), /第一段/)
  assert.throws(() => validateContinuitySource(shots[2], shots, { ...plan, relation: 'scene_change' }), /换场景/)
  assert.throws(() => validateContinuitySource(shots[2], [shots[0], { ...shots[1], episodeId: 2 }, shots[2]], plan), /紧邻/)
})

test('generation capabilities reject unsupported continuation rather than downgrading it', () => {
  assert.doesNotThrow(() => assertContinuityCapability('motion_context', 'comfyui', 'huobao_minimax_h3_reference_turbo_api'))
  assert.doesNotThrow(() => assertContinuityCapability('tail_frame', 'comfyui', 'huobao_wan22_5b_t2v_32gb_api'))
  assert.throws(() => assertContinuityCapability('motion_context', 'comfyui', 'huobao_wan22_5b_t2v_32gb_api'))
  assert.throws(() => assertContinuityCapability('tail_frame', 'openai', 'minimax_h3'))
})

test('transition bounds and continuity prompts preserve cut semantics and child-shot boundaries', () => {
  assert.deepEqual(transitionConfigSchema.parse({ type: 'cut' }), { type: 'cut', duration_ms: 0 })
  assert.deepEqual(transitionConfigSchema.parse({ type: 'audio_fade' }), { type: 'audio_fade', duration_ms: 30 })
  for (const value of [{ type: 'cut', duration_ms: 1 }, { type: 'audio_fade', duration_ms: 101 }, { type: 'dissolve', duration_ms: 501 }, { type: 'dissolve', duration_ms: 0 }]) {
    assert.equal(transitionConfigSchema.safeParse(value).success, false)
  }
  const text = continuityPrompt(parseContinuityPlan({ mode: 'motion_context', start_state: '右手持信', end_state: '转身离开' }), '刚接过信纸')
  assert.match(text, /前段最后一个子镜头结束状态：刚接过信纸/)
  assert.match(text, /本段第一个子镜头开始状态：右手持信/)
  assert.match(text, /不重演前段动作或台词/)
})
