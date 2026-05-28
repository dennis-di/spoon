import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { cwd } from 'node:process'
import type { ResolvedSpoonOptions } from './options.js'
import { overlayScript } from './overlay/script.js'
import { detectTailwind } from './tailwind.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function createMiddleware(opts: ResolvedSpoonOptions): Handler {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace('/__spoon', '') || '/'

    // Serve the browser overlay JS
    if (path === '/overlay.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(overlayScript(opts))
      return
    }

    // API: read current value at a source location
    if (path === '/read' && req.method === 'GET') {
      const file = url.searchParams.get('file')
      const line = Number(url.searchParams.get('line'))
      if (!file) return badRequest(res, 'missing file param')
      try {
        const abs = resolve(cwd(), file)
        const src = await readFile(abs, 'utf8')
        const lines = src.split('\n')
        json(res, { line: lines[line - 1] ?? '', totalLines: lines.length })
      } catch (e) {
        json(res, { error: String(e) }, 500)
      }
      return
    }

    // API: write-back a patch to the source file
    if (path === '/write' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let payload: WritePayload
      try {
        payload = JSON.parse(body)
      } catch {
        return badRequest(res, 'invalid JSON')
      }

      const { file, patches } = payload
      if (!file || !Array.isArray(patches)) return badRequest(res, 'invalid payload')

      const ext = extname(file)
      const allowed = ['.tsx', '.ts', '.jsx', '.js', '.css']
      if (!allowed.includes(ext)) return badRequest(res, 'file type not allowed')

      try {
        const abs = resolve(cwd(), file)
        let src = await readFile(abs, 'utf8')
        src = applyPatches(src, patches)
        await writeFile(abs, src, 'utf8')
        json(res, { ok: true })
      } catch (e) {
        json(res, { error: String(e) }, 500)
      }
      return
    }

    // API: detect design system tokens
    if (path === '/tokens' && req.method === 'GET') {
      const tokens = await detectTailwind(opts)
      json(res, tokens)
      return
    }

    res.writeHead(404)
    res.end()
  }
}

interface Patch {
  type: 'class-replace' | 'class-add' | 'class-remove' | 'text' | 'style-prop'
  /** 1-based line number in the source file */
  line: number
  column?: number
  /** For class patches: the old class string to find */
  oldValue?: string
  /** Replacement / new value */
  newValue: string
}

interface WritePayload {
  file: string
  patches: Patch[]
}

function applyPatches(src: string, patches: Patch[]): string {
  const lines = src.split('\n')

  for (const patch of patches) {
    const idx = patch.line - 1
    if (idx < 0 || idx >= lines.length) continue
    const line = lines[idx]

    if (patch.type === 'class-replace' && patch.oldValue !== undefined) {
      lines[idx] = line.replace(patch.oldValue, patch.newValue)
    } else if (patch.type === 'class-add') {
      // Insert before the closing quote of className="..."
      lines[idx] = line.replace(
        /(className=["'`])([^"'`]*)(["'`])/,
        (_, open, existing, close) => `${open}${existing} ${patch.newValue}`.trimStart() + close,
      )
    } else if (patch.type === 'class-remove' && patch.oldValue !== undefined) {
      lines[idx] = line.replace(
        new RegExp(`\\b${escapeRe(patch.oldValue)}\\b\\s?`, 'g'),
        '',
      )
    } else if (patch.type === 'text') {
      lines[idx] = line.replace(patch.oldValue ?? />[^<]*</, `>${patch.newValue}<`)
    } else if (patch.type === 'style-prop' && patch.oldValue !== undefined) {
      lines[idx] = line.replace(patch.oldValue, patch.newValue)
    }
  }

  return lines.join('\n')
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function badRequest(res: ServerResponse, msg: string) {
  json(res, { error: msg }, 400)
}
