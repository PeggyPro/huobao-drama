import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { syncWorkspaceTemplate, TEMPLATE_VERSION } from '../../desktop/src/workspace-template.js'

function withTemplate(run: (root: string, source: string, target: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'huobao-workspace-template-'))
  const source = join(root, 'source')
  const target = join(root, 'user-workspace')
  mkdirSync(join(source, 'prompts'), { recursive: true })
  mkdirSync(join(source, 'skills', 'continuity-planner'), { recursive: true })
  mkdirSync(join(source, 'skills', 'storyboard-breaker'), { recursive: true })
  writeFileSync(join(source, 'prompts', 'storyboard_breaker.md'), 'bundled storyboard prompt')
  writeFileSync(join(source, 'skills', 'storyboard-breaker', 'SKILL.md'), 'bundled storyboard skill')
  for (const suffix of ['', '.en', '.ja', '.ko']) {
    writeFileSync(join(source, 'prompts', `continuity_planner${suffix}.md`), `planner prompt ${suffix}`)
    writeFileSync(join(source, 'skills', 'continuity-planner', `SKILL${suffix}.md`), `planner skill ${suffix}`)
  }
  try { run(root, source, target) }
  finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert.ok(root.startsWith(join(tmpdir(), 'huobao-workspace-template-')))
    rmSync(root, { recursive: true, force: true })
  }
}

test('first desktop start installs all continuity prompt and skill language variants', () => withTemplate((_root, source, target) => {
  syncWorkspaceTemplate(source, target)
  assert.equal(readFileSync(join(target, '.template-version'), 'utf8'), TEMPLATE_VERSION)
  for (const suffix of ['', '.en', '.ja', '.ko']) {
    assert.equal(readFileSync(join(target, 'prompts', `continuity_planner${suffix}.md`), 'utf8'), `planner prompt ${suffix}`)
    assert.equal(readFileSync(join(target, 'skills', 'continuity-planner', `SKILL${suffix}.md`), 'utf8'), `planner skill ${suffix}`)
  }
}))

test('v4 upgrade adds the new agent without overwriting customized prompts, skills or user files', () => withTemplate((_root, source, target) => {
  mkdirSync(join(target, 'prompts'), { recursive: true })
  mkdirSync(join(target, 'skills', 'storyboard-breaker'), { recursive: true })
  writeFileSync(join(target, '.template-version'), '4')
  writeFileSync(join(target, 'prompts', 'storyboard_breaker.md'), 'my storyboard prompt')
  writeFileSync(join(target, 'prompts', 'continuity_planner.md'), 'my early planner prompt')
  writeFileSync(join(target, 'skills', 'storyboard-breaker', 'SKILL.md'), 'my storyboard skill')
  writeFileSync(join(target, 'personal-notes.md'), 'keep notes')
  syncWorkspaceTemplate(source, target)
  assert.equal(readFileSync(join(target, '.template-version'), 'utf8'), TEMPLATE_VERSION)
  assert.equal(readFileSync(join(target, 'prompts', 'storyboard_breaker.md'), 'utf8'), 'my storyboard prompt')
  assert.equal(readFileSync(join(target, 'prompts', 'continuity_planner.md'), 'utf8'), 'my early planner prompt')
  assert.equal(readFileSync(join(target, 'skills', 'storyboard-breaker', 'SKILL.md'), 'utf8'), 'my storyboard skill')
  assert.equal(readFileSync(join(target, 'personal-notes.md'), 'utf8'), 'keep notes')
  assert.equal(readdirSync(join(target, 'skills', 'continuity-planner')).length, 4)
  writeFileSync(join(target, 'skills', 'continuity-planner', 'SKILL.md'), 'new user rule')
  syncWorkspaceTemplate(source, target)
  assert.equal(readFileSync(join(target, 'skills', 'continuity-planner', 'SKILL.md'), 'utf8'), 'new user rule')
}))
