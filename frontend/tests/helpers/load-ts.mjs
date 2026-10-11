import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Run the real TypeScript modules with the repository's installed dependencies.
// A small import map supplies adjacent TS modules without adding a test runner.
export function loadTs(relativePath, imports = {}) {
  const filename = new URL(relativePath, new URL('../../', import.meta.url))
  const require = createRequire(filename)
  const source = readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: filename.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  new Function('exports', 'require', 'module', outputText)(module.exports, id => imports[id] ?? require(id), module)
  return module.exports
}
