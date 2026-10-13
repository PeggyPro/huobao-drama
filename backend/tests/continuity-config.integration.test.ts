import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'

process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VIDEO_QUEUE_AUTOSTART = 'false'
const cacheDir = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
mkdirSync(cacheDir, { recursive: true })
const root = mkdtempSync(join(cacheDir, 'continuity-config-test-'))
const workspace = join(root, 'workspace')
process.env.WORKSPACE_PATH = workspace
process.env.STORAGE_PATH = join(root, 'static')
const { db } = await import('../src/db/index.js')
const { refreshSkillWorkspaces } = await import('../src/agents/skills.js')
const { DEFAULT_CONTINUITY_PLANNER_PROMPT } = await import('../src/agents/continuity-planner.js')
const { setContentLanguage } = await import('../src/services/app-settings.js')
const { stopVideoQueue } = await import('../src/services/video-queue.js')
const { default: prompts } = await import('../src/routes/prompts.js')
const { default: skills } = await import('../src/routes/skills.js')
const { default: episodes } = await import('../src/routes/episodes.js')
const { default: agents } = await import('../src/routes/agent.js')
const app = new Hono().route('/api/v1/prompts', prompts).route('/api/v1/skills', skills)
  .route('/api/v1/episodes', episodes).route('/api/v1/agent', agents)
const sqlite = db.$client
const originalFetch = globalThis.fetch
const ts = '2026-01-01T00:00:00Z'

beforeEach(async () => {
  globalThis.fetch = async () => { throw new Error('Real network is forbidden in continuity config tests') }
  for (const name of ['prompts', 'skills']) {
    const target = join(workspace, name)
    assert.equal(dirname(target), workspace)
    assert.equal(dirname(workspace), root)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
  }
  await refreshSkillWorkspaces()
  for (const table of ['sys_task', 'storyboard_characters', 'storyboard_props', 'storyboards', 'episode_characters', 'episode_scenes', 'episode_props', 'characters', 'scenes', 'props', 'episodes', 'dramas', 'ai_service_configs', 'app_settings']) sqlite.prepare(`DELETE FROM ${table}`).run()
  sqlite.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (2,?,?,?)').run('test', ts, ts)
  sqlite.prepare(`INSERT INTO episodes (id,drama_id,episode_number,title,script_content,video_config_id,created_at,updated_at)
    VALUES (9,2,1,'test','主角展开信纸，然后抬头。',12,?,?)`).run(ts, ts)
  sqlite.prepare(`INSERT INTO storyboards (id,episode_id,storyboard_number,description,video_prompt,video_url,created_at,updated_at)
    VALUES (100,9,1,'first description','first prompt','static/first.mp4',?,?),
           (101,9,2,'second description','second prompt','static/second.mp4',?,?)`).run(ts, ts, ts, ts)
  sqlite.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,is_active,priority,created_at,updated_at)
    VALUES (11,'text','openai','text','https://gateway.example/v1','test-only-key','["default-text-model"]',1,1,?,?),
           (12,'video','comfyui','h3','http://video.invalid','','["minimax_h3"]',1,1,?,?),
           (14,'text','openai','other','https://other.example/v1','test-only-key','["other-model"]',1,0,?,?)`).run(ts, ts, ts, ts, ts, ts)
})

after(() => {
  stopVideoQueue()
  globalThis.fetch = originalFetch
  sqlite.close()
  assert.equal(dirname(root), cacheDir.replace(/[\\/]$/, ''))
  rmSync(root, { recursive: true, force: true })
})

async function request(method: string, path: string, body?: object) {
  return app.request(`/api/v1${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
}
async function ok(method: string, path: string, body?: object) {
  const response = await request(method, path, body)
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result.data
}
const skillBody = (name: string, rule: string) => `---\nname: ${name}\ndescription: test continuity guidance\n---\n\n${rule}\n`
const putPrompt = (rule: string, lang = 'zh', model = '') => ok('PUT', `/prompts/continuity_planner?lang=${lang}`, { system_prompt: rule, model })
const putSkill = (rule: string, lang = 'zh', id = 'continuity-planner') => ok('PUT', `/skills/${id}?lang=${lang}`, { content: skillBody(id.split('/').at(-1)!, rule) })

function sse(delta: unknown, finishReason = 'stop') {
  const chunk = (value: unknown, finish: string | null) => ({ id: 'config-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: value, finish_reason: finish }] })
  return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, finishReason))}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}
function toolResponse(name: string, args: object) {
  return sse({ role: 'assistant', tool_calls: [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
}

async function analyze(expected: { includes: string[]; excludes?: string[]; model?: string; urlPrefix?: string }, options = {}) {
  const before = sqlite.prepare('SELECT id,description,video_prompt,video_url FROM storyboards ORDER BY id').all()
  const targets = sqlite.prepare('SELECT id,continuity_revision FROM storyboards ORDER BY id').all() as { id: number; continuity_revision: number }[]
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    if (expected.urlPrefix) assert.ok(String(url).startsWith(expected.urlPrefix))
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, expected.model || 'default-text-model')
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), ['readStoryboardContext', 'saveContinuity'])
    const instructions = JSON.stringify(body.messages.filter((message: any) => message.role === 'system'))
    for (const text of expected.includes) assert.ok(instructions.includes(text), `Missing instruction ${text}`)
    for (const text of expected.excludes || []) assert.ok(!instructions.includes(text), `Unexpected instruction ${text}`)
    if (calls === 1) return toolResponse('readStoryboardContext', {})
    if (calls === 2) return toolResponse('saveContinuity', { items: targets.map(target => ({
      storyboard_id: target.id, continuity_revision: target.continuity_revision,
      continuity_plan: { mode: 'independent', relation: 'same_scene_cut', source_storyboard_id: null, reason: 'camera cut', needs_review: false, start_state: 'holding letter', end_state: 'looking up' },
    })) })
    assert.equal(calls, 3)
    return sse({ role: 'assistant', content: '已保存。' })
  }
  const result = await ok('POST', '/episodes/9/analyze-continuity', options)
  assert.equal(result.count, 2)
  assert.equal(calls, 3)
  assert.deepEqual(sqlite.prepare('SELECT id,description,video_prompt,video_url FROM storyboards ORDER BY id').all(), before)
}

test('planner prompt is listed, editable and resettable without exposing a generic chat entry', async () => {
  const list = await ok('GET', '/prompts')
  assert.equal(list.length, 5)
  assert.equal(list.find((entry: any) => entry.agent_type === 'continuity_planner').name, '镜头衔接分析')
  assert.equal((await ok('GET', '/prompts/continuity_planner')).system_prompt, DEFAULT_CONTINUITY_PLANNER_PROMPT.instructions)
  await putPrompt('CUSTOM_PROMPT', 'zh', 'file-model')
  assert.equal((await ok('GET', '/prompts/continuity_planner')).system_prompt, 'CUSTOM_PROMPT')
  assert.equal((await ok('GET', '/prompts/continuity_planner')).model, 'file-model')
  assert.equal((await request('POST', '/agent/continuity_planner/chat', { episode_id: 9, drama_id: 2, message: 'test' })).status, 400)
  assert.equal((await request('GET', '/agent/storyboard_breaker/debug')).status, 200)
  await ok('POST', '/prompts/continuity_planner/reset')
  const reset = await ok('GET', '/prompts/continuity_planner')
  assert.equal(reset.is_default, true)
  assert.equal(reset.system_prompt, DEFAULT_CONTINUITY_PLANNER_PROMPT.instructions)
  await analyze({ includes: ['影视连续性设计师'], excludes: ['CUSTOM_PROMPT'] })
})

test('saved prompt, skill and newly created subskill all reach analysis; subsequent edits take effect without restart', async () => {
  await putPrompt('PROMPT_V1')
  await putSkill('SKILL_V1')
  await ok('POST', '/skills', { id: 'continuity-planner/camera-cuts', description: 'camera cut rules' })
  await putSkill('CAMERA_CUT_RULE', 'zh', 'continuity-planner/camera-cuts')
  await putSkill('UNRELATED_STORYBOARD_SKILL', 'zh', 'storyboard-breaker')
  const list = await ok('GET', '/skills')
  assert.ok(list.some((entry: any) => entry.id === 'continuity-planner'))
  assert.ok(list.some((entry: any) => entry.id === 'continuity-planner/camera-cuts'))
  await analyze({ includes: ['PROMPT_V1', 'SKILL_V1', 'CAMERA_CUT_RULE'], excludes: ['UNRELATED_STORYBOARD_SKILL'] })
  await putPrompt('PROMPT_V2')
  await putSkill('SKILL_V2')
  await analyze({ includes: ['PROMPT_V2', 'SKILL_V2', 'CAMERA_CUT_RULE'], excludes: ['PROMPT_V1', 'SKILL_V1', 'UNRELATED_STORYBOARD_SKILL'] })
  await ok('DELETE', '/skills/continuity-planner/camera-cuts')
  await analyze({ includes: ['PROMPT_V2', 'SKILL_V2'], excludes: ['CAMERA_CUT_RULE'] })
})

for (const lang of ['en', 'ja', 'ko'] as const) {
  test(`${lang} prompt/skill variants and language directive reach analysis while model remains based on the base file`, async () => {
    await putPrompt('BASE_RULE', 'zh', 'base-file-model')
    await putSkill('BASE_SKILL')
    await putPrompt(`LOCAL_RULE_${lang}`, lang, 'ignored-variant-model')
    await putSkill(`LOCAL_SKILL_${lang}`, lang)
    setContentLanguage(lang)
    assert.equal((await ok('GET', `/prompts/continuity_planner?lang=${lang}`)).model, 'base-file-model')
    await analyze({ includes: [`LOCAL_RULE_${lang}`, `LOCAL_SKILL_${lang}`, 'Output Language'], excludes: ['BASE_RULE', 'BASE_SKILL'], model: 'base-file-model' })
    await ok('POST', `/prompts/continuity_planner/reset?lang=${lang}`)
    assert.equal((await ok('GET', `/prompts/continuity_planner?lang=${lang}`)).is_default, true)
    await analyze({ includes: ['BASE_RULE', `LOCAL_SKILL_${lang}`], excludes: [`LOCAL_RULE_${lang}`], model: 'base-file-model' })
  })
}

test('missing localized files fall back to the base prompt and skill; missing base prompt falls back to the shared default', async () => {
  await putPrompt('FALLBACK_PROMPT')
  await putSkill('FALLBACK_SKILL')
  setContentLanguage('en')
  assert.equal((await ok('GET', '/skills/continuity-planner?lang=en')).is_default, true)
  await analyze({ includes: ['FALLBACK_PROMPT', 'FALLBACK_SKILL', 'Output Language'] })
  await ok('POST', '/prompts/continuity_planner/reset')
  await analyze({ includes: ['影视连续性设计师', 'FALLBACK_SKILL', 'Output Language'], excludes: ['FALLBACK_PROMPT'] })
})

test('explicit request model and text config override the planner file without changing its tool permissions', async () => {
  await putPrompt('MODEL_RULE', 'zh', 'file-model')
  await putSkill('CUSTOM_SKILL_REQUESTS_OTHER_TOOLS saveStoryboards mastra_workspace_write_file')
  await analyze({ includes: ['MODEL_RULE', 'CUSTOM_SKILL_REQUESTS_OTHER_TOOLS'], model: 'request-model', urlPrefix: 'https://other.example/' }, { model: 'request-model', config_id: 14 })
})

test('shipped prompt and skill templates are discoverable and used in all four content languages', async () => {
  const bundledWorkspace = fileURLToPath(new URL('../workspace/', import.meta.url))
  for (const suffix of ['', '.en', '.ja', '.ko']) {
    cpSync(join(bundledWorkspace, 'prompts', `continuity_planner${suffix}.md`), join(workspace, 'prompts', `continuity_planner${suffix}.md`))
  }
  cpSync(join(bundledWorkspace, 'skills', 'continuity-planner'), join(workspace, 'skills', 'continuity-planner'), { recursive: true })
  await refreshSkillWorkspaces()
  for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
    setContentLanguage(lang)
    const prompt = await ok('GET', `/prompts/continuity_planner?lang=${lang}`)
    assert.equal(prompt.is_default, false)
    assert.ok(prompt.system_prompt.includes('readStoryboardContext'))
    assert.ok(prompt.system_prompt.includes('saveContinuity'))
    const skill = await ok('GET', `/skills/continuity-planner?lang=${lang}`)
    assert.equal(skill.is_default, false)
    assert.ok(skill.content.includes('name: continuity-planner'))
    await analyze({ includes: ['## Skill: continuity-planner', 'source_storyboard_id', 'motion_context'] })
  }
})
