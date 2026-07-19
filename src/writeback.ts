import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse

export interface EditOp {
  /** Set/replace the className string literal. */
  className?: string
  /** Set/replace the single text child of the element. */
  text?: string
  /**
   * Set/replace a single inline style property, e.g. { prop: 'background',
   * value: '#fff' }. value:'' removes the property. Only works on static
   * object-literal style props (style={{ ... }}); dynamic expressions are
   * rejected with a helpful error.
   */
  style?: { prop: string; value: string }
  /**
   * Structural op on the whole element: 'duplicate' inserts a copy as the
   * next sibling, 'remove' deletes it. Only allowed when the element sits
   * directly in JSX children (not inside {cond && ...} etc., where adding or
   * removing a sibling would produce invalid code).
   */
  element?: 'duplicate' | 'remove'
}

export interface WriteResult {
  ok: boolean
  code?: string
  error?: string
  /** What the className was before, so the caller can build an inverse op. */
  prevClassName?: string
  prevText?: string
  /** Previous value of the edited style prop (for inverse ops). */
  prevStyle?: { prop: string; value: string }
}

/**
 * Apply an edit to the JSX element at the given 0-based opening-tag
 * position. Works directly on the AST node ranges and splices the
 * original source by character offset, so all other formatting is
 * preserved and multi-line elements work correctly.
 */
export function applyEditAtLocation(
  source: string,
  line: number,
  column: number,
  op: EditOp,
): WriteResult {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
  } catch (e) {
    return { ok: false, error: 'parse error: ' + String(e) }
  }

  let openingNode: t.JSXOpeningElement | null = null
  let elementNode: t.JSXElement | null = null
  // Whether the element sits directly in a JSX children list — the only
  // context where duplicating/removing keeps the code parseable.
  let inChildrenList = false

  traverse(ast, {
    JSXOpeningElement(path) {
      const loc = path.node.loc
      if (!loc) return
      // data-spoon-loc carries 0-based column from Babel; match exactly
      if (loc.start.line === line && loc.start.column === column) {
        openingNode = path.node
        if (path.parentPath.isJSXElement()) {
          elementNode = path.parentPath.node
          const gp = path.parentPath.parentPath?.node
          inChildrenList = t.isJSXElement(gp) || t.isJSXFragment(gp)
        }
        path.stop()
      }
    },
  })

  if (!openingNode) {
    return { ok: false, error: `no JSX element at ${line}:${column}` }
  }

  // Collect edits as {start, end, replacement} then apply right-to-left
  // so earlier offsets stay valid.
  const edits: { start: number; end: number; replacement: string }[] = []
  let prevClassName: string | undefined
  let prevText: string | undefined
  let prevStyle: { prop: string; value: string } | undefined

  if (op.className !== undefined) {
    const r = classNameEdit(openingNode, op.className)
    if (r.error) return { ok: false, error: r.error }
    if (r.edit) edits.push(r.edit)
    prevClassName = r.prev
  }

  if (op.text !== undefined && elementNode) {
    const r = textEdit(elementNode, op.text)
    if (r.error) return { ok: false, error: r.error }
    if (r.edit) edits.push(r.edit)
    prevText = r.prev
  }

  if (op.style !== undefined) {
    const r = styleEdit(openingNode, op.style.prop, op.style.value, source)
    if (r.error) return { ok: false, error: r.error }
    if (r.edit) edits.push(r.edit)
    prevStyle = { prop: op.style.prop, value: r.prev ?? '' }
  }

  if (op.element !== undefined) {
    const el = elementNode as t.JSXElement | null
    if (!el || el.start == null || el.end == null) {
      return { ok: false, error: 'cannot locate element bounds' }
    }
    if (!inChildrenList) {
      // e.g. {open && <X/>} — a second sibling or an empty && arm won't parse
      return { ok: false, error: 'element sits inside a JSX expression — duplicating/removing it here would break the code. Edit in source or use a Claude task.' }
    }
    const s = el.start
    const e = el.end
    const lineStart = source.lastIndexOf('\n', s - 1) + 1
    const prefix = source.slice(lineStart, s)

    if (op.element === 'duplicate') {
      // Own-line elements get the copy on a new line with the same indent;
      // inline elements are duplicated inline.
      const sep = /^\s*$/.test(prefix) ? '\n' + prefix : ' '
      edits.push({ start: e, end: e, replacement: sep + source.slice(s, e) })
    } else if (op.element === 'remove') {
      const nl = source.indexOf('\n', e)
      const suffix = nl === -1 ? source.slice(e) : source.slice(e, nl)
      if (/^\s*$/.test(prefix) && /^\s*$/.test(suffix)) {
        // Element owns its line(s) — remove the whole line span, one newline included
        const start = lineStart > 0 ? lineStart - 1 : 0
        const end = lineStart > 0 ? (nl === -1 ? source.length : nl) : (nl === -1 ? source.length : nl + 1)
        edits.push({ start, end, replacement: '' })
      } else {
        edits.push({ start: s, end: e, replacement: '' })
      }
    } else {
      return { ok: false, error: 'unknown element op' }
    }
  }

  if (edits.length === 0) {
    return { ok: true, code: source, prevClassName, prevText, prevStyle }
  }

  edits.sort((a, b) => b.start - a.start)
  let code = source
  for (const e of edits) {
    code = code.slice(0, e.start) + e.replacement + code.slice(e.end)
  }

  return { ok: true, code, prevClassName, prevText, prevStyle }
}

/**
 * Edit a single property inside a static style={{ ... }} object literal.
 * Handles three cases: property exists (replace its value), property absent
 * (insert it), or no style prop at all (add style={{ prop: 'value' }}).
 * Dynamic style values (style={expr} or a conditional property value) are
 * rejected — we won't guess what a ternary should become.
 */
function styleEdit(
  opening: t.JSXOpeningElement,
  prop: string,
  value: string,
  fullSource: string,
): { edit?: { start: number; end: number; replacement: string }; prev?: string; error?: string } {
  const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
  )

  // No style prop yet — add style={{ prop: "value" }} after the tag name.
  if (!attr) {
    if (value === '') return { prev: '' }
    const nameEnd = opening.name.end
    if (nameEnd == null) return { error: 'cannot locate tag name end' }
    return {
      edit: { start: nameEnd, end: nameEnd, replacement: ` style={{ ${camel}: ${JSON.stringify(value)} }}` },
      prev: '',
    }
  }

  // style must be style={{ ...objectLiteral }}
  if (!t.isJSXExpressionContainer(attr.value) || !t.isObjectExpression(attr.value.expression)) {
    return { error: 'style is not a static object literal — edit it in source' }
  }
  const obj = attr.value.expression

  // Find the matching property (by camelCase identifier or string key)
  const existing = obj.properties.find((p): p is t.ObjectProperty => {
    if (!t.isObjectProperty(p)) return false
    if (t.isIdentifier(p.key)) return p.key.name === camel
    if (t.isStringLiteral(p.key)) return p.key.value === prop || p.key.value === camel
    return false
  })

  if (existing) {
    const v = existing.value

    // Removing the property (value === '') — splice out the whole
    // `prop: "..."` plus its trailing/leading comma so the object stays valid.
    // Only static string values may be removed: deleting a dynamic value
    // (e.g. a ternary that styles open/closed states) would silently destroy
    // app behaviour, which Spoon never does. Dynamic → hands off.
    if (value === '') {
      if (!t.isStringLiteral(v)) {
        return { error: `${prop} is set by a dynamic expression — edit it in source (or use a Claude task)` }
      }
      if (existing.start == null || existing.end == null) return { error: 'no range on style property' }
      const prevVal = v.value
      let start = existing.start
      let end = existing.end
      // Eat a trailing comma (and following whitespace) if present…
      const after = fullSource.slice(end)
      const trailingComma = after.match(/^\s*,/)
      if (trailingComma) {
        end += trailingComma[0].length
      } else {
        // …otherwise eat a preceding comma so we don't leave a dangling one.
        const before = fullSource.slice(0, start)
        const leadingComma = before.match(/,\s*$/)
        if (leadingComma) start -= leadingComma[0].length
      }
      return { edit: { start, end, replacement: '' }, prev: prevVal }
    }

    if (t.isStringLiteral(v)) {
      if (v.start == null || v.end == null) return { error: 'no range on style value' }
      return { edit: { start: v.start, end: v.end, replacement: JSON.stringify(value) }, prev: v.value }
    }
    // Dynamic value (ternary, template, member) — don't clobber app logic.
    return { error: `${prop} is set by a dynamic expression — edit it in source` }
  }

  // Property not present — insert it at the start of the object.
  if (value === '') return { prev: '' }
  if (obj.start == null) return { error: 'no range on style object' }
  const insertAt = obj.start + 1 // just after the opening {
  return {
    edit: { start: insertAt, end: insertAt, replacement: ` ${camel}: ${JSON.stringify(value)},` },
    prev: '',
  }
}

function classNameEdit(
  opening: t.JSXOpeningElement,
  next: string,
): { edit?: { start: number; end: number; replacement: string }; prev?: string; error?: string } {
  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'className',
  )

  // No className attribute yet — insert one right after the tag name.
  if (!attr) {
    if (next.trim() === '') return { prev: '' }
    const nameEnd = opening.name.end
    if (nameEnd == null) return { error: 'cannot locate tag name end' }
    return {
      edit: { start: nameEnd, end: nameEnd, replacement: ` className="${next}"` },
      prev: '',
    }
  }

  const value = attr.value

  // className="..."
  if (t.isStringLiteral(value)) {
    if (value.start == null || value.end == null) return { error: 'no range on string' }
    return {
      edit: { start: value.start, end: value.end, replacement: JSON.stringify(next) },
      prev: value.value,
    }
  }

  // className={"..."} or className={`...`} (simple cases)
  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression
    if (t.isStringLiteral(expr)) {
      if (expr.start == null || expr.end == null) return { error: 'no range on expr string' }
      return {
        edit: { start: expr.start, end: expr.end, replacement: JSON.stringify(next) },
        prev: expr.value,
      }
    }
    if (t.isTemplateLiteral(expr) && expr.quasis.length === 1) {
      const q = expr.quasis[0]
      if (q.start == null || q.end == null) return { error: 'no range on template' }
      return {
        edit: { start: q.start, end: q.end, replacement: '`' + next + '`' },
        prev: q.value.cooked ?? q.value.raw,
      }
    }
    // Dynamic className (cn(), conditionals, etc.) — too risky to rewrite blindly
    return { error: 'dynamic className expression — edit it in the Raw tab or source' }
  }

  return { error: 'unsupported className form' }
}

/**
 * Read the element's SOURCE-level className and text at a location.
 * The overlay uses this as the write baseline for components, whose DOM
 * className is the merged runtime list (e.g. shadcn's cn(...) output) and
 * must never be written back over the source value.
 * className: string = static value ('' if attribute missing), null = dynamic.
 */
export function readElementInfo(
  source: string,
  line: number,
  column: number,
): { ok: boolean; className?: string | null; text?: string | null; error?: string } {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  } catch (e) {
    return { ok: false, error: 'parse error: ' + String(e) }
  }

  let opening: t.JSXOpeningElement | null = null
  let element: t.JSXElement | null = null
  traverse(ast, {
    JSXOpeningElement(path) {
      const loc = path.node.loc
      if (!loc) return
      if (loc.start.line === line && loc.start.column === column) {
        opening = path.node
        if (path.parentPath.isJSXElement()) element = path.parentPath.node
        path.stop()
      }
    },
  })
  if (!opening) return { ok: false, error: `no JSX element at ${line}:${column}` }

  const attr = (opening as t.JSXOpeningElement).attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'className',
  )
  let className: string | null = ''
  if (attr) {
    const v = attr.value
    if (t.isStringLiteral(v)) className = v.value
    else if (t.isJSXExpressionContainer(v)) {
      const expr = v.expression
      if (t.isStringLiteral(expr)) className = expr.value
      else if (t.isTemplateLiteral(expr) && expr.quasis.length === 1) {
        className = expr.quasis[0].value.cooked ?? expr.quasis[0].value.raw
      } else className = null // dynamic (cn(), conditionals)
    } else className = null
  }

  let text: string | null = null
  if (element) {
    const tc = (element as t.JSXElement).children.filter(
      (c): c is t.JSXText => t.isJSXText(c) && c.value.trim() !== '',
    )
    if (tc.length === 1) text = tc[0].value.trim()
  }

  return { ok: true, className, text }
}

function textEdit(
  element: t.JSXElement,
  next: string,
): { edit?: { start: number; end: number; replacement: string }; prev?: string; error?: string } {
  // Find JSXText children (ignore whitespace-only ones).
  const textChildren = element.children.filter(
    (c): c is t.JSXText => t.isJSXText(c) && c.value.trim() !== '',
  )

  if (textChildren.length === 1) {
    const node = textChildren[0]
    if (node.start == null || node.end == null) return { error: 'no range on text' }
    // Preserve surrounding whitespace of the original JSXText token.
    const raw = node.value
    const leading = raw.match(/^\s*/)?.[0] ?? ''
    const trailing = raw.match(/\s*$/)?.[0] ?? ''
    return {
      edit: { start: node.start, end: node.end, replacement: leading + next + trailing },
      prev: raw.trim(),
    }
  }

  if (textChildren.length === 0) {
    return { error: 'no editable text child (it may be a {variable} or nested element)' }
  }

  return { error: 'multiple text children — edit in source' }
}
