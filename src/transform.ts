import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import * as t from '@babel/types'
import { relative } from 'node:path'
import { cwd } from 'node:process'

interface TransformResult {
  code: string
  map: null
}

/**
 * Transforms JSX source to inject __spoon_loc attributes carrying
 * the file path and line/column of each opening element — the
 * breadcrumb the overlay follows back to the real source.
 */
export async function transformWithLocation(source: string, filePath: string): Promise<TransformResult | undefined> {
  const relPath = relative(cwd(), filePath)

  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      sourceFilename: filePath,
    })
  } catch {
    return undefined
  }

  let modified = false

  traverse(ast, {
    JSXOpeningElement(path) {
      // Skip intrinsic elements (lowercase = HTML tag)
      const nameNode = path.node.name
      const isIntrinsic =
        t.isJSXIdentifier(nameNode) && nameNode.name[0] === nameNode.name[0].toLowerCase()

      if (!path.node.loc) return

      const loc = path.node.loc.start
      const locValue = `${relPath}:${loc.line}:${loc.column}`

      // Don't double-inject
      const alreadyHas = path.node.attributes.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-spoon-loc',
      )
      if (alreadyHas) return

      // Only inject on DOM elements (intrinsics), not component wrappers —
      // component props are not forwarded to the DOM automatically, which would
      // cause React warnings. Components that want tracking can spread {...props}.
      if (!isIntrinsic) return

      const attr = t.jsxAttribute(
        t.jsxIdentifier('data-spoon-loc'),
        t.stringLiteral(locValue),
      )
      path.node.attributes.push(attr)
      modified = true
    },
  })

  if (!modified) return undefined

  // Re-generate code from AST using Babel's code generator
  // @babel/generator ships as CJS so we access it via require-style default
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const generateModule = await import('@babel/generator')
  const generate = (generateModule as unknown as { default: typeof generateModule.default }).default ?? generateModule.default
  const { code } = generate(ast, { sourceMaps: false, retainLines: true }, source)

  return { code, map: null }
}
