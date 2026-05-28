import type { Plugin, ViteDevServer } from 'vite'
import { createMiddleware } from './middleware.js'
import { SpoonOptions, resolvedOptions } from './options.js'

export type { SpoonOptions }

export function spoon(options: SpoonOptions = {}): Plugin {
  const opts = resolvedOptions(options)
  let server: ViteDevServer

  return {
    name: 'vite-plugin-spoon',
    apply: 'serve',

    configureServer(s) {
      server = s
      s.middlewares.use('/__spoon', createMiddleware(opts))
    },

    async transform(code, id) {
      if (!opts.enabled) return
      if (!isJSX(id)) return
      return injectLocationData(code, id)
    },

    transformIndexHtml() {
      if (!opts.enabled) return []
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: overlayBootstrap(),
          injectTo: 'body',
        },
      ]
    },
  }
}

function isJSX(id: string): boolean {
  return /\.(jsx|tsx)$/.test(id) && !id.includes('node_modules')
}

async function injectLocationData(code: string, id: string): Promise<{ code: string; map: null } | undefined> {
  try {
    const { transformWithLocation } = await import('./transform.js')
    return transformWithLocation(code, id)
  } catch (e) {
    console.warn('[spoon] transform error:', e)
    return undefined
  }
}

function overlayBootstrap(): string {
  return `
import('/__spoon/overlay.js').catch(() => {})
`
}

export default spoon
