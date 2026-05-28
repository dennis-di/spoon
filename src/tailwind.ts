import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cwd } from 'node:process'
import type { ResolvedSpoonOptions } from './options.js'

export interface ThemeColor {
  /** Tailwind/semantic name, e.g. "primary", "background" */
  name: string
  /** CSS variable name without leading -- */
  varName: string
  /** A CSS value that previews the color, e.g. "hsl(166, 95%, 36%)" */
  preview: string
  /** Raw value as found in the CSS file */
  raw: string
}

export interface ThemeSpacing {
  name: string
  varName: string
  value: string
}

export interface TokenData {
  hasTailwind: boolean
  configPath: string | null
  colors: ThemeColor[]
  spacing: ThemeSpacing[]
  /** Files that were scanned for tokens */
  tokenFiles: string[]
}

export async function detectTailwind(opts: ResolvedSpoonOptions): Promise<TokenData> {
  const root = cwd()

  const candidates = [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ]
  const configPath =
    opts.tailwindConfig ?? candidates.map((c) => join(root, c)).find(existsSync) ?? null

  const cssFiles = opts.tokenFiles.length > 0 ? opts.tokenFiles : findCssTokenFiles(root)

  const colors: ThemeColor[] = []
  const spacing: ThemeSpacing[] = []
  const seen = new Set<string>()

  for (const file of cssFiles) {
    const content = await readFile(file, 'utf8').catch(() => '')
    parseTokens(content, colors, spacing, seen)
  }

  return {
    hasTailwind: configPath !== null,
    configPath,
    colors,
    spacing,
    tokenFiles: cssFiles,
  }
}

function findCssTokenFiles(root: string): string[] {
  const results: string[] = []
  const seenDirs = new Set<string>()

  // Walk shallow common roots without pulling in a glob dep.
  const roots = ['src', 'styles', 'app', 'css']
  for (const r of roots) {
    walk(join(root, r), results, seenDirs, 0)
  }
  return results
}

function walk(dir: string, out: string[], seen: Set<string>, depth: number) {
  if (depth > 4) return
  if (seen.has(dir) || !existsSync(dir)) return
  seen.add(dir)

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, out, seen, depth + 1)
    } else if (st.isFile() && entry.endsWith('.css')) {
      out.push(full)
    }
  }
}

const COLOR_NAME_HINT = /color|bg|fg|text|border|ring|background|foreground|primary|secondary|accent|muted|destructive|popover|card|sidebar|input/i
const SPACING_NAME_HINT = /space|gap|pad|margin|size|width|height|radius|inset/i
const HSL_TRIPLE = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/
const HEX = /^#[0-9a-fA-F]{3,8}$/
const COLOR_FN = /^(rgba?|hsla?|oklch|color)\s*\(/i

function parseTokens(
  css: string,
  colors: ThemeColor[],
  spacing: ThemeSpacing[],
  seen: Set<string>,
) {
  const varRe = /--([\w-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = varRe.exec(css)) !== null) {
    const name = m[1]
    const raw = m[2].trim()
    const key = `${name}:${raw}`
    if (seen.has(key)) continue
    seen.add(key)

    const colorPreview = toColorPreview(raw)
    if (colorPreview && COLOR_NAME_HINT.test(name)) {
      colors.push({ name, varName: name, preview: colorPreview, raw })
    } else if (SPACING_NAME_HINT.test(name)) {
      spacing.push({ name, varName: name, value: raw })
    }
  }
}

/**
 * Tailwind/shadcn convention writes HSL as space-separated triple ("220 14% 94%")
 * so they can wrap it in `hsl(var(--background))`. We re-wrap it here for preview.
 */
function toColorPreview(raw: string): string | null {
  if (HEX.test(raw)) return raw
  if (COLOR_FN.test(raw)) return raw
  const hsl = raw.match(HSL_TRIPLE)
  if (hsl) return `hsl(${hsl[1]}, ${hsl[2]}%, ${hsl[3]}%)`
  return null
}
