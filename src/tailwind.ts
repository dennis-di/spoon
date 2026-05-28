import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { cwd } from 'node:process'
import type { ResolvedSpoonOptions } from './options.js'

export interface TokenData {
  hasTailwind: boolean
  configPath: string | null
  colors: Record<string, string>
  spacing: Record<string, string>
  tokenFiles: string[]
}

export async function detectTailwind(opts: ResolvedSpoonOptions): Promise<TokenData> {
  const root = cwd()

  // Detect tailwind config
  const candidates = [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ]
  const configPath =
    opts.tailwindConfig ??
    candidates.map((c) => join(root, c)).find(existsSync) ??
    null

  if (!configPath) {
    return { hasTailwind: false, configPath: null, colors: {}, spacing: {}, tokenFiles: [] }
  }

  // Scan for CSS variable token files
  const cssFiles = opts.tokenFiles.length > 0
    ? opts.tokenFiles
    : await findCssTokenFiles(root)

  const colors: Record<string, string> = {}
  const spacing: Record<string, string> = {}

  for (const file of cssFiles) {
    const content = await readFile(file, 'utf8').catch(() => '')
    parseCssVariables(content, colors, spacing)
  }

  return { hasTailwind: true, configPath, colors, spacing, tokenFiles: cssFiles }
}

async function findCssTokenFiles(root: string): Promise<string[]> {
  const { glob } = await import('node:fs')
  const { promisify } = await import('node:util')
  // Look for CSS files with variable definitions in common locations
  const patterns = ['src/**/*.css', 'styles/**/*.css', 'app/**/*.css']
  const results: string[] = []

  for (const pattern of patterns) {
    try {
      const globFn = promisify(glob)
      // @ts-ignore — node:fs glob available in Node 22+, fallback gracefully
      const matches: string[] = await globFn(resolve(root, pattern))
      for (const m of matches) {
        const content = await readFile(m, 'utf8').catch(() => '')
        if (content.includes('--')) results.push(m)
      }
    } catch {
      // glob not available in older Node, skip
    }
  }

  return results
}

function parseCssVariables(
  css: string,
  colors: Record<string, string>,
  spacing: Record<string, string>,
) {
  const varRe = /--([\w-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = varRe.exec(css)) !== null) {
    const name = m[1]
    const value = m[2].trim()
    if (/color|bg|text|border|ring/.test(name)) {
      colors[name] = value
    } else if (/space|gap|pad|margin|size|width|height/.test(name)) {
      spacing[name] = value
    }
  }
}
