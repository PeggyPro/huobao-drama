import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { eq } from 'drizzle-orm'

// This must precede every import that can initialize the repository database.
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { saveStoryboardBatch } = await import('../src/services/storyboard-save.js')
const { buildContinuityUpdate, saveContinuityPlans, ContinuityConflict } = await import('../src/services/continuity-plans.js')
const sqlite = db.$client
const ts = '2026-01-01T00:00:00Z'
after(() => sqlite.close())

beforeEach(() => {
  for (const table of ['sys_task', 'storyboard_characters', 'storyboard_props', 'storyboards', 'episode_characters', 'episode_scenes', 'episode_props', 'characters', 'scenes', 'props', 'episodes', 'dramas']) sqlite.prepare(`DELETE FROM ${table}`).run()
  sqlite.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (2,?,?,?)').run('test', ts, ts)
  sqlite.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,script_content,duration,created_at,updated_at) VALUES (9,2,1,\'test\',?,7,?,?),(10,2,2,\'other\',?,0,?,?)').run('script', ts, ts, 'other', ts, ts)
  sqlite.prepare('INSERT INTO characters (id,drama_id,name,created_at,updated_at) VALUES (15,2,?,?,?)').run('actor', ts, ts)
  sqlite.prepare('INSERT INTO scenes (id,drama_id,location,time,prompt,created_at,updated_at) VALUES (20,2,?,?,\'courtyard\',?,?)').run('courtyard', 'day', ts, ts)
  sqlite.prepare('INSERT INTO props (id,drama_id,name,created_at,updated_at) VALUES (30,2,?,?,?)').run('letter', ts, ts)
  sqlite.prepare('INSERT INTO storyboards (id,episode_id,storyboard_number,description,video_prompt,video_url,video_task_id,created_at,updated_at) VALUES (100,9,1,?,?,?,?,?,?),(101,9,2,?,?,?,?,?,?)').run('original one', 'original prompt one', 'static/old1.mp4', 500, ts, ts, 'original two', 'original prompt two', 'static/old2.mp4', 501, ts, ts)
  sqlite.prepare('INSERT INTO storyboard_characters (storyboard_id,character_id) VALUES (100,15)').run()
  sqlite.prepare('INSERT INTO storyboard_props (storyboard_id,prop_id) VALUES (100,30)').run()
})

const independent = (reason = 'establish shot') => ({ mode: 'independent' as const, relation: 'same_scene_cut' as const, source_storyboard_id: null, reason, needs_review: false, start_state: 'holding letter', end_state: 'letter unfolded' })
const continuation = (source: number) => ({ ...independent('continue the movement'), mode: 'motion_context' as const, relation: 'continuous_action' as const, source_storyboard_id: source })
function item(id: number, revision = 0, plan = independent()) { return { storyboard_id: id, continuity_revision: revision, continuity_plan: plan } }
function shot(number: number, continuity?: object) { return { shot_number: number, description: `shot ${number}`, video_prompt: `prompt ${number}`, scene_id: 20, character_ids: [15], prop_ids: [30], duration: 12, ...(continuity ? { continuity } : {}) } }
function rows() { return sqlite.prepare('SELECT * FROM storyboards ORDER BY episode_id,storyboard_number').all() as Record<string, any>[] }
function snapshot() {
  return Object.fromEntries(['storyboards', 'episodes', 'storyboard_characters', 'storyboard_props', 'episode_characters', 'episode_scenes', 'episode_props'].map(table => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
function persist(id: number, input: Parameters<typeof buildContinuityUpdate>[1]) { db.update(schema.storyboards).set(buildContinuityUpdate(id, input)).where(eq(schema.storyboards.id, id)).run() }

test('invalid binding in a later replacement row preserves every old row and binding', () => {
  const before = snapshot()
  assert.throws(() => saveStoryboardBatch(9, 2, [shot(1), { ...shot(2), character_ids: [999] }], true), /character_id 999/)
  assert.deepEqual(snapshot(), before)
})

test('invalid continuity in a replacement batch is rejected before clearing old videos', () => {
  const before = snapshot()
  assert.throws(() => saveStoryboardBatch(9, 2, [shot(1), shot(2, { ...continuation(100), source_shot_number: 99 })], true), /紧邻/)
  assert.deepEqual(snapshot(), before)
})

test('same-batch source_shot_number resolves to newly persisted IDs even for unsorted input', () => {
  saveStoryboardBatch(9, 2, [shot(2, { ...continuation(100), source_shot_number: 1 }), shot(1, { ...independent(), source_shot_number: null })], true)
  const [first, second] = rows()
  assert.deepEqual(rows().map(row => row.storyboard_number), [1, 2])
  assert.equal(JSON.parse(first.continuity_plan).source_storyboard_id, null)
  assert.equal(JSON.parse(second.continuity_plan).source_storyboard_id, first.id)
  assert.equal(JSON.parse(second.continuity_plan).origin, 'ai')
  assert.equal(second.video_url, null)
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM storyboard_characters').get().n, 2)
})

test('later batches resolve the previous batch source without replacing it', () => {
  saveStoryboardBatch(9, 2, [shot(1, { ...independent(), source_shot_number: null })], true)
  const firstId = rows()[0].id
  saveStoryboardBatch(9, 2, [shot(2, { ...continuation(100), source_shot_number: 1 })])
  assert.equal(rows()[0].id, firstId)
  assert.equal(JSON.parse(rows()[1].continuity_plan).source_storyboard_id, firstId)
})

test('manual selection is preserved while AI analysis updates only its suggestion', () => {
  persist(101, { continuity_revision: 0, continuity_plan: independent('manual close-up') })
  const before = rows()[1]
  saveContinuityPlans(9, [{ ...item(101, 1), continuity_plan: continuation(100) }])
  const after = rows()[1]
  const plan = JSON.parse(after.continuity_plan)
  assert.equal(plan.origin, 'manual')
  assert.equal(plan.mode, 'independent')
  assert.equal(plan.reason, 'manual close-up')
  assert.equal(plan.suggestion.mode, 'motion_context')
  assert.equal(plan.suggestion.source_storyboard_id, 100)
  for (const field of ['description', 'video_prompt', 'video_url', 'video_task_id', 'pending_video_task_id', 'transition_config']) assert.deepEqual(after[field], before[field])
  assert.equal(after.continuity_revision, 2)
})

test('revision conflict in any AI item rolls back the entire batch', () => {
  persist(101, { continuity_revision: 0, continuity_plan: independent('user edit') })
  const before = snapshot()
  assert.throws(() => saveContinuityPlans(9, [item(100), item(101, 0)]), ContinuityConflict)
  assert.deepEqual(snapshot(), before)
})

test('foreign episode, deleted target and repeated target each fail without partial saves', () => {
  sqlite.prepare('INSERT INTO storyboards (id,episode_id,storyboard_number,created_at,updated_at) VALUES (102,10,1,?,?)').run(ts, ts)
  for (const items of [[item(100), item(102)], [item(100), item(100)]]) {
    const before = snapshot()
    assert.throws(() => saveContinuityPlans(9, items))
    assert.deepEqual(snapshot(), before)
  }
  sqlite.prepare('UPDATE storyboards SET deleted_at=? WHERE id=101').run(ts)
  const before = snapshot()
  assert.throws(() => saveContinuityPlans(9, [item(100), item(101)]), /有效分镜/)
  assert.deepEqual(snapshot(), before)
})

test('saving an incoming transition advances revision without converting an AI strategy to manual', () => {
  saveContinuityPlans(9, [item(101)])
  const plan = rows()[1].continuity_plan
  persist(101, { continuity_revision: 1, transition_config: { type: 'audio_fade' } })
  assert.equal(rows()[1].continuity_plan, plan)
  assert.equal(rows()[1].continuity_revision, 2)
  assert.deepEqual(JSON.parse(rows()[1].transition_config), { type: 'audio_fade', duration_ms: 30 })
})

test('unfinished queue rows prevent structural replacement and leave all old media intact', () => {
  for (const status of ['queued', 'processing', 'downloading', 'blocked']) {
    sqlite.prepare('DELETE FROM sys_task').run()
    sqlite.prepare('INSERT INTO sys_task (id,type,storyboard_id,status,phase,created_at,updated_at) VALUES (600,\'video\',100,?,?,?,?)').run(status, 'submission_unknown', ts, ts)
    const before = snapshot()
    assert.throws(() => saveStoryboardBatch(9, 2, [shot(1)], true), ContinuityConflict)
    assert.deepEqual(snapshot(), before)
  }
})

test('inserting a middle segment marks the old non-adjacent source for review', () => {
  sqlite.prepare('UPDATE storyboards SET storyboard_number=3 WHERE id=101').run()
  persist(101, { continuity_revision: 0, continuity_plan: continuation(100) })
  saveStoryboardBatch(9, 2, [shot(2)])
  const final = rows().find(row => row.id === 101)!
  const plan = JSON.parse(final.continuity_plan)
  assert.equal(plan.needs_review, true)
  assert.equal(plan.source_storyboard_id, 100, 'never silently redirect a manually chosen source')
  assert.equal(final.continuity_revision, 2)
})

test('more than eight storyboards is rejected atomically to match the advertised batch limit', () => {
  const before = snapshot()
  assert.throws(() => saveStoryboardBatch(9, 2, Array.from({ length: 9 }, (_, index) => shot(index + 1)), true))
  assert.deepEqual(snapshot(), before)
})
