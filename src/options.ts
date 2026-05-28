export interface SpoonOptions {
  /**
   * Enable the plugin. Defaults to true in development.
   */
  enabled?: boolean

  /**
   * Keyboard shortcut to toggle the spoon overlay.
   * @default 'Alt+S'
   */
  hotkey?: string

  /**
   * Tailwind config file path (auto-detected if omitted).
   */
  tailwindConfig?: string

  /**
   * CSS token file paths to scan for design tokens.
   * Auto-detected from project root if omitted.
   */
  tokenFiles?: string[]

  /**
   * Whether to show the floating toolbar.
   * @default true
   */
  toolbar?: boolean
}

export interface ResolvedSpoonOptions {
  enabled: boolean
  hotkey: string
  tailwindConfig: string | null
  tokenFiles: string[]
  toolbar: boolean
}

export function resolvedOptions(opts: SpoonOptions): ResolvedSpoonOptions {
  return {
    enabled: opts.enabled ?? true,
    hotkey: opts.hotkey ?? 'Alt+S',
    tailwindConfig: opts.tailwindConfig ?? null,
    tokenFiles: opts.tokenFiles ?? [],
    toolbar: opts.toolbar ?? true,
  }
}
