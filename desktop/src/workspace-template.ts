import * as fs from 'fs'
import * as path from 'path'

/** v5 adds the configurable continuity planner prompt and skill templates. */
export const TEMPLATE_VERSION = '5'

/** Add missing templates on upgrade, preserving all user-edited prompts and skills. */
export function syncWorkspaceTemplate(templateDir: string, destDir: string) {
  const marker = path.join(destDir, '.template-version')
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === TEMPLATE_VERSION) return
  fs.cpSync(templateDir, destDir, { recursive: true, force: false, errorOnExist: false })
  fs.writeFileSync(marker, TEMPLATE_VERSION)
}
