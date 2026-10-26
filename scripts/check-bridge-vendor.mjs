import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/check-bridge-vendor.mjs <live-assistant-lite-directory>')
const root = fileURLToPath(new URL('../', import.meta.url))
const pairs = [
  ['contracts/index.ts', 'contracts.ts'],
  ['contracts/accountGovernance.ts', 'accountGovernance.ts'],
  ['src/platform/hostIdentity.ts', 'hostIdentity.ts'],
  ['src/platform/hostIdentityHttp.ts', 'hostIdentityHttp.ts'],
]
function tokens(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  // Only imports differ for the host's local types/SQLite adapter. Check every other token.
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n')
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body)
  const result = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    result.push([kind, scanner.getTokenText()])
  }
  return JSON.stringify(result)
}
for (const [original, vendored] of pairs) {
  if (tokens(resolve(source, original)) !== tokens(resolve(root, 'electron/main/bridge/vendor', vendored))) {
    throw new Error(`Bridge vendor differs: ${vendored}`)
  }
}
console.log(`Bridge vendor: ${pairs.length}/${pairs.length} bodies match (imports excluded)`)
