import type { ResolvedSpoonOptions } from '../options.js'

/**
 * Returns the self-contained browser JS that powers the spoon overlay.
 * Injected as an inline <script type="module"> by transformIndexHtml.
 *
 * Kept as a single string so it ships in one round trip with zero
 * client-side deps. Everything inside runs in the user's page.
 */
export function overlayScript(opts: ResolvedSpoonOptions): string {
  return `
;(function spoonOverlay() {
  const HOTKEY = ${JSON.stringify(opts.hotkey)};
  const API = '/__spoon';

  let active = false;
  let panel = null;
  let tokens = { colors: [], spacing: [] };

  // ── Hotkey handling — matches on physical e.code so macOS' Alt-letter
  // substitution (Alt+S → "ß") doesn't break detection. ────────────────
  const hk = parseHotkey(HOTKEY);
  document.addEventListener('keydown', (e) => {
    if (active && e.key === 'Escape') { deactivate(); return; }
    if (
      !!e.altKey === hk.alt && !!e.ctrlKey === hk.ctrl &&
      !!e.shiftKey === hk.shift && !!e.metaKey === hk.meta &&
      e.code === hk.code
    ) {
      e.preventDefault();
      active ? deactivate() : activate();
    }
  });

  function parseHotkey(str) {
    const mods = { alt: false, ctrl: false, shift: false, meta: false, code: 'KeyS' };
    for (const p of str.split('+').map((x) => x.trim())) {
      const low = p.toLowerCase();
      if (low === 'alt' || low === 'option') mods.alt = true;
      else if (low === 'ctrl' || low === 'control') mods.ctrl = true;
      else if (low === 'shift') mods.shift = true;
      else if (low === 'meta' || low === 'cmd' || low === 'command') mods.meta = true;
      else if (/^[a-z]$/i.test(p)) mods.code = 'Key' + p.toUpperCase();
      else if (/^[0-9]$/.test(p)) mods.code = 'Digit' + p;
      else mods.code = p;
    }
    return mods;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async function activate() {
    active = true;
    document.body.style.cursor = 'crosshair';
    showToolbar();
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
    try {
      const res = await fetch(API + '/tokens');
      tokens = await res.json();
    } catch {}
  }

  function deactivate() {
    active = false;
    document.body.style.cursor = '';
    clearHighlight();
    hidePanel();
    hideToolbar();
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onClick, true);
  }

  // ── Hover highlight ───────────────────────────────────────────────────

  let highlightEl = null;
  function onHover(e) {
    if (e.target === highlightEl) return;
    if (panel && panel.contains(e.target)) return;
    clearHighlight();
    const el = e.target;
    if (!el.dataset || !el.dataset.spoonLoc) return;
    highlightEl = el;
    el._spoonOldOutline = el.style.outline;
    el._spoonOldOutlineOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #6366f1';
    el.style.outlineOffset = '2px';
  }
  function clearHighlight() {
    if (highlightEl) {
      highlightEl.style.outline = highlightEl._spoonOldOutline || '';
      highlightEl.style.outlineOffset = highlightEl._spoonOldOutlineOffset || '';
      highlightEl = null;
    }
  }

  function onClick(e) {
    if (panel && panel.contains(e.target)) return;
    const el = e.target.closest('[data-spoon-loc]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openPanel(el);
  }

  // ── Class taxonomy ────────────────────────────────────────────────────
  // Each entry: [groupId, predicate]. First match wins.

  const GROUPS = [
    ['layout',     /^(flex|grid|block|inline|inline-block|inline-flex|inline-grid|hidden|table|contents|flow-root|isolate|isolation-|float-|clear-|object-|overflow-|overscroll-|position-|static|fixed|absolute|relative|sticky|inset-|top-|right-|bottom-|left-|z-|order-|col-|row-|grid-|gap-|items-|justify-|content-|self-|place-|basis-|grow|shrink|wrap|nowrap|flex-)/],
    ['spacing',   /^(p[trblxy]?-|-?m[trblxy]?-|space-[xy]-|gap-)/],
    ['sizing',    /^(w-|h-|min-w-|min-h-|max-w-|max-h-|size-|aspect-)/],
    ['color',     /^(bg-|text-|border-|ring-|fill-|stroke-|accent-|caret-|decoration-|divide-|outline-|placeholder-|from-|via-|to-|shadow-)/],
    ['typography',/^(font-|text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|left|center|right|justify|start|end)|leading-|tracking-|whitespace-|break-|truncate|uppercase|lowercase|capitalize|normal-case|italic|not-italic|underline|overline|line-through|no-underline|antialiased|subpixel-antialiased)/],
    ['effects',   /^(rounded|border|shadow|opacity-|blur|brightness|contrast|grayscale|hue-rotate|invert|saturate|sepia|backdrop-|transition|duration-|delay-|ease-|animate-|transform|translate|rotate|scale|skew|origin-|cursor-|select-|pointer-events-|user-select-)/],
  ];

  function classifyToken(cls) {
    // strip variant prefixes (hover:, md:, dark:, group-hover:, etc.)
    const bareIdx = cls.lastIndexOf(':');
    const bare = bareIdx >= 0 ? cls.slice(bareIdx + 1) : cls;
    for (const [id, re] of GROUPS) {
      if (re.test(bare)) return id;
    }
    return 'other';
  }

  function parseClasses(str) {
    const tokens = (str || '').split(/\\s+/).filter(Boolean);
    const groups = { layout: [], spacing: [], sizing: [], color: [], typography: [], effects: [], other: [] };
    for (const tk of tokens) groups[classifyToken(tk)].push(tk);
    return groups;
  }

  function flattenGroups(groups) {
    return [
      ...groups.layout, ...groups.spacing, ...groups.sizing,
      ...groups.color, ...groups.typography, ...groups.effects, ...groups.other,
    ];
  }

  // ── Panel ─────────────────────────────────────────────────────────────

  function openPanel(el) {
    hidePanel();
    const loc = el.dataset.spoonLoc;
    const [file, lineStr] = loc.split(':');
    const line = Number(lineStr);

    const rect = el.getBoundingClientRect();
    panel = document.createElement('div');
    panel.id = '__spoon-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      top: Math.min(rect.bottom + 8, window.innerHeight - 460) + 'px',
      left: Math.max(Math.min(rect.left, window.innerWidth - 380), 8) + 'px',
      width: '360px',
      maxHeight: '70vh',
      background: '#1e1e2e',
      color: '#cdd6f4',
      borderRadius: '10px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '12px',
      zIndex: '2147483647',
      overflow: 'hidden',
      border: '1px solid #313244',
      display: 'flex',
      flexDirection: 'column',
    });

    const initialClass = el.className || '';
    const initialText = el.childNodes.length === 1 && el.firstChild.nodeType === 3
      ? el.firstChild.textContent : null;

    panel.dataset.origClass = initialClass;
    if (initialText !== null) panel.dataset.origText = initialText;

    panel.innerHTML = headerHtml(loc);
    panel.insertAdjacentHTML('beforeend', '<div id="__spoon-body" style="overflow:auto;flex:1;padding:10px 12px;display:flex;flex-direction:column;gap:12px;"></div>');
    panel.insertAdjacentHTML('beforeend', footerHtml());
    document.body.appendChild(panel);

    panel.querySelector('#__spoon-close').onclick = hidePanel;
    panel.querySelector('#__spoon-cancel').onclick = () => {
      el.className = initialClass;
      if (initialText !== null && el.firstChild) el.firstChild.textContent = initialText;
      hidePanel();
    };
    panel.querySelector('#__spoon-apply').onclick = () => applyEdits(el, file, line, initialClass, initialText);

    renderBody(el, initialText);
  }

  function headerHtml(loc) {
    return \`<div style="padding:9px 12px;background:#181825;display:flex;align-items:center;gap:8px;border-bottom:1px solid #313244;flex-shrink:0;">
      <span style="color:#6366f1;font-weight:700">⟡ spoon</span>
      <span style="flex:1;color:#585b70;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${esc(loc)}">\${esc(loc)}</span>
      <button id="__spoon-close" style="background:none;border:none;color:#585b70;cursor:pointer;font-size:18px;line-height:1;padding:0">×</button>
    </div>\`;
  }

  function footerHtml() {
    return \`<div style="padding:8px 12px;background:#181825;border-top:1px solid #313244;display:flex;gap:6px;align-items:center;flex-shrink:0;">
      <div id="__spoon-status" style="flex:1;font-size:11px;color:#a6e3a1;min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <button id="__spoon-cancel" style="background:#313244;color:#cdd6f4;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px">Cancel</button>
      <button id="__spoon-apply" style="background:#6366f1;color:#fff;border:none;border-radius:5px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:600">Apply →</button>
    </div>\`;
  }

  // ── Body rendering ────────────────────────────────────────────────────

  const GROUP_META = {
    layout:     { label: 'Layout',     color: '#89b4fa' },
    spacing:    { label: 'Spacing',    color: '#a6e3a1' },
    sizing:     { label: 'Sizing',     color: '#94e2d5' },
    color:      { label: 'Color',      color: '#f5c2e7' },
    typography: { label: 'Typography', color: '#fab387' },
    effects:    { label: 'Effects',    color: '#cba6f7' },
    other:      { label: 'Other',      color: '#bac2de' },
  };

  function renderBody(el, initialText) {
    const body = panel.querySelector('#__spoon-body');
    body.innerHTML = '';

    if (initialText !== null) {
      body.appendChild(textSection(el));
    }

    const groups = parseClasses(el.className);
    for (const id of Object.keys(GROUP_META)) {
      const items = groups[id];
      if (id === 'color') {
        body.appendChild(colorSection(el, items));
      } else {
        body.appendChild(genericSection(el, id, items));
      }
    }

    body.appendChild(rawSection(el));
  }

  function textSection(el) {
    const wrap = section('Text', '#f9e2af');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = el.firstChild?.textContent ?? '';
    Object.assign(input.style, inputStyle());
    input.addEventListener('input', () => {
      if (el.firstChild) el.firstChild.textContent = input.value;
    });
    input.dataset.role = 'text-input';
    wrap.appendChild(input);
    return wrap;
  }

  function genericSection(el, groupId, items) {
    const meta = GROUP_META[groupId];
    const wrap = section(meta.label, meta.color);

    const chipRow = document.createElement('div');
    Object.assign(chipRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    wrap.appendChild(chipRow);

    const renderChips = () => {
      chipRow.innerHTML = '';
      const groups = parseClasses(el.className);
      for (const cls of groups[groupId]) {
        chipRow.appendChild(chip(cls, meta.color, () => removeClass(el, cls, () => renderChips())));
      }
      chipRow.appendChild(addInput(el, groupId, () => renderChips()));
    };
    renderChips();
    return wrap;
  }

  function colorSection(el, items) {
    const meta = GROUP_META.color;
    const wrap = section(meta.label, meta.color);

    const chipRow = document.createElement('div');
    Object.assign(chipRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    wrap.appendChild(chipRow);

    const renderChips = () => {
      chipRow.innerHTML = '';
      const groups = parseClasses(el.className);
      for (const cls of groups.color) {
        chipRow.appendChild(chip(cls, meta.color, () => removeClass(el, cls, () => renderChips())));
      }
      chipRow.appendChild(addInput(el, 'color', () => renderChips()));
    };
    renderChips();

    if (tokens.colors && tokens.colors.length > 0) {
      const label = document.createElement('div');
      label.textContent = 'Theme tokens';
      Object.assign(label.style, { fontSize: '10px', color: '#585b70', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '.06em' });
      wrap.appendChild(label);

      const swatchRow = document.createElement('div');
      Object.assign(swatchRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const tk of tokens.colors) {
        swatchRow.appendChild(colorSwatch(tk, el, renderChips));
      }
      wrap.appendChild(swatchRow);
    }

    return wrap;
  }

  function rawSection(el) {
    const wrap = section('Raw className', '#585b70');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = el.className;
    Object.assign(input.style, inputStyle());
    input.style.fontSize = '11px';
    input.addEventListener('input', () => {
      el.className = input.value;
    });
    input.addEventListener('blur', () => {
      // re-render groups when leaving raw editor
      renderBody(el, el.firstChild?.nodeType === 3 ? el.firstChild.textContent : null);
    });
    wrap.appendChild(input);
    return wrap;
  }

  // ── UI atoms ──────────────────────────────────────────────────────────

  function section(title, accent) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '5px' });
    const h = document.createElement('div');
    h.textContent = title;
    Object.assign(h.style, {
      fontSize: '10px', color: accent, fontWeight: '700',
      textTransform: 'uppercase', letterSpacing: '.08em',
    });
    wrap.appendChild(h);
    return wrap;
  }

  function chip(text, accent, onRemove) {
    const c = document.createElement('span');
    Object.assign(c.style, {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      background: '#313244', color: '#cdd6f4',
      borderRadius: '4px', padding: '2px 6px', fontSize: '11px',
      borderLeft: \`2px solid \${accent}\`,
    });
    c.textContent = text;
    const x = document.createElement('button');
    x.textContent = '×';
    Object.assign(x.style, {
      background: 'none', border: 'none', color: '#585b70',
      cursor: 'pointer', padding: '0 0 0 2px', fontSize: '13px', lineHeight: '1',
    });
    x.onmouseenter = () => (x.style.color = '#f38ba8');
    x.onmouseleave = () => (x.style.color = '#585b70');
    x.onclick = onRemove;
    c.appendChild(x);
    return c;
  }

  function addInput(el, groupId, refresh) {
    const wrap = document.createElement('input');
    wrap.type = 'text';
    wrap.placeholder = '+ add';
    Object.assign(wrap.style, {
      background: 'transparent', border: '1px dashed #45475a',
      color: '#cdd6f4', borderRadius: '4px', padding: '2px 6px',
      fontSize: '11px', width: '70px', outline: 'none',
      fontFamily: 'inherit',
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && wrap.value.trim()) {
        addClass(el, wrap.value.trim());
        wrap.value = '';
        refresh();
      }
    });
    return wrap;
  }

  function colorSwatch(token, el, refresh) {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      width: '28px', height: '28px', borderRadius: '5px',
      border: '1px solid #45475a', cursor: 'pointer', padding: '0',
      background: token.preview,
      position: 'relative',
    });
    btn.title = \`\${token.name} → \${token.preview}\`;
    btn.onclick = () => {
      // Remove any existing bg-* / text-* and add the token-mapped one
      const className = el.className.split(/\\s+/).filter((c) => !/^bg-/.test(c)).join(' ');
      el.className = (className + ' bg-' + token.name).trim();
      refresh();
    };
    return btn;
  }

  function inputStyle() {
    return {
      background: '#313244', border: '1px solid #45475a',
      color: '#cdd6f4', borderRadius: '5px', padding: '5px 8px',
      fontFamily: 'inherit', fontSize: '12px', outline: 'none',
      width: '100%', boxSizing: 'border-box',
    };
  }

  function removeClass(el, cls, refresh) {
    el.className = el.className.split(/\\s+/).filter((c) => c !== cls).join(' ');
    refresh();
  }
  function addClass(el, cls) {
    const set = new Set(el.className.split(/\\s+/).filter(Boolean));
    set.add(cls);
    el.className = Array.from(set).join(' ');
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Apply (write-back) ────────────────────────────────────────────────

  async function applyEdits(el, file, line, origClass, origText) {
    const patches = [];
    if (el.className !== origClass) {
      patches.push({ type: 'class-replace', line, oldValue: origClass, newValue: el.className });
    }
    const textInput = panel.querySelector('[data-role="text-input"]');
    if (textInput && origText !== null && textInput.value !== origText) {
      patches.push({ type: 'text', line, oldValue: origText, newValue: textInput.value });
    }
    if (patches.length === 0) { setStatus('Nothing changed.'); return; }

    setStatus('Writing…');
    try {
      const res = await fetch(API + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, patches }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus('✓ Saved → ' + file);
        // Update originals so further edits patch against the new source
        panel.dataset.origClass = el.className;
        if (textInput) panel.dataset.origText = textInput.value;
      } else {
        setStatus('Error: ' + (data.error ?? 'unknown'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  function setStatus(msg) {
    const s = panel?.querySelector('#__spoon-status');
    if (s) s.textContent = msg;
  }

  function hidePanel() {
    panel?.remove();
    panel = null;
  }

  // ── Toolbar ───────────────────────────────────────────────────────────

  let toolbar = null;
  function showToolbar() {
    if (toolbar) return;
    toolbar = document.createElement('div');
    Object.assign(toolbar.style, {
      position: 'fixed', bottom: '16px', right: '16px',
      background: '#1e1e2e', border: '1px solid #6366f1',
      borderRadius: '8px', padding: '6px 12px', color: '#6366f1',
      fontFamily: 'monospace', fontSize: '11px', fontWeight: '600',
      zIndex: '2147483647', boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
      pointerEvents: 'none', userSelect: 'none',
    });
    toolbar.textContent = '⟡ spoon active — click any element';
    document.body.appendChild(toolbar);
  }
  function hideToolbar() { toolbar?.remove(); toolbar = null; }

  console.log('[spoon] loaded — press ' + HOTKEY + ' to activate visual editor');
})();
`
}
