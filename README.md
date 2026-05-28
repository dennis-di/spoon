# vite-plugin-spoon

> **"There is no spoon."**
>
> You reach out and touch the rendered surface.  
> Underneath, the real code bends.

`vite-plugin-spoon` is a Vite dev-mode plugin that turns your browser into a live source editor. Click any element, change its classes or text, hit **Apply** — and the actual `.tsx`/`.css` file on disk is updated instantly. HMR picks it up, no reload needed.

<!-- TODO: replace with real demo GIF once recorded -->
<!--
![spoon demo](https://raw.githubusercontent.com/yourusername/spoon/main/demo.gif)
-->

---

## Why this is different

| Tool | What it does |
|---|---|
| vite-plugin-react-inspector | Opens your editor at the right line — nothing more |
| react-scan | Shows re-renders — read-only |
| Figma Dev Mode | Design → code, but doesn't write back |
| **vite-plugin-spoon** | **Clicks element → edits the real source file** |

The write-back is the moat. Changes survive HMR, survive reload, survive everything — because they're in your code.

---

## Features

- **Click to select** — point at any DOM element instead of hunting through files
- **Live preview** — edit classes/text and see the result instantly in the browser
- **Write-back to source** — changes land in the real file at the exact line
- **Tailwind-aware** — auto-detects your Tailwind config and CSS variable tokens; edits at the token level, not raw pixels
- **Zero prod footprint** — overlay and middleware are never bundled or activated outside `vite dev`

---

## Install

```bash
npm install -D vite-plugin-spoon
# or
pnpm add -D vite-plugin-spoon
```

---

## Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { spoon } from 'vite-plugin-spoon'

export default defineConfig({
  plugins: [
    react(),
    spoon(), // always safe — only activates in dev mode
  ],
})
```

---

## Usage

1. Start your dev server (`vite dev`)
2. Press **`Alt+S`** in the browser → crosshair cursor + "spoon active" badge appears
3. Hover over any element — it highlights in indigo
4. Click it → edit panel opens showing its classes and text
5. Make changes, click **Apply →**
6. The source file updates, HMR reloads, done

Press **`Escape`** or **`Alt+S`** again to exit.

---

## Options

```ts
spoon({
  // Toggle the plugin entirely (default: true in dev)
  enabled: true,

  // Keyboard shortcut to activate/deactivate (default: 'Alt+S')
  hotkey: 'Alt+S',

  // Explicit path to tailwind.config.ts (auto-detected otherwise)
  tailwindConfig: './tailwind.config.ts',

  // CSS token files to scan (auto-detected from src/**/*.css otherwise)
  tokenFiles: ['./src/styles/tokens.css'],

  // Show the floating "spoon active" badge (default: true)
  toolbar: true,
})
```

---

## How it works

```
Browser                         Vite dev server                  File system
──────                         ───────────────                  ───────────
[click <div>]
  │  data-spoon-loc="src/App.tsx:42:6"
  │
  ├─ overlay.js opens panel
  │
  [user edits className]
  │
  ├─ POST /__spoon/write ──────► middleware.ts
  │   { file, patches }              │
  │                                  ├─ reads file
  │                                  ├─ applies line patches
  │                                  └─ writes file ──────────► src/App.tsx
  │                                                              (line 42 updated)
  ◄─────────────────────────── { ok: true }
                                     │
                               Vite HMR fires ──────────────► browser reloads module
```

**Source mapping** is done at build time: `@babel/parser` + `@babel/traverse` walk each `.tsx`/`.jsx` file and inject `data-spoon-loc="file:line:col"` onto every intrinsic DOM element. That attribute is the breadcrumb that carries the DOM node back to the exact source line.

---

## Roadmap

- [x] Phase 1: React + Tailwind write-back (classes, text)
- [ ] Style prop editing
- [ ] CSS variable / token picker UI
- [ ] Vue + CSS Modules (Phase 2)
- [ ] AI-assisted class suggestions ("make this button look more prominent")
- [ ] Multi-element selection

---

## Contributing

PRs welcome. Run `npm run dev` to build in watch mode, then `npm link` and link into a test project.

```bash
git clone https://github.com/yourusername/spoon
cd spoon
npm install
npm run dev
# in another terminal, inside your test project:
npm link vite-plugin-spoon
```

---

## License

MIT © Dennis DiBartolomeo
