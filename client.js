/**
 * dsh-cad-studio — Client half (right-pane panel).
 *
 * One tab ("CAD 工作室") with a three.js viewport, an instance tree and the
 * runtime line. Scenes arrive from the Host bridge: the panel polls the state
 * pointer and renders whatever scene id the last tool call published, so a
 * modelling step shows up here without the user reopening anything.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cad-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const ROUTE = '/cad-studio'
    const scriptCache = new Map()

    /** Load a classic (non-module) script once, resolving when it ran. */
    function loadScript(src) {
      if (scriptCache.has(src)) return scriptCache.get(src)
      const promise = new Promise((resolve, reject) => {
        const el = document.createElement('script')
        el.src = src
        el.async = true
        el.onload = () => resolve()
        el.onerror = () => reject(new Error(`failed to load ${src}`))
        document.head.appendChild(el)
      })
      scriptCache.set(src, promise)
      return promise
    }

    async function loadThree() {
      if (!window.THREE) await loadScript(`${ROUTE}/assets/three.min.js`)
      if (!window.THREE) throw new Error('three.js did not register window.THREE')
      await loadScript(`${ROUTE}/assets/OrbitControls.js`)
      return window.THREE
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12 },
      head: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,.25))' },
      title: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto' },
      meta: { marginLeft: 'auto', opacity: 0.65, whiteSpace: 'nowrap' },
      viewToggles: { display: 'inline-flex', gap: 6, marginLeft: 10, flex: 'none', whiteSpace: 'nowrap' },
      toggleChip: (on) => ({
        font: 'inherit', fontSize: 11, lineHeight: 1.4, cursor: 'pointer',
        padding: '2px 8px', borderRadius: 999,
        border: `1px solid ${on ? 'rgba(80,140,220,.75)' : 'rgba(120,130,145,.45)'}`,
        background: on ? 'rgba(80,140,220,.18)' : 'transparent',
        color: on ? 'inherit' : 'inherit', opacity: on ? 1 : 0.55,
      }),
      // The pane usually owns a third of the screen, so the 3D view gets the
      // whole body and the parts tree slides over it instead of stealing width.
      split: { position: 'relative', display: 'flex', flex: 1, minHeight: 0 },
      tree: {
        position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 20,
        width: 'min(72%, 260px)', overflow: 'auto', padding: '6px 4px',
        borderRight: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
        boxShadow: '6px 0 18px rgba(0,0,0,.16)',
      },
      headBtn: { font: 'inherit', fontSize: 11, padding: '2px 7px', borderRadius: 5, border: '1px solid rgba(120,130,145,.45)', background: 'transparent', cursor: 'pointer', flex: 'none', lineHeight: 1.5 },
      stats: { position: 'absolute', left: 8, bottom: 6, zIndex: 10, fontSize: 10, opacity: 0.62, pointerEvents: 'none', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      menu: { position: 'absolute', right: 6, top: 30, zIndex: 40, minWidth: 132, padding: 4, borderRadius: 6, border: '1px solid', boxShadow: '0 10px 26px rgba(0,0,0,.3)' },
      menuRow: { display: 'flex', gap: 4, padding: '3px 4px', flexWrap: 'wrap' },
      // Same content, but poured into the floating panel instead of a popup.
      menuInline: { position: 'static', minWidth: 0, padding: '2px 4px 4px', border: 'none', boxShadow: 'none', borderRadius: 0, background: 'transparent' },
      // ── activity rail (VSCode's left bar, sized for a 1/3-screen pane) ──
      rail: { flex: 'none', width: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '4px 0', borderRight: '1px solid' },
      railBtn: (active) => ({
        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 5, padding: 0, cursor: 'pointer', background: active ? 'rgba(77,107,254,0.16)' : 'transparent',
        color: active ? '#4d6bfe' : 'inherit', opacity: active ? 1 : 0.62,
        boxShadow: active ? 'inset 2px 0 0 #4d6bfe' : 'none',
      }),
      floatPanel: { position: 'absolute', top: 3, left: 4, zIndex: 30, display: 'flex', flexDirection: 'column', width: 'min(calc(100% - 38px), 248px)', maxHeight: 'calc(100% - 8px)', borderRadius: 10, border: '1px solid', overflow: 'hidden', boxShadow: '0 10px 26px rgba(0,0,0,.28)' },
      floatHead: { flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px', fontSize: 11.5, fontWeight: 600, borderBottom: '1px solid rgba(127,127,127,.18)' },
      floatBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '3px 0 4px' },
      modelRow: (active) => ({ display: 'flex', flexDirection: 'column', gap: 1, width: '100%', textAlign: 'left', padding: '5px 9px', border: 'none', background: active ? 'rgba(77,107,254,0.14)' : 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', borderRadius: 0 }),
      modelName: { fontSize: 11.5, fontWeight: active => (active ? 600 : 400), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      modelMeta: { fontSize: 9.5, opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      installBox: { margin: '8px 9px 6px', padding: '8px 9px', borderRadius: 8, border: '1px solid rgba(224,163,58,.45)', background: 'rgba(224,163,58,.10)', fontSize: 11, lineHeight: 1.5 },
      installBtn: { marginTop: 6, width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(77,107,254,.5)', background: 'rgba(77,107,254,.16)', color: 'inherit', fontSize: 11, cursor: 'pointer' },
      installHint: { opacity: 0.72, marginTop: 4, wordBreak: 'break-all' },
      infoRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '3px 9px', fontSize: 11 },
      infoKey: { opacity: 0.55, fontSize: 10 },
      infoVal: { fontVariantNumeric: 'tabular-nums' },
      menuLabel: { fontSize: 10, opacity: 0.55, padding: '2px 4px 0' },
      node: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 4, cursor: 'pointer' },
      // The picked row mirrors the outline drawn in the viewport (dsh-cad's
      // partRowActive uses the same "selected" token and inset ring).
      treeHint: { fontSize: 9.5, opacity: 0.55, padding: '0 6px 5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      nodePicked: { background: 'rgba(77,107,254,0.12)', boxShadow: 'inset 0 0 0 1px rgba(77,107,254,0.45)' },
      // A 20x20 square: anything with flex-grow here stretches into a big dead
      // strip of empty header, which is what titleBtn did when it drove the ⌄.
      barBtn: (skin) => ({
        flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, padding: 0, border: '1px solid transparent', borderRadius: 5,
        background: 'transparent', color: skin.color, fontSize: 12, lineHeight: 1,
        cursor: 'pointer',
      }),
      tabs: { position: 'relative', display: 'flex', alignItems: 'center', gap: 3, flex: '1 1 auto', minWidth: 0, overflow: 'visible', '--cad-tab-basis': 'calc((100% - 50px - 26px - 18px) / 5)' },
      // Anchor the "+" menu to the strip's right edge: because "+" is the
      // last thing in the row, this keeps the menu hanging off that button
      // as tabs open and close.
      addMenu: { position: 'absolute', top: 'calc(100% + 4px)', zIndex: 40, width: 224, maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: 3, borderRadius: 8, border: '1px solid', boxShadow: '0 10px 26px rgba(0,0,0,.32)' },
      addRow: (active) => ({ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, padding: '5px 7px', borderRadius: 6, border: 'none', background: active ? 'rgba(77,107,254,.16)' : 'transparent', textAlign: 'left', cursor: 'pointer', font: 'inherit' }),
      addHint: { padding: '6px 8px', fontSize: 10.5, opacity: 0.6 },
      // A model tab is laid out at the width it would have with five tabs open
      // (--cad-tab-basis on the strip), so adding the first one does not stretch
      // it across the whole strip and the row never reflows as tabs come and go.
      // It may shrink if the activity label grows, but never grows.
      tab: (active, skin, fixed) => ({
        display: 'flex', alignItems: 'center', gap: 4, minWidth: 0,
        maxWidth: fixed ? 'calc(100% - 28px)' : 'var(--cad-tab-basis)',
        flex: fixed ? '0 0 auto' : '0 1 var(--cad-tab-basis)',
        height: 22, padding: '0 7px', border: `1px solid ${active ? 'rgba(77,107,254,.42)' : 'transparent'}`, borderRadius: 6,
        background: active ? skin.itemActive.background : skin.button.background,
        color: active ? skin.list.color : skin.button.color,
        fontSize: 11, lineHeight: '20px', fontWeight: active ? 600 : 400,
        opacity: active ? 1 : 0.66, cursor: 'pointer', whiteSpace: 'nowrap',
      }),
      tabLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // Green while freecadcmd is there: the activity tab is the pane's live
      // channel, so the engine status belongs on it rather than as a loose dot.
      tabStatus: (ok) => ({ width: 5, height: 5, borderRadius: '50%', flex: '0 0 auto', background: ok ? '#2ea043' : '#e0a33a' }),
      tabDot: { width: 5, height: 5, borderRadius: '50%', background: '#4d6bfe', flex: '0 0 auto' },
      tabClose: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, marginRight: -2, borderRadius: 3, fontSize: 12, lineHeight: 1, opacity: 0.55, flex: '0 0 auto' },
      pickChip: { position: 'absolute', left: 6, bottom: 8, zIndex: 12, display: 'flex', alignItems: 'center', gap: 6, maxWidth: 'calc(100% - 16px)', padding: '3px 8px', borderRadius: 999, border: '1px solid', fontSize: 10.5, font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden' },
      // Accepts a CSS colour string (hex) — the palette and the per-part
      // overrides both speak hex, and round-tripping through an rgb() triple
      // twice is how the swatches once rendered pure white.
      swatch: (color) => ({ width: 10, height: 10, borderRadius: 2, flex: 'none', background: color }),
      swatchButton: { padding: 2, margin: 0, border: 0, background: 'transparent', cursor: 'pointer', display: 'inline-flex', borderRadius: 3, flex: 'none' },
      eyeButton: { marginLeft: 'auto', padding: 2, border: 0, background: 'transparent', cursor: 'pointer', display: 'inline-flex', opacity: 0.85, flex: 'none' },
      colorPop: { position: 'absolute', top: '100%', left: 4, zIndex: 40, padding: 6, borderRadius: 6, border: '1px solid', boxShadow: '0 10px 26px rgba(0,0,0,.3)', display: 'flex', flexDirection: 'column', gap: 5 },
      colorRow: { display: 'grid', gridTemplateColumns: 'repeat(6, 14px)', gap: 4 },
      colorCell: { width: 14, height: 14, padding: 0, borderRadius: 3, border: '1px solid rgba(128,128,128,.35)', cursor: 'pointer' },
      colorAuto: { padding: '3px 6px', borderRadius: 4, border: '1px solid', cursor: 'pointer', fontSize: 10, font: 'inherit' },
      stage: { position: 'relative', flex: 1, minWidth: 0, minHeight: 0, background: 'transparent' },
      // --- inspector (选中实例属性) -------------------------------------
      propName: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px 6px', fontWeight: 600, fontSize: 11.5, minWidth: 0 },
      propSub: { fontSize: 9.5, opacity: 0.55, padding: '0 2px 8px', wordBreak: 'break-all' },
      propRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', minWidth: 0 },
      propLabel: { fontSize: 10.5, opacity: 0.62, flex: 'none', width: 34 },
      propValue: { marginLeft: 'auto', fontSize: 10, opacity: 0.75, fontVariantNumeric: 'tabular-nums', flex: 'none' },
      slider: { flex: '1 1 auto', minWidth: 0, height: 14, accentColor: '#4d6bfe', cursor: 'pointer' },
      jointNum: { width: 52, flex: '0 0 auto', padding: '1px 3px', fontSize: 10.5, textAlign: 'right', color: 'inherit', background: 'rgba(125,135,155,0.12)', border: '1px solid transparent', borderRadius: 4, outline: 'none', fontVariantNumeric: 'tabular-nums' },
      sliderRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 5px 8px' },
      propBtn: { font: 'inherit', fontSize: 10.5, padding: '3px 8px', borderRadius: 5, border: '1px solid', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
      propBtns: { display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 2px 2px' },
      propEmpty: { padding: '10px 6px', fontSize: 10.5, opacity: 0.6, lineHeight: 1.7 },
      // Feature list: dense rows, each step a small block with its own numbers.
      featBlock: { padding: '3px 0 5px', borderBottom: '1px solid rgba(120,130,145,.16)' },
      featHead: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 },
      featId: { width: 18, flex: 'none', textAlign: 'center', fontSize: 9.5, lineHeight: '14px', borderRadius: 3, background: 'rgba(120,130,145,.14)', opacity: 0.8, fontVariantNumeric: 'tabular-nums' },
      featLabel: { fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto', minWidth: 0 },
      microBtn: { font: 'inherit', fontSize: 10, lineHeight: 1, padding: '2px 3px', border: 0, borderRadius: 4, background: 'transparent', color: 'inherit', opacity: 0.55, cursor: 'pointer', flex: 'none' },
      featField: { display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 12, marginTop: 2 },
      featFieldLabel: { fontSize: 9.5, opacity: 0.55, width: 52, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 'none' },
      featInput: { font: 'inherit', fontSize: 10.5, fontVariantNumeric: 'tabular-nums', width: '100%', minWidth: 0, padding: '1px 4px', borderRadius: 4, border: '1px solid rgba(120,130,145,.35)', background: 'transparent', color: 'inherit' },
      featAddMenu: { display: 'flex', flexWrap: 'wrap', gap: 3, padding: '4px 2px 6px' },
      featAddItem: { font: 'inherit', fontSize: 10, padding: '2px 6px', borderRadius: 5, border: '1px solid rgba(120,130,145,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      featError: { fontSize: 10, color: '#e0563f', padding: '2px 6px 4px', lineHeight: 1.5 },
      canvasHost: { position: 'absolute', inset: 0 },
      empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6, padding: 24, textAlign: 'center', lineHeight: 1.7 },
      // The file viewer still closes its ⋯ menu on an outside press; the panel
      // does not (VSCode keeps the sidebar open when you click the editor).
      warn: { margin: 10, padding: 10, borderRadius: 6, background: 'rgba(210,153,34,.12)', border: '1px solid rgba(210,153,34,.4)', lineHeight: 1.6 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      picker: { position: 'relative', margin: '0 0 6px', flex: 'none' },
      pickerButton: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 6px', fontSize: 11, borderRadius: 5, border: '1px solid', cursor: 'pointer', textAlign: 'left', font: 'inherit' },
      pickerLabel: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickerChevron: { flex: 'none', opacity: 0.7 },
      pickerList: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, borderRadius: 6, border: '1px solid', boxShadow: '0 8px 24px rgba(0,0,0,.28)', maxHeight: 260, overflowY: 'auto', padding: 3 },
      pickerItem: { display: 'flex', flexDirection: 'column', gap: 1, width: '100%', padding: '5px 7px', border: 0, borderRadius: 4, cursor: 'pointer', textAlign: 'left', font: 'inherit', background: 'transparent' },
      pickerItemName: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickerItemMeta: { fontSize: 10, opacity: 0.6 },
    }

    /** Fit a perspective camera to a bounding box. */
    function frameCamera(THREE, camera, controls, box) {
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const radius = size.length() * 0.5 || 1
      const vHalf = ((camera.fov * Math.PI) / 180) / 2
      // A tall narrow pane has a narrower horizontal half-angle than vertical;
      // fit against whichever is tighter, then add a small margin.
      const aspect = camera.aspect || 1
      const hHalf = Math.atan(Math.tan(vHalf) * aspect)
      const distance = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.35
      const dir = new THREE.Vector3(0.62, -0.78, 0.52).normalize()
      camera.position.copy(center).add(dir.multiplyScalar(distance))
      camera.near = Math.max(distance / 1000, 0.01)
      camera.far = distance * 20
      camera.updateProjectionMatrix()
      controls.target.copy(center)
      controls.update()
    }

    /** Build three objects from the scene payload; returns a dispose() handle. */
    /** Build the three.js scene graph (no GL context needed — testable headless). */
    // Theme: the DSH shell drives dark mode from the DOM — `color-scheme` on
    // <html> (appearance setting) and `body[data-ds-dark-theme]` — and a bare
    // browser preview publishes neither, so the OS preference decides. Same
    // signals dsh-cad resolves (client/theme.ts), so both viewers agree.
    const SCENE_THEMES = {
      light: {
        canvas: 'linear-gradient(#f5f6f8, #e9ecf0)',
        gridCenter: 0x8a919c,
        gridLine: 0x4a4f58,
        gridOpacity: 0.34,
        edge: 0x33404f,
        edgeOpacity: 0.78,
        mesh: 0x9fb4c7,
        hemisphereGround: 0x595f6b,
        lightScale: 1,
        axisX: 0xd23b3b,
        axisY: 0x2e9e44,
        axisZ: 0x2b6fd6,
        select: 0x2b6fd6,
      },
      dark: {
        canvas: 'linear-gradient(#1b1b1c, #151517)',
        gridCenter: 0x6b7280,
        gridLine: 0x3f4550,
        gridOpacity: 0.5,
        edge: 0xd2d7de,
        edgeOpacity: 0.7,
        mesh: 0xa9b9c9,
        hemisphereGround: 0x343941,
        lightScale: 0.58,
        axisX: 0xff7a7a,
        axisY: 0x5fe08a,
        axisZ: 0x74a9ff,
        select: 0x74a9ff,
      },
    }

    function resolveTheme() {
      try {
        const scheme = String((document.documentElement && document.documentElement.style.colorScheme) || '').toLowerCase()
        const declaresDark = scheme.includes('dark')
        const declaresLight = scheme.includes('light')
        if (declaresDark && !declaresLight) return 'dark'
        if (declaresLight && !declaresDark) return 'light'
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch {
        return 'light'
      }
    }

    /** Call the listener whenever the host flips light/dark. */
    function subscribeTheme(listener) {
      try {
        const observer = new MutationObserver(listener)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
        if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
        const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
        if (mq && mq.addEventListener) mq.addEventListener('change', listener)
        return () => {
          observer.disconnect()
          if (mq && mq.removeEventListener) mq.removeEventListener('change', listener)
        }
      } catch {
        return () => {}
      }
    }

    // Instance colours follow two rules borrowed from real assembly panels:
    // a *designed* palette in list order (so neighbours differ instead of
    // colliding like a hash does), and enough contrast to tell glass from a
    // bracket. "muted" is dsh-cad's own pastel ramp (src/modeling/assembly.ts
    // INSTANCE_PALETTE); "vivid" is Okabe-Ito, the colour-blind-safe set.
    const PALETTES = {
      muted: {
        light: [
          '#ae5254', '#3f844e', '#845cb4', '#9a820f', '#29837b', '#a5576c',
          '#6c904b', '#5272af', '#a95c1e', '#1e8476', '#8e5ca1', '#4a76a5',
        ],
        dark: [
          '#bd6868', '#589563', '#9570c1', '#aa943d', '#48948c', '#b46c7e',
          '#80a163', '#6684bd', '#b8713e', '#429588', '#9e70af', '#6088b3',
        ],
      },
      vivid: {
        light: [
          '#0577b9', '#966704', '#058661', '#b33e86', '#007bad', '#b44f03',
          '#8254c5', '#777703',
        ],
        dark: [
          '#0b90de', '#b57d06', '#07a176', '#d2539f', '#0197c2', '#d86106',
          '#9b6ae4', '#8f8f0a',
        ],
      },
    }


    function colorForPart(part, palette, theme, index) {
      const slot = Number.isInteger(index) && index >= 0 ? index : 0
      const dbg = typeof window !== 'undefined' && window.__cadPaletteOverride
      if (Array.isArray(dbg) && dbg.length) return dbg[slot % dbg.length]
      const sets = PALETTES[palette] || PALETTES.muted
      const list = sets[theme] || sets.light
      return list[slot % list.length]
    }

    /** STEP/XCAF colours come from the CAD file — often pure white plastic.
     *  On a near-black canvas that glare reads as "wrong colour" no matter
     *  what the palette does, so dark mode pulls very light source colours
     *  down into the same lightness band as the palette, keeping the hue the
     *  file asked for instead of inventing a new one. */
    function sourceColor(part, theme) {
      if (!(part && part.color && part.color.length === 3)) return null
      const rgb = part.color.map((c) => Math.max(0, Math.min(1, c)))
      if (theme === 'dark') {
        const max = Math.max(rgb[0], rgb[1], rgb[2])
        if (max > 0.82) {
          const k = 0.66 / max
          return rgb.map((v) => v * k)
        }
      }
      return rgb
    }

    function paletteHex(part, palette, index, theme, override) {
      if (override) return override
      const src = sourceColor(part, theme)
      if (src) {
        return '#' + src.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
      }
      return colorForPart(part, palette, theme, index)
    }

    /** Current host theme, re-rendered when the shell flips appearance. */
    /** Native <select> popups are OS-drawn and stay white-on-white in dark
     *  mode, so the model switcher is a small custom listbox instead. */
    function pickerSkin(theme) {
      const dark = theme === 'dark'
      return {
        button: {
          background: dark ? 'rgba(255,255,255,.05)' : 'rgba(15,23,42,.04)',
          borderColor: dark ? 'rgba(255,255,255,.14)' : 'rgba(15,23,42,.14)',
          color: dark ? '#e6e8ea' : '#1f2430',
        },
        list: {
          background: dark ? '#202124' : '#ffffff',
          borderColor: dark ? 'rgba(255,255,255,.16)' : 'rgba(15,23,42,.12)',
          color: dark ? '#e6e8ea' : '#1f2430',
        },
        itemActive: {
          background: dark ? 'rgba(110,160,255,.22)' : 'rgba(38,110,230,.12)',
        },
      }
    }

    /** dsh-cad-style eye toggle: an outline eye when visible, struck through when hidden. */
    function EyeIcon({ on }) {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': 'true' }, [
        h('path', { key: 'eye', d: 'M1.6 8s2.5-4.6 6.4-4.6S14.4 8 14.4 8s-2.5 4.6-6.4 4.6S1.6 8 1.6 8Z' }),
        h('circle', { key: 'pupil', cx: 8, cy: 8, r: 2.1 }),
        on ? null : h('path', { key: 'slash', d: 'M2.4 13.6 13.6 2.4' }),
      ].filter(Boolean))
    }

    /** Rail glyphs — 15px so the 28px rail stays a strip, not a column. */
    function RailIcon({ name }) {
      const common = { width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }
      if (name === 'parts') {
        return h('svg', common, [
          h('path', { key: 'a', d: 'M8 1.6 13.7 4.9v6.2L8 14.4 2.3 11.1V4.9L8 1.6Z' }),
          h('path', { key: 'b', d: 'M2.3 4.9 8 8.1l5.7-3.2M8 8.1v6.3' }),
        ])
      }
      if (name === 'view') {
        // A camera: which angle am I looking from, and what gets drawn.
        return h('svg', common, [
          h('path', { key: 'body', d: 'M2.3 5.9h11.4a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H2.3a1 1 0 0 1-1-1V6.9a1 1 0 0 1 1-1Z' }),
          h('path', { key: 'bump', d: 'M5.5 5.9 6.5 4.2h3l1 1.7' }),
          h('circle', { key: 'lens', cx: 8, cy: 9.6, r: 2.2 }),
        ])
      }
      if (name === 'features') {
        // A ziggurat: the shape as a stack of machining steps.
        return h('svg', common, [
          h('path', { key: 'b1', d: 'M2.4 10.2h11.2v3.3H2.4z' }),
          h('path', { key: 'b2', d: 'M3.9 6.9h8.2v3.3H3.9z' }),
          h('path', { key: 'b3', d: 'M5.4 3.6h5.2v3.3H5.4z' }),
        ])
      }
      if (name === 'models') {
        return h('svg', common, [
          h('path', { key: 'a', d: 'M2.1 5.2c0-.6.3-.9.9-.9h3l1.3 1.4h5.7c.6 0 .9.3.9.9v5.1c0 .6-.3.9-.9.9H3c-.6 0-.9-.3-.9-.9V5.2Z' }),
          h('path', { key: 'b', d: 'M2.1 7.6h11.8' }),
        ])
      }
      if (name === 'props') {
        return h('svg', common, [
          h('path', { key: 'a', d: 'M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h10.8' }),
          h('circle', { key: 'b', cx: 5.6, cy: 4.2, r: 1.45, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'c', cx: 10.1, cy: 8, r: 1.45, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'd', cx: 6.9, cy: 11.8, r: 1.45, fill: 'currentColor', stroke: 'none' }),
        ])
      }
      if (name === 'motion') {
        // A revolute joint: rotation axis with a circular arrow around it.
        return h('svg', common, [
          h('path', { key: 'a', d: 'M8 3.2v9.6' }),
          h('path', { key: 'b', d: 'M8 5.1a2.9 2.9 0 1 1-2.8 3.6' }),
          h('path', { key: 'c', d: 'M5.3 8.6 4.2 8l-.2 1.5' }),
        ])
      }
      return h('svg', common, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 6 }),
        h('path', { key: 'd', d: 'M8 7.2v4.2' }),
        h('circle', { key: 'e', cx: 8, cy: 4.9, r: 0.75, fill: 'currentColor', stroke: 'none' }),
      ])
    }

    function ColorPopover({ theme, onPick, onReset, onApplyAll, copies, onClose }) {
      const skin = pickerSkin(theme)
      const rootRef = useRef(null)
      useEffect(() => {
        const onDocDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) onClose()
        }
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onDocDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDocDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [onClose])
      // The popover lives inside a tree row whose own onClick toggles the
      // instance, so every click in here must stop propagating.
      const row = (list) => h('div', { style: styles.colorRow }, list.map((hex) =>
        h('button', {
          key: hex,
          type: 'button',
          title: hex,
          'data-color': hex,
          style: { ...styles.colorCell, background: hex },
          onClick: (event) => { event.stopPropagation(); onPick(hex) },
        })))
      return h('div', {
        ref: rootRef,
        style: { ...styles.colorPop, ...skin.list },
        'data-cad-colors': '1',
        onClick: (event) => event.stopPropagation(),
      }, [
        row(PALETTES.muted[theme] || PALETTES.muted.light),
        row(PALETTES.vivid[theme] || PALETTES.vivid.light),
        copies > 1 && onApplyAll
          ? h('button', {
            key: 'all',
            type: 'button',
            style: { ...styles.colorAuto, ...skin.button },
            'data-cad-all': '1',
            onClick: (event) => { event.stopPropagation(); onApplyAll() },
          }, `该零件 ${copies} 个副本同色`)
          : null,
        h('button', {
          key: 'auto',
          type: 'button',
          style: { ...styles.colorAuto, ...skin.button },
          onClick: (event) => { event.stopPropagation(); onReset() },
        }, '自动配色'),
      ])
    }

    function useTheme() {
      const [theme, setTheme] = useState(() => resolveTheme())
      useEffect(() => subscribeTheme(() => setTheme(resolveTheme())), [])
      return theme
    }

    function buildGraph(THREE, payload, visibility, options, theme) {
      const paletteTheme = SCENE_THEMES[theme] || SCENE_THEMES.light
      const lighting = !options || options.lighting !== false
      const palette = (options && options.palette) || 'muted'
      const overrides = (options && options.overrides) || {}
      const scene = new THREE.Scene()
      // Same rig as dsh-cad (client/viewer3d.ts): hemisphere bounce + strong key
      // + soft fill. Light count/intensity is part of the look; matching it is
      // what makes a part read "machined" instead of "inflated".
      // Same rig as dsh-cad, but dark mode scales it down: at full intensity a
      // lit face against a near-black slab clips to white and reads as neon
      // (measured: our tank 183,227,197 vs dsh-cad's 171,115,116).
      const lightScale = paletteTheme.lightScale
      scene.add(new THREE.HemisphereLight(0xffffff, paletteTheme.hemisphereGround, 1.1 * lightScale))
      const key = new THREE.DirectionalLight(0xffffff, 1.6 * lightScale)
      key.position.set(0.7, -1.4, 0.8)
      scene.add(key)
      const fill = new THREE.DirectionalLight(0xffffff, 0.5 * lightScale)
      fill.position.set(-1, 0.4, -0.6)
      scene.add(fill)

      const geometries = []
      const materials = []
      const textures = []
      const instPart = new Map()
      const box = new THREE.Box3()
      const meshes = new Map()
      const edgesList = []
      const parts = new Map((payload.parts || []).map((p) => [p.id, p]))
      const partIndex = new Map((payload.parts || []).map((p, i) => [p.id, i]))
      let triangles = 0
      let volume = 0

      for (const inst of payload.instances || []) {
        const part = parts.get(inst.part)
        if (!part) continue
        // A part with no triangles (an empty tessellation, a degenerate STEP)
        // would build an indexed geometry with an empty index: three.js then
        // computes a NaN bounding sphere and every later frame/camera fit is
        // polluted. Skip it instead of drawing nothing but breaking the view.
        if (!part.tris || part.tris.length < 3) continue
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.verts, 3))
        if (part.tris && part.tris.length) geometry.setIndex(part.tris)
        geometry.computeVertexNormals()
        // Precedence: a colour the user picked in the tree > the model's own
        // colour > the palette slot.
        // Two levels: a colour picked on one row wins over one applied to the
        // whole part, which wins over the model's own colour and the palette.
        const override = (overrides.inst && overrides.inst[inst.name]) || (overrides.part && overrides.part[part.id])
        const src = sourceColor(part, theme)
        const color = override
          ? new THREE.Color(override)
          : src
            ? new THREE.Color(src[0], src[1], src[2])
            : new THREE.Color(colorForPart(part, palette, theme, partIndex.get(part.id)))
        // Unlit mode: flat fill, no shading gradient, which is what "关掉光影"
        // means for a CAD viewer that wants to read edges, not materials.
        const material = lighting
          ? new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55 })
          : new THREE.MeshBasicMaterial({ color })
        instPart.set(inst.name, part.id)
        const mesh = new THREE.Mesh(geometry, material)
        // Push faces a hair behind the contour lines so they are not z-fought.
        material.polygonOffset = true
        material.polygonOffsetFactor = 1
        material.polygonOffsetUnits = 1
        // Per-instance opacity (transparent parts must not write depth, or the
        // parts behind them disappear).
        if (options && options.wireframes && options.wireframes[inst.name]) material.wireframe = true
        const op0 = options && options.opacities ? options.opacities[inst.name] : undefined
        if (typeof op0 === 'number' && op0 < 0.999) {
          material.transparent = true
          material.opacity = Math.max(0.05, Math.min(1, op0))
          material.depthWrite = false
        }
        const r = inst.rot || [1, 0, 0, 0, 1, 0, 0, 0, 1]
        const t = inst.translate || [0, 0, 0]
        const group = new THREE.Group()
        group.matrixAutoUpdate = false
        group.matrix.set(r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2], 0, 0, 0, 1)
        group.matrixWorldNeedsUpdate = true
        group.name = inst.name || 'instance'
        group.visible = visibility[inst.name] !== false
        group.add(mesh)
        // Contour lines at creases: the same silhouette dsh-cad draws with its
        // structural-line mode, but with a fixed dihedral threshold so curved
        // faces stay clean instead of exploding into facet soup.
        const edgeGeometry = new THREE.EdgesGeometry(geometry, 22)
        const edgeMaterial = new THREE.LineBasicMaterial({ color: paletteTheme.edge, transparent: true, opacity: paletteTheme.edgeOpacity })
        const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial)
        edges.name = `${group.name}__edges`
        group.add(edges)
        scene.add(group)
        meshes.set(inst.name, group)
        edgesList.push(edges)
        geometries.push(geometry, edgeGeometry)
        materials.push(material, edgeMaterial)
        triangles += (part.tris || []).length / 3
        volume += part.volume || 0

        const verts = part.verts
        for (let i = 0; i < verts.length; i += 3) {
          const v = new THREE.Vector3(verts[i], verts[i + 1], verts[i + 2]).applyMatrix4(mesh.matrix)
          box.expandByPoint(v)
        }
      }

      if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))
      const size = box.getSize(new THREE.Vector3())

      // Floor grid on the XY plane (CAD is Z-up, so GridHelper's default XZ plane
      // has to be rotated 90° about X). Span is rounded up so the grid never ends
      // inside the model.
      const span = Math.max(size.x, size.y, 1)
      const step = Math.max(10, Math.pow(10, Math.floor(Math.log10(span))) / 2)
      const divisions = 20
      const gridSize = step * divisions
      const grid = new THREE.GridHelper(gridSize, divisions, paletteTheme.gridCenter, paletteTheme.gridLine)
      grid.rotation.x = Math.PI / 2
      // Centre the floor under the model instead of the world origin, so a part
      // modelled at x=800 does not sit off the edge of its own grid.
      grid.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z)
      grid.material.transparent = true
      grid.material.opacity = paletteTheme.gridOpacity
      grid.material.depthWrite = false
      grid.renderOrder = -1
      scene.add(grid)

      // Axis triad with X/Y/Z labels, mirroring dsh-cad's labelled furniture so
      // the viewport tells you which way is which without a view cube.
      const axisLen = Math.max(box.getSize(new THREE.Vector3()).length() * 0.22, 10)
      const axes = new THREE.Group()
      // Sit the triad just outside the model footprint: at the true origin it
      // would be buried inside any part that starts at (0,0,0).
      axes.position.set(box.min.x - step, box.min.y - step, box.min.z)
      const axisSpec = [
        [new THREE.Vector3(1, 0, 0), paletteTheme.axisX],
        [new THREE.Vector3(0, 1, 0), paletteTheme.axisY],
        [new THREE.Vector3(0, 0, 1), paletteTheme.axisZ],
      ]
      const labelFor = (text, colorHex) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 64
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return null
        ctx2d.fillStyle = '#' + colorHex.toString(16).padStart(6, '0')
        ctx2d.font = 'bold 44px system-ui, sans-serif'
        ctx2d.textAlign = 'center'
        ctx2d.textBaseline = 'middle'
        ctx2d.fillText(text, 32, 34)
        const texture = new THREE.CanvasTexture(canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
        const sprite = new THREE.Sprite(material)
        sprite.scale.setScalar(axisLen * 0.14)
        return { sprite, texture, material }
      }
      const axisNames = ['X', 'Y', 'Z']
      const axisLabels = []
      axisSpec.forEach(([dir, color], i) => {
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(axisLen)])
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }))
        line.renderOrder = 2
        axes.add(line)
        geometries.push(geometry)
        materials.push(line.material)
        const label = labelFor(axisNames[i], color)
        if (label) {
          label.sprite.position.copy(dir).multiplyScalar(axisLen * 1.18)
          label.sprite.renderOrder = 3
          axes.add(label.sprite)
          materials.push(label.material)
          textures.push(label.texture)
          // Clicking a label snaps to that axis' standard view (the ViewCube
          // convention, minus the cube: a 1/3-screen pane cannot spare the
          // corner a full cube needs).
          axisLabels.push({ sprite: label.sprite, axis: axisNames[i] })
        }
      })
      axes.renderOrder = 2
      scene.add(axes)
      const stats = {
        instances: meshes.size,
        parts: parts.size,
        triangles: Math.round(triangles),
        volume,
        size: [size.x, size.y, size.z],
      }
      // Test/debug hook: the graph exists even when WebGL cannot.
      if (typeof window !== 'undefined') {
        window.__cadStudioScene = stats
        window.__cadStudioTheme = theme
        window.__cadStudioAxes = axes ? axes.children.length : 0
        window.__cadStudioColors = [...meshes.values()].slice(0, 4).map((g) => g.children[0] && g.children[0].material && g.children[0].material.color.getHexString())
      }
      return { scene, meshes, instPart, edges: edgesList, grid, geometries, materials, textures, box, stats, axes, axisLabels }
    }

    /** Attach a renderer/camera/controls to a built graph. Throws when WebGL is unavailable. */
    function renderScene(THREE, host, payload, visibility, options, theme) {
      const sceneTheme = SCENE_THEMES[theme] || SCENE_THEMES.light
      const graph = buildGraph(THREE, payload, visibility, options, theme)
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      host.style.background = sceneTheme.canvas
      host.appendChild(renderer.domElement)
      renderer.domElement.style.display = 'block'
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'

      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20000)
      // CAD data is Z-up; three.js defaults to Y-up, which would lay models on their side.
      camera.up.set(0, 0, 1)
      const controls = new THREE.OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.12
      // A tab that is being restored already has a pose: start in "user moved"
      // mode so the first resize() does not re-frame the model over it.
      const restoreCam = options && options.restoreCamera ? options.restoreCamera : null
      let userMoved = Boolean(restoreCam)
      controls.addEventListener('start', () => { userMoved = true })

      // ── picking ──────────────────────────────────────────────────────────
      // Every real CAD viewer answers "what part is this?" by letting you click
      // the solid; the tree row then mirrors the choice. Same pointer-up serves
      // the axis labels (click X/Y/Z to snap that view), because OrbitControls
      // already owns the drag gesture.
      const selectionBox = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        new THREE.LineBasicMaterial({ color: sceneTheme.select, transparent: true, opacity: 0.95, depthTest: false }),
      )
      selectionBox.visible = false
      selectionBox.renderOrder = 6
      graph.scene.add(selectionBox)
      const raycaster = new THREE.Raycaster()
      const pointer = new THREE.Vector2()
      let downAt = null
      const AXIS_VIEW = { X: 'right', Y: 'front', Z: 'top' }

      const onPointerDown = (event) => {
        if (event.button === 0) downAt = { x: event.clientX, y: event.clientY }
      }
      const onPointerUp = (event) => {
        const start = downAt
        downAt = null
        if (!start || event.button !== 0) return
        // A drag is an orbit; only a near-stationary press counts as a pick.
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return
        const rect = renderer.domElement.getBoundingClientRect()
        if (!rect.width || !rect.height) return

        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(pointer, camera)

        // Axis labels are sprites, so the raycast hit area is exactly the drawn
        // glyph — no pixel guessing, and it keeps working when the camera moves.
        const labels = (graph.axisLabels || []).filter((entry) => entry.sprite.visible)
        if (labels.length) {
          const labelHit = raycaster.intersectObjects(labels.map((entry) => entry.sprite), false)[0]
          if (labelHit) {
            const entry = labels.find((item) => item.sprite === labelHit.object)
            if (entry && handle) handle.viewPreset(AXIS_VIEW[entry.axis] || 'iso')
            return
          }
        }

        const hits = raycaster.intersectObjects([...graph.meshes.values()].filter((g) => g.visible), true)
        const hit = hits.find((h) => h.object.isMesh)
        let name = ''
        if (hit) {
          let node = hit.object
          while (node && !graph.meshes.has(node.name)) node = node.parent
          if (node && node.name) name = node.name
        }
        if (handle) handle.setHighlight(name)
        if (options && typeof options.onPick === 'function') options.onPick(name)
      }
      renderer.domElement.addEventListener('pointerdown', onPointerDown)
      renderer.domElement.addEventListener('pointerup', onPointerUp)
      let handle = null

      let lastW = 0
      let lastH = 0
      const resize = () => {
        const w = Math.max(1, host.clientWidth)
        const hgt = Math.max(1, host.clientHeight)
        lastW = w
        lastH = hgt
        camera.aspect = w / hgt
        renderer.setSize(w, hgt, false)
        // Keep the default framing responsive to the pane size until the user
        // takes over the camera; after that respect their view.
        if (!userMoved) frameCamera(THREE, camera, controls, graph.box)
        camera.updateProjectionMatrix()
      }
      resize()
      if (restoreCam && restoreCam.p && restoreCam.t) {
        camera.up.set(restoreCam.u[0], restoreCam.u[1], restoreCam.u[2])
        controls.target.set(restoreCam.t[0], restoreCam.t[1], restoreCam.t[2])
        camera.position.set(restoreCam.p[0], restoreCam.p[1], restoreCam.p[2])
        camera.lookAt(controls.target)
        camera.updateProjectionMatrix()
        controls.update()
      }
      const observer = new ResizeObserver(resize)
      observer.observe(host)

      renderer.setAnimationLoop(() => {
        // A pane that gets its width after the first layout pass (flex split,
        // tab restore) would otherwise keep a stale aspect ratio and clip the
        // model at the right edge — follow the element every frame instead.
        if (host.clientWidth !== lastW || host.clientHeight !== lastH) resize()
        controls.update()
        renderer.render(graph.scene, camera)
      })

      if (typeof window !== 'undefined') {
        // Tabs keep their own camera: expose the exact pose so a test (or a bug
        // report) can prove a tab came back unchanged instead of eyeballing it.
        window.__cadStudioCamera = () => handle.cameraState()
      }

      handle = {
        /** Outline one instance ('' clears). Drives 3D → tree synchronisation. */
        setHighlight(name) {
          const group = name ? graph.meshes.get(name) : null
          if (!group) { selectionBox.visible = false; return }
          group.updateMatrixWorld(true)
          const bounds = new THREE.Box3().setFromObject(group)
          if (bounds.isEmpty()) { selectionBox.visible = false; return }
          const size = bounds.getSize(new THREE.Vector3())
          selectionBox.position.copy(bounds.getCenter(new THREE.Vector3()))
          selectionBox.scale.set(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3))
          selectionBox.visible = true
        },
        /** Recolour one instance without rebuilding the scene. */
        setInstanceColor(name, hex) {
          const group = graph.meshes.get(name)
          const mesh = group && group.children.find((child) => child.isMesh)
          if (mesh && mesh.material && mesh.material.color) mesh.material.color.set(hex)
        },
        /** Recolour every instance of one part without rebuilding the scene. */
        setPartColor(partId, hex) {
          for (const [name, group] of graph.meshes) {
            if (graph.instPart.get(name) !== partId) continue
            const mesh = group.children.find((child) => child.isMesh)
            if (mesh && mesh.material && mesh.material.color) mesh.material.color.set(hex)
          }
        },
        /** Camera pose, so a tab can be left and returned to unchanged. */
        cameraState() {
          return {
            p: camera.position.toArray(),
            t: controls.target.toArray(),
            u: camera.up.toArray(),
          }
        },
        setCameraState(state) {
          if (!state || !state.p || !state.t) return
          camera.up.set(state.u[0], state.u[1], state.u[2])
          controls.target.set(state.t[0], state.t[1], state.t[2])
          camera.position.set(state.p[0], state.p[1], state.p[2])
          camera.lookAt(controls.target)
          camera.updateProjectionMatrix()
          controls.update()
          userMoved = true
        },
        /** Re-frame the model (the pane can be resized to a sliver). */
        fit() {
          frameCamera(THREE, camera, controls, graph.box)
          camera.updateProjectionMatrix()
          controls.update()
        },
        /** Snap to a standard view: iso | front | top | right. */
        viewPreset(name) {
          const dirs = {
            iso: [0.62, -0.78, 0.52],
            front: [0, -1, 0.0001],
            top: [0, 0.0001, 1],
            right: [1, 0.0001, 0],
          }
          const d = dirs[name] || dirs.iso
          const center = graph.box.getCenter(new THREE.Vector3())
          const forward = new THREE.Vector3(d[0], d[1], d[2]).normalize().negate()
          const upSeed = name === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
          const right = new THREE.Vector3().crossVectors(forward, upSeed).normalize()
          const upAxis = new THREE.Vector3().crossVectors(right, forward).normalize()
          const vHalf = ((camera.fov * Math.PI) / 180) / 2
          // Take the aspect from the element, not from camera.aspect: a pane that
          // was resized in the same frame would otherwise fit to a stale ratio
          // and clip the model at both side walls.
          const hostW = Math.max(1, host.clientWidth)
          const hostH = Math.max(1, host.clientHeight)
          const hHalf = Math.atan(Math.tan(vHalf) * (hostW / hostH))
          // Fit the box's projected extent, not its bounding sphere: a long flat
          // tank in top view would otherwise sit tiny in a huge empty margin.
          let dist = 0
          const corner = new THREE.Vector3()
          for (let i = 0; i < 8; i += 1) {
            corner.set(
              i & 1 ? graph.box.max.x : graph.box.min.x,
              i & 2 ? graph.box.max.y : graph.box.min.y,
              i & 4 ? graph.box.max.z : graph.box.min.z,
            ).sub(center)
            const along = corner.dot(forward)
            dist = Math.max(
              dist,
              Math.abs(corner.dot(right)) / Math.tan(hHalf) - along,
              Math.abs(corner.dot(upAxis)) / Math.tan(vHalf) - along,
            )
          }
          // 12% breathing room: a flush-to-edge model reads as cropped.
          dist = Math.max(dist, 1e-3) * 1.12
          // A camera looking straight down would be ambiguous with up=+Z, so
          // switch the up vector for the axis-aligned presets.
          camera.up.copy(upAxis)
          // Re-centre on the model: a stale orbit target (from a previous scene)
          // would leave a top view off-axis and strongly perspective-skewed.
          controls.target.copy(center)
          const v = new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(dist)
          camera.position.copy(controls.target).add(v)
          camera.lookAt(controls.target)
          camera.updateProjectionMatrix()
          controls.update()
          userMoved = true
        },
        setInstanceOpacity(name, value) {
          const group = graph.meshes.get(name)
          if (!group) return
          const op = Math.max(0.05, Math.min(1, typeof value === 'number' ? value : 1))
          group.traverse((node) => {
            if (!node.isMesh || !node.material) return
            node.material.transparent = op < 0.999
            node.material.opacity = op
            node.material.depthWrite = op >= 0.999
            node.material.needsUpdate = true
          })
        },
        setInstanceWireframe(name, on) {
          const group = graph.meshes.get(name)
          if (!group) return
          group.traverse((node) => {
            if (!node.isMesh || !node.material) return
            node.material.wireframe = !!on
            node.material.needsUpdate = true
          })
        },
        setVisible(name, visible) {
          const group = graph.meshes.get(name)
          if (group) group.visible = visible
        },
        setGrid(visible) {
          if (graph.grid) graph.grid.visible = visible
        },
        setEdges(visible) {
          for (const e of graph.edges) e.visible = visible
        },
        dispose() {
          observer.disconnect()
          renderer.domElement.removeEventListener('pointerdown', onPointerDown)
          renderer.domElement.removeEventListener('pointerup', onPointerUp)
          selectionBox.geometry.dispose()
          selectionBox.material.dispose()
          renderer.setAnimationLoop(null)
          controls.dispose()
          for (const g of graph.geometries) g.dispose()
          for (const m of graph.materials) m.dispose()
          for (const t of graph.textures || []) t.dispose()
          // A plain dispose() leaves the WebGL context alive until GC, and
          // Chrome caps the live contexts (~16) — after enough theme/palette
          // rebuilds the whole renderer process dies with "Target crashed".
          // Release the context deterministically instead.
          try {
            renderer.forceContextLoss()
          } catch {}
          renderer.dispose()
          renderer.domElement.remove()
        },
      }
      // Test/debug hook (same spirit as __cadStudioColors): where the axis
      // labels currently sit, in page coordinates — the only way to click them
      // from an automated run without guessing pixels.
      if (typeof window !== 'undefined') {
        window.__cadStudioAxisScreen = () => (graph.axisLabels || []).map((entry) => {
          const r = renderer.domElement.getBoundingClientRect()
          const v = entry.sprite.getWorldPosition(new THREE.Vector3()).project(camera)
          return { axis: entry.axis, x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
        })
      }
      return handle
    }

    let glBlocked = false
    // The live tab follows the modelling this panel's own session did. The host
    // stamps every publish with the session id of the tool call that made it;
    // the client learns its id from the session store as soon as it appears.
    let panelSession = ''
    /** Host config: 'session' | 'always' | 'off' — see index.js DEFAULTS.autoOpen. */
    let cadAutoOpen = 'session'
    /** Memo for "does this session own CAD work", keyed by session id. */

    function Viewport({ payload, visibility, options, handleRef: externalHandle }) {
      const hostRef = useRef(null)
      const [error, setError] = useState(glBlocked ? 'WebGL 上下文不可用' : '')
      const theme = useTheme()
      const localHandle = useRef(null)
      const handleRef = externalHandle || localHandle

      useEffect(() => {
        let alive = true
        if (!payload) return () => {}
        ;(async () => {
          try {
            const THREE = await loadThree()
            if (!alive || !hostRef.current) return
            if (handleRef.current) handleRef.current.dispose()
            handleRef.current = renderScene(THREE, hostRef.current, payload, visibility, options, theme)
            handleRef.current.setGrid(!options || options.grid !== false)
            handleRef.current.setEdges(!options || options.edges !== false)
            setError('')
          } catch (err) {
            const msg = String((err && err.message) || err)
            if (/WebGL/i.test(msg)) glBlocked = true
            if (alive) setError(msg)
          }
        })()
        return () => {
          alive = false
          if (handleRef.current) {
            handleRef.current.dispose()
            handleRef.current = null
          }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [payload, options && options.lighting, options && options.palette, options && options.overrides, theme])

      useEffect(() => {
        const handle = handleRef.current
        if (!handle) return
        for (const name of Object.keys(visibility)) handle.setVisible(name, visibility[name] !== false)
      }, [visibility])

      useEffect(() => {
        const handle = handleRef.current
        if (!handle) return
        const ops = (options && options.opacities) || {}
        for (const name of Object.keys(ops)) handle.setInstanceOpacity(name, ops[name])
      }, [options && options.opacities])

      useEffect(() => {
        const handle = handleRef.current
        if (!handle) return
        const wf = (options && options.wireframes) || {}
        for (const name of Object.keys(wf)) handle.setInstanceWireframe(name, wf[name])
      }, [options && options.wireframes])

      useEffect(() => {
        const handle = handleRef.current
        if (!handle) return
        handle.setGrid(!options || options.grid !== false)
        handle.setEdges(!options || options.edges !== false)
      }, [options])

      if (error) {
        return h('div', { style: styles.warn }, [
          h('div', { key: 'a', style: { fontWeight: 600, marginBottom: 4 } }, '3D 视口不可用'),
          h('div', { key: 'b' }, '浏览器没能创建 WebGL 上下文（本机 GPU 被禁用或驱动不可用）。几何数据仍然有效，可用下方的实例树与尺寸信息核对。'),
          h('div', { key: 'c', style: { ...styles.mono, marginTop: 6, opacity: 0.7 } }, error),
        ])
      }
      return h('div', { ref: hostRef, style: styles.canvasHost })
    }


    // better-sidebar matches on the extension WITHOUT the dot (see its builtin
    // viewers: ['md','markdown']), so a dot-prefixed list would never match.
    /** mm³ → a unit a human reads without counting zeros (1 L = 1e6 mm³). */
function formatVolume(mm3) {
  const v = Number(mm3) || 0
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} L`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} cm³`
  return `${v.toFixed(0)} mm³`
}

// Must match the host's SUPPORTED_FILE_EXTS: FreeCAD only reads STEP/IGES/BREP/STL.
const FILE_EXTS = ['step', 'stp', 'iges', 'igs', 'brep', 'stl']

    /**
     * Sidebar file viewer: asks the Host to open the clicked path, then renders
     * the published scene in place (the browser cannot read local files).
     */
    /** Compact "视图 + 显示" menu shared by the panel and the file viewer:
     *  a 1/3-screen pane cannot afford a row of chips. */
    function ViewMenu({ theme, display, setDisplay, handleRef, onClose, inline }) {
      const skin = pickerSkin(theme)
      return h('div', {
        style: inline ? { ...styles.menuInline, ...skin.list } : { ...styles.menu, ...skin.list },
        'data-cad-menu': '1',
        onClick: (event) => event.stopPropagation(),
      }, [
        h('div', { key: 'l1', style: styles.menuLabel }, '视图'),
        h('div', { key: 'r1', style: styles.menuRow }, [
          ...['iso', 'front', 'top', 'right'].map((name) => h('button', {
            key: name,
            type: 'button',
            style: styles.headBtn,
            'data-cad-view': name,
            onClick: () => { if (handleRef.current) handleRef.current.viewPreset(name); onClose() },
          }, { iso: '等轴', front: '前', top: '上', right: '右' }[name])),
          h('button', {
            key: 'fit',
            type: 'button',
            style: styles.headBtn,
            'data-cad-fit': '1',
            onClick: () => { if (handleRef.current) handleRef.current.fit(); onClose() },
          }, '重新取景'),
        ]),
        h('div', { key: 'l2', style: styles.menuLabel }, '显示'),
        h('div', { key: 'r2', style: styles.menuRow }, [
          h('button', { key: 'grid', type: 'button', style: styles.toggleChip(display.grid), onClick: () => setDisplay((d) => ({ ...d, grid: !d.grid })) }, '网格'),
          h('button', { key: 'edges', type: 'button', style: styles.toggleChip(display.edges), onClick: () => setDisplay((d) => ({ ...d, edges: !d.edges })) }, '轮廓'),
          h('button', { key: 'light', type: 'button', style: styles.toggleChip(display.lighting), onClick: () => setDisplay((d) => ({ ...d, lighting: !d.lighting })) }, '光影'),
          h('button', {
            key: 'pal',
            type: 'button',
            style: styles.toggleChip(display.palette === 'vivid'),
            onClick: () => setDisplay((d) => ({ ...d, palette: d.palette === 'vivid' ? 'muted' : 'vivid' })),
          }, display.palette === 'vivid' ? '鲜艳' : '朴素'),
        ]),
      ])
    }

    function CadFileView({ path }) {
      const viewportRef = useRef(null)
      const theme = useTheme()
      const [payload, setPayload] = useState(null)
      const [error, setError] = useState('')
      const [visibility, setVisibility] = useState({})
      const [display, setDisplay] = useState({ grid: true, edges: true, lighting: true, palette: 'muted' })
      const [treeOpen, setTreeOpen] = useState(false)
      const menuRef = useRef(null)
      const [menuOpen, setMenuOpen] = useState(false)

      useEffect(() => {
        let alive = true
        setPayload(null)
        setError('')
        const run = async () => {
          const res = await fetch(`${ROUTE}/open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ path }),
          })
          const data = await res.json().catch(() => ({}))
          if (!alive) return
          if (!res.ok || data.ok === false) {
            setError(String(data.error || data.stderr || `打开失败（HTTP ${res.status}）`))
            return
          }
          if (!data.sceneId) { setError('没有场景返回'); return }
          const sceneRes = await fetch(`${ROUTE}/scene/${encodeURIComponent(data.sceneId)}`, { headers: { accept: 'application/json' } })
          const scene = await sceneRes.json().catch(() => null)
          if (!alive) return
          if (!scene || !scene.parts) { setError('场景读取失败'); return }
          setPayload(scene)
        }
        run().catch((err) => { if (alive) setError(String((err && err.message) || err)) })
        return () => { alive = false }
      }, [path])

      const stats = useMemo(() => {
        if (!payload) return ''
        const tris = (payload.parts || []).reduce((sum, p) => sum + ((p.tris || []).length / 3) * (payload.instances || []).filter((i) => i.part === p.id).length, 0)
        return `${new Set((payload.instances || []).map((i) => i.part)).size} 种零件 · ${Math.round(tris)} 三角形`
      }, [payload])

      return h('div', { style: styles.root }, [
        h('div', { key: 'head', style: styles.head }, [
          h('span', { key: 't', style: { ...styles.title, flex: '1 1 auto' } }, String(path).split('/').pop()),
          h('button', {
            key: 'menu',
            type: 'button',
            style: styles.headBtn,
            'data-cad-menu-toggle': '1',
            title: '视图与显示',
            onClick: () => setMenuOpen((v) => !v),
          }, '⋯'),
        ]),
        error ? h('div', { key: 'err', style: styles.warn }, error) : null,
        h('div', { key: 'body', style: { display: 'flex', flex: 1, minHeight: 0, position: 'relative' } }, [
          h('div', { key: 'stage', style: styles.stage }, payload
            ? h(Viewport, { payload, visibility, options: display, handleRef: viewportRef })
            : h('div', { style: styles.empty }, '正在用 freecadcmd 读取模型…')),
          h('span', { key: 'st', style: styles.stats }, stats || ''),
          menuOpen ? h('div', {
            key: 'mwrap',
            ref: menuRef,
          }, h(ViewMenu, { theme, display, setDisplay, handleRef: viewportRef, onClose: () => setMenuOpen(false) })) : null,
        ]),
      ])
    }

    /** XCAF transfer leaves "Open CASCADE STEP translator 7.7" on unnamed solids;
     *  a tree of three identical rows is useless, so fall back to the part id. */
    function displayName(name, partId) {
      return /^open cascade step translator/i.test(String(name || '')) ? `未命名零件 ${partId}` : String(name || '')
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [scenes, setScenes] = useState([])
      // Two kinds of view, deliberately not coupled: `activity` follows the
      // modelling this session does (it is replaced whenever something new is
      // published), while every opened model is its own tab that new publishes
      // never move. Tabs are capped: each one is a full scene payload plus its
      // own camera and per-part look, and a 1/3-screen pane cannot show more
      // than a handful of those readably anyway.
      const MAX_TABS = 5
      const [openTabs, setOpenTabs] = useState([])
      const [activeKey, setActiveKey] = useState('activity')
      const activeRef = useRef('activity')
      const openTabsRef = useRef([])
      const [activity, setActivity] = useState(null)
      const activityRef = useRef(null)
      const [fresh, setFresh] = useState(false)
      const seenRef = useRef('')
      // "+" owns its own dropdown (it is anchored to the button); the rail's
      // folder opens the models panel, where a click switches the model shown
      // by the current view instead of opening another tab.
      const [addOpen, setAddOpen] = useState(false)
      const [addAlign, setAddAlign] = useState('left')
      const addBtnRef = useRef(null)
      const [activityPin, setActivityPin] = useState(null)
      const activityPinRef = useRef(null)
      const [picked, setPicked] = useState('')
      const revealedRef = useRef('')
      const [payload, setPayload] = useState(null)
      const [visibility, setVisibility] = useState({})
      const [error, setError] = useState('')
      const [installing, setInstalling] = useState('')
      // The visible scene, and the identity the per-scene view state is keyed
      // on: republishing one assembly (drive / explode) keeps its colours,
      // switching to another scene does not.
      const visibleId = (payload && payload.__id) || ''
      const sceneKey = (payload && payload.assembly && payload.assembly.id) || visibleId

      const loadScene = async (id) => {
        if (!id) return null
        const res = await fetch(`${ROUTE}/scene/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
        if (!res.ok) return null
        const scene = await res.json()
        scene.__id = id
        return scene
      }

      // Per-scene view memory: colours, hidden rows, opacity, wireframe and the
      // camera, keyed by the scene's identity. Flipping tabs therefore returns
      // you to the view you left, instead of re-framing the model every time.
      const viewByKey = useRef(new Map())
      const sceneKeyRef = useRef('')
      const payloadRef = useRef(null)
      const pendingCameraRef = useRef(null)
      const tabSeqRef = useRef(0)
      const keyOf = (scene) => (scene && ((scene.assembly && scene.assembly.id) || scene.__id)) || ''
      // Each tab owns its look and camera. Model tabs are keyed by the tab, so
      // the same model may be open twice with two independent viewpoints; the
      // live tab is keyed by the scene, so a new build starts from a clean look.
      const memKey = (tabKey, scene) => (tabKey === 'activity' ? `a:${keyOf(scene)}` : tabKey)

      const rememberView = (tabKey, scene) => {
        const key = memKey(tabKey || activeRef.current, scene || payloadRef.current)
        if (!key || key === 'a:') return
        const camera = viewportRef.current && viewportRef.current.cameraState
          ? viewportRef.current.cameraState()
          : null
        viewByKey.current.set(key, { ...lookRef.current, camera })
      }

      const resetLook = (scene, tabKey) => {
        const saved = viewByKey.current.get(memKey(tabKey || activeRef.current, scene))
        if (saved) {
          setVisibility(saved.visibility || {})
          setOverrides(saved.overrides || { inst: {}, part: {} })
          setOpacities(saved.opacities || {})
          setWireframes(saved.wireframes || {})
          pendingCameraRef.current = saved.camera || null
          return
        }
        const nextVisibility = {}
        for (const inst of scene.instances || []) nextVisibility[inst.name] = true
        setVisibility(nextVisibility)
        setOverrides({ inst: {}, part: {} })
        setOpacities({})
        setWireframes({})
        pendingCameraRef.current = null
      }

      const showScene = (scene, { keepView = false, tabKey } = {}) => {
        setPayload(scene)
        if (!keepView) {
          resetLook(scene, tabKey)
          setPicked('')
        }
      }

      const showActivity = async (id) => {
        const scene = await loadScene(id)
        if (!scene) return
        rememberView('activity', payloadRef.current)
        showScene(scene, { tabKey: 'activity' })
      }

      /**
       * Every pick opens its OWN tab — even for a model that is already open,
       * because two tabs on one model are two independent viewpoints (that is
       * what the "+" is for). At MAX_TABS the oldest tab is pushed out.
       */
      const openModel = async (id) => {
        const scene = await loadScene(id)
        if (!scene) return
        const meta = scenes.find((sc) => sc.id === id) || { id, title: scene.title || id }
        const base = meta.title || scene.title || id
        rememberView(activeRef.current, payloadRef.current)
        tabSeqRef.current += 1
        const tabKey = `t${tabSeqRef.current}`
        const dup = openTabsRef.current.filter((t) => t.id === id).length
        const title = dup ? `${base} · ${dup + 1}` : base
        const all = [...openTabsRef.current, { key: tabKey, id, title }]
        // At the cap the oldest tab is pushed out — drop its remembered look
        // too, otherwise the map grows with tabs nobody can reach any more.
        for (const gone of all.slice(0, Math.max(0, all.length - MAX_TABS))) viewByKey.current.delete(gone.key)
        openTabsRef.current = all.slice(-MAX_TABS)
        setOpenTabs(openTabsRef.current)
        activeRef.current = tabKey
        setActiveKey(tabKey)
        setFresh(false)
        showScene(scene, { tabKey })
      }

      /**
       * The folder's click: change what the current view shows, in place.
       * A focused model tab is retargeted to the picked model (same tab, no
       * new one); on the live tab the pick is pinned there until the session
       * publishes something new, at which point the live view takes over
       * again.
       */
      const switchModel = async (id) => {
        if (!id) return
        const scene = await loadScene(id)
        if (!scene) return
        const meta = scenes.find((sc) => sc.id === id) || { id, title: scene.title || id }
        const title = shortName(meta) || id
        rememberView(activeRef.current, payloadRef.current)
        const tab = openTabsRef.current.find((t) => t.key === activeRef.current)
        if (tab) {
          const next = openTabsRef.current.map((t) => (t.key === tab.key ? { ...t, id, title } : t))
          openTabsRef.current = next
          setOpenTabs(next)
          showScene(scene, { tabKey: tab.key })
          return
        }
        const pin = { id, title }
        activityPinRef.current = pin
        setActivityPin(pin)
        setFresh(false)
        showScene(scene, { tabKey: 'activity' })
      }

      const focusTab = async (key) => {
        if (key === activeRef.current) return
        rememberView(activeRef.current, payloadRef.current)
        activeRef.current = key
        setActiveKey(key)
        setFresh(false)
        if (key === 'activity') {
          if (activityRef.current) await showActivity(activityRef.current.id)
          return
        }
        const tab = openTabsRef.current.find((t) => t.key === key)
        if (!tab) return
        const scene = await loadScene(tab.id)
        if (scene) showScene(scene, { tabKey: key })
      }

      const closeTab = async (key) => {
        const rest = openTabsRef.current.filter((t) => t.key !== key)
        viewByKey.current.delete(key)
        openTabsRef.current = rest
        setOpenTabs(rest)
        if (activeRef.current !== key) return
        const last = rest.length ? rest[rest.length - 1] : null
        activeRef.current = last ? last.key : 'activity'
        setActiveKey(activeRef.current)
        setFresh(false)
        if (!last) {
          if (activityRef.current) await showActivity(activityRef.current.id)
          return
        }
        const scene = await loadScene(last.id)
        if (scene) showScene(scene, { tabKey: last.key })
      }

      /** Point the focused tab at the republished scene, keeping its tab key. */
      const retargetTab = (tabKey, toId, title) => {
        const i = openTabsRef.current.findIndex((t) => t.key === tabKey)
        if (i < 0) return
        const next = openTabsRef.current.slice()
        next[i] = { ...next[i], id: toId, title: title || next[i].title }
        openTabsRef.current = next
        setOpenTabs(next)
      }

      // The camera can only be restored once the new scene's renderer exists,
      // and child effects run before the parent's — so this fires after it.
      useEffect(() => {
        sceneKeyRef.current = sceneKey
        const cam = pendingCameraRef.current
        if (!cam) return
        pendingCameraRef.current = null
        if (viewportRef.current && viewportRef.current.setCameraState) {
          viewportRef.current.setCameraState(cam)
        }
      }, [payload])

      // The "+" dropdown is a transient popover: Esc or a click anywhere else
      // dismisses it (the folder panel behind it is the one that stays put).
      useEffect(() => {
        if (!addOpen) return undefined
        const onDown = (event) => {
          const el = event.target
          if (!el || typeof el.closest !== 'function') return
          if (el.closest('[data-cad-addmenu]') || el.closest('[data-cad-tab-add]')) return
          setAddOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setAddOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [addOpen])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const res = await fetch(`${ROUTE}/state`, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error(`state HTTP ${res.status}`)
            const next = await res.json()
            if (!alive) return
            // The host owns the policy; the panel only obeys it.
            if (next && next.config && ['session', 'always', 'off'].includes(next.config.autoOpen)) {
              cadAutoOpen = next.config.autoOpen
            }
            setState(next)
            setError('')
            let history = []
            try {
              const listRes = await fetch(`${ROUTE}/scenes`, { headers: { accept: 'application/json' } })
              if (listRes.ok) {
                const list = await listRes.json()
                history = list.scenes || []
                if (alive) setScenes(history)
              }
            } catch {}
            // The live view belongs to this session: prefer its newest publish
            // and only fall back to the process-wide newest when the session id
            // is not knowable here.
            const mine = panelSession ? history.find((h) => h.session === panelSession) : null
            const act = mine || next.latest || null
            const actId = act ? act.id : ''
            if (actId && actId !== ((activityRef.current && activityRef.current.id) || '')) {
              activityRef.current = act
              setActivity(act)
            }
            if (!actId) return
            // A model updates in place: same scene id, new timestamp. Watch the
            // pair so driving a joint refreshes the viewport instead of being
            // mistaken for "nothing changed".
            const stamp = `${actId}@${(act && act.at) || ''}`
            // Something new was published by this session: the pinned model on
            // the live tab goes back to following the session.
            if (activityPinRef.current && activityPinRef.current.id !== actId) {
              activityPinRef.current = null
              setActivityPin(null)
            }
            if (stamp !== seenRef.current) {
              const had = Boolean(seenRef.current)
              seenRef.current = stamp
              const focused = openTabsRef.current.find((t) => t.key === activeRef.current)
              const showsIt = activeRef.current === 'activity' || (focused && focused.id === actId)
              if (showsIt) {
                const tabKey = activeRef.current
                const scene = await loadScene(actId)
                if (scene && alive && activeRef.current === tabKey) {
                  rememberView(tabKey, payloadRef.current)
                  showScene(scene, { tabKey })
                }
              } else if (had) {
                setFresh(true) // a model tab is focused: flag that activity moved on
              }
            }
          } catch (err) {
            const msg = String((err && err.message) || err)
            if (/WebGL/i.test(msg)) glBlocked = true
            if (alive) setError(msg)
          }
        }
        tick()
        const timer = setInterval(tick, 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const runtime = (state && state.runtime) || {}
      const setup = (state && state.setup) || {}
      const stats = useMemo(() => {
        if (!payload) return ''
        const parts = new Map((payload.parts || []).map((p) => [p.id, p]))
      const partIndex = new Map((payload.parts || []).map((p, i) => [p.id, i]))
        let tris = 0
        let volume = 0
        for (const inst of payload.instances || []) {
          const part = parts.get(inst.part)
          if (!part) continue
          tris += (part.tris || []).length / 3
          volume += part.volume || 0
        }
        return `${(payload.instances || []).length} 个实例 / ${parts.size} 种零件 · ${Math.round(tris).toLocaleString()} 三角形 · ${formatVolume(volume)}`
      }, [payload])

      const toggle = (name) => setVisibility((prev) => ({ ...prev, [name]: !(prev[name] !== false) }))
      const [display, setDisplay] = useState({ grid: true, edges: true, lighting: true, palette: 'muted' })
      // One floating panel at a time, opened from the rail: 'parts' | 'view' |
      // 'models' | 'info' | '' (closed). Same icon again closes it.
      const [panel, setPanel] = useState('')
      const theme = useTheme()
      // Colour overrides picked by hand in the tree. Two levels, because an
      // assembly can show one part many times: `inst` is one row, `part` is
      // every copy of that part.
      const [overrides, setOverrides] = useState({ inst: {}, part: {} })
      const [colorFor, setColorFor] = useState(null)
      // Per-instance opacity and the inspector's own colour popover. Both sit
      // here rather than in the parts list because they belong to "the one row
      // I selected", not to the whole assembly.
      const [opacities, setOpacities] = useState({})
      const [wireframes, setWireframes] = useState({})

      // Async callbacks (the 1.5 s poller) close over the render they were
      // created in, so the live look has to be read from a ref, not from state.
      // Declared after the states it mirrors: reading them earlier would put
      // `overrides` in its temporal dead zone during the first render.
      const visibleIdRef = useRef('')
      const lookRef = useRef({ visibility: {}, overrides: { inst: {}, part: {} }, opacities: {}, wireframes: {} })
      useEffect(() => { visibleIdRef.current = visibleId }, [visibleId])
      useEffect(() => {
        lookRef.current = { visibility, overrides, opacities, wireframes }
      }, [visibility, overrides, opacities, wireframes])
      useEffect(() => { payloadRef.current = payload }, [payload])
      const [propColorOpen, setPropColorOpen] = useState(false)
      // Motion panel: the slider value being dragged (the scene lags one POST),
      // plus the explode factor. Both fall back to the payload's own values.
      const [motionDraft, setMotionDraft] = useState({})
      const [explodeDraft, setExplodeDraft] = useState(null)
      // Feature editing: per-field drafts (so typing does not fight the rebuild)
      // and a coalescing timer, mirroring the joint sliders.
      const [featDraft, setFeatDraft] = useState({})
      const [featAdd, setFeatAdd] = useState(false)
      const [featError, setFeatError] = useState('')
      const featTimer = useRef(null)
      const dragRef = useRef({ timer: 0, pending: null })
      const viewportRef = useRef(null)

      const instancesOf = (partId) => (payload.instances || []).filter((i) => i.part === partId)
      const pickColor = (instName, hex) => {
        setOverrides((prev) => ({ ...prev, inst: { ...prev.inst, [instName]: hex } }))
        if (viewportRef.current) viewportRef.current.setInstanceColor(instName, hex)
        setColorFor(null)
      }
      // "All copies of this part": one colour for every row sharing the part.
      // Instance overrides for those rows are dropped so the part colour shows.
      const applyToCopies = (partId, hex) => {
        const names = instancesOf(partId).map((i) => i.name)
        setOverrides((prev) => {
          const inst = { ...prev.inst }
          for (const name of names) delete inst[name]
          return { inst, part: { ...prev.part, [partId]: hex } }
        })
        if (viewportRef.current) viewportRef.current.setPartColor(partId, hex)
        setColorFor(null)
      }
      const resetColor = (partId) => {
        setOverrides((prev) => {
          const inst = { ...prev.inst }
          const part = { ...prev.part }
          delete inst[colorFor]
          delete part[partId]
          return { inst, part }
        })
        setColorFor(null)
      }


      // ---- motion: joint sliders + exploded view ---------------------------
      // The scene payload carries its own assembly block, so the panel never
      // guesses which joints belong to what it is looking at.
      const assembly = payload && payload.assembly ? payload.assembly : null
      const applyScene = async (id, at) => {
        const scene = await loadScene(id)
        if (!scene) return
        if (at) seenRef.current = `${id}@${at}`
        // Driving a joint or the explode slider is an action the user took on
        // the model they are looking at, so that tab follows the republished
        // scene; the live tab keeps following the session instead.
        const tabKey = activeRef.current
        if (tabKey !== 'activity') {
          const title = scene.title || (openTabsRef.current.find((t) => t.key === tabKey) || {}).title || id
          retargetTab(tabKey, id, title)
        } else {
          activityRef.current = { id, title: scene.title || id }
          setActivity(activityRef.current)
        }
        rememberView(tabKey, payloadRef.current)
        showScene(scene, { keepView: true, tabKey })
      }
      const postMotion = async (path, body) => {
        try {
          const res = await fetch(`${ROUTE}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!res.ok) return null
          const out = await res.json()
          if (out && out.sceneId) await applyScene(out.sceneId, out.at)
          return out
        } catch { return null }
      }
      // A range input fires per pixel: coalesce to one request per ~70 ms so a
      // drag stays smooth instead of queueing a republish per frame.
      const queueMotion = (pending) => {
        dragRef.current.pending = pending
        if (dragRef.current.timer) clearTimeout(dragRef.current.timer)
        dragRef.current.timer = setTimeout(() => {
          const next = dragRef.current.pending
          if (!next || !assembly) return
          if (next.explode !== undefined) postMotion('/explode', { assembly: assembly.id, factor: next.explode })
          else postMotion('/drive', { assembly: assembly.id, joint: next.joint, value: next.value })
        }, 70)
      }
      useEffect(() => () => { if (dragRef.current.timer) clearTimeout(dragRef.current.timer) }, [])
      const driveJoint = (jointId, value) => {
        setMotionDraft((prev) => ({ ...prev, [jointId]: value }))
        queueMotion({ joint: jointId, value })
      }
      const dragExplode = (factor) => {
        setExplodeDraft(factor)
        queueMotion({ explode: factor })
      }
      const jointLabel = { ...styles.propLabel, width: 62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      const motionBody = !assembly
        ? [h('div', { key: 'none', style: styles.propEmpty }, '这个场景没有关节。用 cad_studio_assembly 建装配时给 joints，就能在这里拖滑杆看运动。')]
        : [
          h('div', { key: 'h', style: styles.treeHint }, `${assembly.title || ''} · ${(assembly.joints || []).length} 关节`),
          ...(assembly.joints || []).map((joint) => {
            const value = motionDraft[joint.id] !== undefined ? motionDraft[joint.id] : joint.value
            const unit = joint.type === 'linear' ? ' mm' : '°'
            const clamp = (raw) => Math.max(joint.min, Math.min(joint.max, Math.round(raw)))
            return h('div', { key: joint.id, 'data-cad-joint': joint.id }, [
              h('div', { key: 'r', style: styles.propRow }, [
                h('span', { key: 'l', style: jointLabel, title: `${joint.id} · ${joint.instance}` }, joint.instance),
                h('span', { key: 'v', style: styles.propValue, 'data-cad-joint-value': joint.id }, `${Math.round(value * 10) / 10}${unit}`),
                // Typing beats dragging for exact values: 180° across this narrow
                // slider makes a hand-hit 0° almost impossible.
                h('input', {
                  key: 'n',
                  type: 'number',
                  style: styles.jointNum,
                  'data-cad-joint-input': joint.id,
                  min: joint.min,
                  max: joint.max,
                  step: 1,
                  value: String(Math.round(value * 10) / 10),
                  title: '输入数值后回车',
                  onChange: (event) => {
                    const next = Number(event.target.value)
                    if (Number.isFinite(next)) driveJoint(joint.id, clamp(next))
                  },
                  onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
                }),
                h('button', {
                  key: 'z',
                  type: 'button',
                  style: styles.microBtn,
                  'data-cad-joint-zero': joint.id,
                  title: `把 ${joint.id} 设回 0`,
                  onClick: () => driveJoint(joint.id, 0),
                }, '归零'),
              ]),
              h('div', { key: 's', style: styles.sliderRow }, [
                h('input', {
                  key: 'sl',
                  type: 'range',
                  style: styles.slider,
                  'data-cad-joint-slider': joint.id,
                  min: joint.min,
                  max: joint.max,
                  step: 1,
                  value,
                  title: `${joint.id}（${joint.type === 'linear' ? '滑动 mm' : '旋转 °'}）`,
                  onInput: (event) => driveJoint(joint.id, Number(event.target.value)),
                }),
              ]),
            ])
          }),
          h('div', { key: 'eh', style: styles.treeHint }, '爆炸图'),
          h('div', { key: 'er', style: styles.propRow }, [
            h('span', { key: 'l', style: jointLabel }, '间距'),
            h('span', { key: 'v', style: styles.propValue, 'data-cad-explode-value': '1' }, `×${(explodeDraft !== null ? explodeDraft : (assembly.explode || 0)).toFixed(2)}`),
            h('input', {
              key: 's',
              type: 'range',
              style: styles.slider,
              'data-cad-explode': '1',
              min: 0,
              max: 2,
              step: 0.05,
              value: explodeDraft !== null ? explodeDraft : (assembly.explode || 0),
              title: '爆炸图间距：0 合拢，越大越分散',
              onInput: (event) => dragExplode(Number(event.target.value)),
            }),
          ]),
        ]

      // ---- features: edit one step of a feature list and rebuild -----------
      // The scene carries its own feature list (published with the model), so the
      // panel edits the same document the agent would: one POST → one rebuild →
      // the new scene replaces the old one in the tab being looked at.
      const featureList = payload && Array.isArray(payload.features) ? payload.features : []
      const featureModel = (payload && payload.model) || ''
      const featureDefaults = {
        box: { size: [40, 30, 10] },
        cylinder: { r: 6, h: 20 },
        sphere: { r: 10 },
        cone: { r1: 8, r2: 0, h: 16 },
        torus: { r1: 12, r2: 3 },
        cut: { with: { kind: 'cylinder', r: 4, h: 40, at: [0, 0, -5] } },
        fuse: { with: { kind: 'box', size: [10, 10, 10] } },
        fillet: { r: 2 },
        chamfer: { d: 1.5 },
        shell: { t: 2 },
      }
      const postFeature = async (body) => {
        try {
          const res = await fetch(`${ROUTE}/feature`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: featureModel, ...body }),
          })
          const out = await res.json()
          if (!res.ok || !out || out.ok === false) {
            setFeatError(String((out && out.error) || `HTTP ${res.status}`))
            return null
          }
          setFeatError('')
          if (out.sceneId) await applyScene(out.sceneId, out.at)
          return out
        } catch (error) {
          setFeatError(String((error && error.message) || error))
          return null
        }
      }
      // Number edits come from a text input: coalesce a burst of keystrokes into
      // one rebuild (each rebuild is a full FreeCAD run).
      const queueFeature = (body) => {
        if (featTimer.current) clearTimeout(featTimer.current)
        featTimer.current = setTimeout(() => { featTimer.current = null; postFeature(body) }, 260)
      }
      useEffect(() => () => { if (featTimer.current) clearTimeout(featTimer.current) }, [])
      const parseParam = (raw) => {
        const text = String(raw).trim()
        if (!text) return null
        if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
        if (/^-?[\d.]+(\s*[,，]\s*-?[\d.]+)+$/.test(text)) {
          const parts = text.split(/[,，]/).map((v) => Number(v.trim()))
          return parts.every((v) => Number.isFinite(v)) ? parts : null
        }
        return text
      }
      const draftKey = (id, path) => `${id}.${path.join('.')}`
      // One row per numeric/vector field; a nested object (cut.with) gets its own
      // indented rows so "孔的直径" is editable without touching the JSON.
      const paramFields = (params, base) => {
        const out = []
        for (const [key, value] of Object.entries(params || {})) {
          const path = base ? [...base, key] : [key]
          if (typeof value === 'number') out.push({ path, label: path.join('.'), kind: 'num', value })
          else if (Array.isArray(value) && value.every((v) => typeof v === 'number')) out.push({ path, label: path.join('.'), kind: 'vec', value })
          else if (value && typeof value === 'object' && !Array.isArray(value) && path.length < 2) {
            // A nested op (`cut.with` = a cylinder) is editable too: drop its
            // kind (you switch shapes by replacing the feature) and expose the
            // numbers that matter — r, h, at.
            const sub = {}
            for (const [k, v] of Object.entries(value)) if (k !== 'kind') sub[k] = v
            out.push(...paramFields(sub, path))
          }
        }
        return out
      }
      const setFeatureParam = (feature, path, raw) => {
        const parsed = parseParam(raw)
        if (parsed === null) return
        const params = JSON.parse(JSON.stringify(feature.params || {}))
        if (path.length === 1) params[path[0]] = parsed
        else {
          // Nested (with.r): send the whole nested object, the server merges shallow.
          const head = path[0]
          const nested = Object.assign({}, params[head] || {})
          nested[path[1]] = parsed
          params[head] = nested
        }
        queueFeature({ action: 'update', feature: { id: feature.id, params } })
      }
      const featureBody = !featureModel || !featureList.length
        ? [h('div', { key: 'none', style: styles.propEmpty },
          featureModel
            ? `${featureModel} 的特征列表是空的。`
            : '当前场景不是特征模型。用 cad_studio_doc create kind="features" 建一个（features 里每个 {kind,params}），就能在这里逐条改数值。')]
        : [
          h('div', { key: 'h', style: { ...styles.treeHint, display: 'flex', gap: 6, alignItems: 'center' } }, [
            h('span', { key: 'm', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${featureModel} · ${featureList.length} 特征`),
            h('button', {
              key: 'a',
              type: 'button',
              style: styles.headBtn,
              'data-cad-feat-add': '1',
              title: '添加一个特征',
              onClick: (event) => { event.stopPropagation(); setFeatAdd((prev) => !prev) },
            }, '+'),
          ]),
          featAdd
            ? h('div', { key: 'menu', style: styles.featAddMenu }, Object.keys(featureDefaults).map((kind) => h('button', {
              key: kind,
              type: 'button',
              style: styles.featAddItem,
              'data-cad-feat-kind': kind,
              onClick: (event) => {
                event.stopPropagation()
                setFeatAdd(false)
                postFeature({ action: 'add', feature: { kind, params: featureDefaults[kind] } })
              },
            }, kind)))
            : null,
          featError ? h('div', { key: 'e', style: styles.featError, 'data-cad-feat-error': '1' }, featError) : null,
          ...featureList.map((feature, index) => {
            const off = feature.enabled === false
            const fields = paramFields(feature.params || {}, [])
            return h('div', {
              key: feature.id,
              style: { ...styles.featBlock, opacity: off ? 0.5 : 1 },
              'data-cad-feat': feature.id,
            }, [
              h('div', { key: 'r', style: styles.featHead }, [
                h('span', { key: 'i', style: styles.featId }, feature.id),
                h('span', { key: 'l', style: styles.featLabel, title: `${feature.id} · ${feature.kind}` }, `${feature.label || feature.kind}`),
                h('button', {
                  key: 'e',
                  type: 'button',
                  style: styles.eyeButton,
                  title: off ? '启用这一步' : '暂时不显示这一步',
                  'data-cad-feat-eye': feature.id,
                  onClick: (event) => { event.stopPropagation(); postFeature({ action: 'toggle', feature: { id: feature.id, enabled: off } }) },
                }, off ? h(EyeIcon, { on: false }) : h(EyeIcon, { on: true })),
                h('button', {
                  key: 'u',
                  type: 'button',
                  style: styles.microBtn,
                  title: '上移',
                  disabled: index === 0,
                  'data-cad-feat-up': feature.id,
                  onClick: (event) => { event.stopPropagation(); postFeature({ action: 'move', id: feature.id, to: index - 1 }) },
                }, '↑'),
                h('button', {
                  key: 'd',
                  type: 'button',
                  style: styles.microBtn,
                  title: '下移',
                  disabled: index === featureList.length - 1,
                  'data-cad-feat-down': feature.id,
                  onClick: (event) => { event.stopPropagation(); postFeature({ action: 'move', id: feature.id, to: index + 1 }) },
                }, '↓'),
                h('button', {
                  key: 'x',
                  type: 'button',
                  style: styles.microBtn,
                  title: '删除这一步',
                  'data-cad-feat-remove': feature.id,
                  onClick: (event) => { event.stopPropagation(); postFeature({ action: 'remove', id: feature.id }) },
                }, '×'),
              ]),
              ...fields.map((field) => {
                const key = draftKey(feature.id, field.path)
                const shown = featDraft[key] !== undefined ? featDraft[key] : (field.kind === 'vec' ? field.value.join(', ') : String(field.value))
                return h('div', { key: key, style: styles.featField }, [
                  h('span', { key: 'l', style: styles.featFieldLabel, title: field.label }, field.label),
                  h('input', {
                    key: 'i',
                    type: 'text',
                    inputMode: field.kind === 'vec' ? 'text' : 'decimal',
                    style: styles.featInput,
                    value: shown,
                    'data-cad-feat-input': key,
                    title: field.kind === 'vec' ? '逗号分隔的数字，例如 60, 40, 20' : '改完自动重建',
                    onChange: (event) => {
                      const next = { ...featDraft }
                      delete next[key]
                      setFeatDraft(next)
                      setFeatureParam(feature, field.path, event.target.value)
                    },
                    onInput: (event) => setFeatDraft((prev) => ({ ...prev, [key]: event.target.value })),
                    onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
                  }),
                ])
              }),
            ])
          }),
        ]

      const skin = pickerSkin(theme)
      const partsCount = payload ? new Set((payload.instances || []).map((i) => i.part)).size : 0
      const rows = payload
        ? (payload.instances || []).map((inst) => {
          const part = (payload.parts || []).find((p) => p.id === inst.part)
          const slot = (payload.parts || []).findIndex((p) => p.id === inst.part)
          const partId = inst.part
          const rowHex = overrides.inst[inst.name] || overrides.part[partId]
          const color = paletteHex(part || { id: partId }, display.palette, slot, theme, rowHex)
          const copies = (payload.instances || []).filter((i) => i.part === partId).length
          // Reveal the row when the viewport picked it (the outline alone does
          // not tell you which of 15 rows it is).
          const revealRef = (el) => {
            if (!el || picked !== inst.name || revealedRef.current === picked) return
            revealedRef.current = picked
            el.scrollIntoView({ block: 'nearest' })
          }
          const on = visibility[inst.name] !== false
          return h('div', {
            key: inst.name,
            style: { ...styles.node, ...(picked === inst.name ? styles.nodePicked : {}), opacity: on ? 1 : 0.45, position: 'relative' },
            'data-cad-row': inst.name,
            ref: revealRef,
            'data-cad-row-active': picked === inst.name ? '1' : '0',
            onClick: () => selectInstance(picked === inst.name ? '' : inst.name),
            title: `${inst.name} · ${part ? part.id : inst.part}（点一下在视口里定位）`,
          }, [
            h('button', {
              key: 's',
              type: 'button',
              title: copies > 1 ? '给这个实例换颜色（可选：该零件全部副本同色）' : '切换这个零件的颜色',
              'data-cad-swatch': inst.name,
              'data-cad-part': partId,
              style: styles.swatchButton,
              onClick: (event) => {
                event.stopPropagation()
                setColorFor((prev) => (prev === inst.name ? null : inst.name))
              },
            }, h('span', { style: styles.swatch(color) })),
            h('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, displayName(inst.name, partId)),
            h('button', {
              key: 'e',
              type: 'button',
              title: on ? '隐藏这个零件' : '显示这个零件',
              'data-cad-eye': inst.name,
              style: styles.eyeButton,
              onClick: (event) => {
                event.stopPropagation()
                toggle(inst.name)
              },
            }, h(EyeIcon, { on })),
            colorFor === inst.name ? h(ColorPopover, {
              key: 'pop',
              theme,
              copies,
              onPick: (hex) => pickColor(inst.name, hex),
              onApplyAll: () => applyToCopies(partId, color),
              onReset: () => resetColor(partId),
              onClose: () => setColorFor(null),
            }) : null,
          ])
        })
        : []


      /** Single place that keeps 3D outline and tree row in sync. */
      const selectInstance = (name) => {
        setPicked(name || '')
        if (viewportRef.current) viewportRef.current.setHighlight(name || '')
      }
      // A viewport pick means "I want to tweak this one", so bring the
      // inspector up. Tree clicks do not move the panel (you may be on 零件).
      const pickInViewport = (name) => {
        selectInstance(name)
        if (name) setPanel('props')
      }

      // Installing FreeCAD is the one action that changes the machine, so the
      // panel only offers it when the probe says the binary is missing.
      const installFreecad = async () => {
        setInstalling('安装中，可能要几分钟…')
        try {
          const res = await fetch(`${ROUTE}/setup`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'install' }),
          })
          const out = await res.json()
          setInstalling(out.available ? '' : (out.reason || '安装失败，看日志'))
          if (out.log) console.log('[cad-studio] install log', out.log)
          const st = await fetch(`${ROUTE}/state`, { headers: { accept: 'application/json' } })
          if (st.ok) setState(await st.json())
        } catch (e) {
          setInstalling(`安装失败：${String(e).slice(0, 120)}`)
        }
      }

      const installNode = runtime.available
        ? null
        : h('div', { key: 'install', style: styles.installBox, 'data-cad-install-box': '1' }, [
          h('div', { key: 'h' }, '没有找到 freecadcmd，建模工具暂时用不了。'),
          h('div', { key: 'c', style: styles.installHint }, setup.command ? `可执行：${setup.command}` : (setup.reason || '手动安装 FreeCAD 后设置 freecadPath。')),
          h('button', {
            key: 'b', type: 'button', 'data-cad-install': '1', style: styles.installBtn,
            disabled: installing !== '' || !setup.canInstall,
            onClick: () => { if (!installing) installFreecad() },
          }, installing || (setup.canInstall ? '自动安装 FreeCAD' : '需要 root 才能自动安装')),
        ])

      const panelSkin = skin.list
      const activeTab = openTabs.find((t) => t.key === activeKey) || null
      const activeModel = activeTab ? activeTab.id : ''
      const infoRows = payload
        ? [
          ['实例', `${(payload.instances || []).length}`],
          ['零件', `${partsCount}`],
          ['三角形', `${Math.round((payload.instances || []).reduce((sum, inst) => {
            const part = (payload.parts || []).find((p) => p.id === inst.part)
            return sum + ((part && part.tris ? part.tris.length : 0) / 3)
          }, 0)).toLocaleString()}`],
          ['体积', `${formatVolume((payload.instances || []).reduce((sum, inst) => {
            const part = (payload.parts || []).find((p) => p.id === inst.part)
            return sum + ((part && part.volume) || 0)
          }, 0))}`],
          ['freecadcmd', runtime && runtime.available ? String(runtime.binary) : '未找到'],
        ]
        : []

      const panelTitle = { parts: '零件', features: '特征', props: '选中项', motion: '运动', view: '视图', models: '模型', info: '信息' }[panel] || ''
      // --- inspector: the properties of the one selected instance ----------
      const pickedInst = payload ? (payload.instances || []).find((i) => i.name === picked) : null
      const pickedPart = pickedInst ? (payload.parts || []).find((p) => p.id === pickedInst.part) : null
      const pickedSlot = pickedInst ? (payload.parts || []).findIndex((p) => p.id === pickedInst.part) : -1
      const pickedCopies = pickedInst ? (payload.instances || []).filter((i) => i.part === pickedInst.part).length : 0
      const pickedHex = pickedInst
        ? paletteHex(pickedPart || { id: pickedInst.part }, display.palette, pickedSlot, theme,
          overrides.inst[picked] || overrides.part[pickedInst.part])
        : ''
      const opacityOf = (name) => {
        const v = opacities[name]
        return typeof v === 'number' ? v : 1
      }
      const setOpacity = (name, value) => {
        const v = Math.max(0.05, Math.min(1, value))
        setOpacities((prev) => ({ ...prev, [name]: v }))
        if (viewportRef.current) viewportRef.current.setInstanceOpacity(name, v)
      }
      const pickedOn = pickedInst ? visibility[pickedInst.name] !== false : true
      const pickedTris = pickedPart && pickedPart.tris ? Math.round(pickedPart.tris.length / 3) : 0
      const pickedSize = (() => {
        const v = pickedPart && pickedPart.verts
        if (!v || v.length < 3) return ''
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < v.length; i += 3) {
          for (let k = 0; k < 3; k += 1) {
            if (v[i + k] < min[k]) min[k] = v[i + k]
            if (v[i + k] > max[k]) max[k] = v[i + k]
          }
        }
        const dim = [0, 1, 2].map((k) => Math.round((max[k] - min[k]) * 10) / 10)
        return `${dim[0]} × ${dim[1]} × ${dim[2]}`
      })()
      const wireOf = (name) => !!wireframes[name]
      const toggleWire = (name) => {
        const on = !wireOf(name)
        setWireframes((prev) => {
          const next = { ...prev }
          if (on) next[name] = true
          else delete next[name]
          return next
        })
        if (viewportRef.current) viewportRef.current.setInstanceWireframe(name, on)
      }
      // "The rest goes ghost": every other instance at 25 %, so the one you
      // are working on stays readable against its surroundings.
      const ghostOthers = (name) => {
        const next = {}
        for (const inst of payload.instances || []) next[inst.name] = inst.name === name ? 1 : 0.25
        setOpacities(next)
        if (viewportRef.current) {
          for (const key of Object.keys(next)) viewportRef.current.setInstanceOpacity(key, next[key])
        }
      }
      const opacityToCopies = (value) => {
        const partId = pickedInst && pickedInst.part
        const next = { ...opacities }
        for (const inst of payload.instances || []) {
          if (inst.part !== partId) continue
          next[inst.name] = value
          if (viewportRef.current) viewportRef.current.setInstanceOpacity(inst.name, value)
        }
        setOpacities(next)
      }
      const isolate = (name) => {
        const next = {}
        for (const inst of payload.instances || []) next[inst.name] = inst.name === name
        setVisibility(next)
      }
      // "Show all" also drops the ghosting, otherwise the assembly stays a
      // pile of 25 % ghosts with nothing to explain why.
      const showAll = () => {
        setVisibility({})
        if (Object.keys(opacities).length) {
          setOpacities({})
          if (viewportRef.current) {
            for (const inst of payload.instances || []) viewportRef.current.setInstanceOpacity(inst.name, 1)
          }
        }
      }
      const resetPicked = () => {
        if (!pickedInst) return
        setOpacity(pickedInst.name, 1)
        setOpacities((prev) => { const next = { ...prev }; delete next[pickedInst.name]; return next })
        setVisibility((prev) => ({ ...prev, [pickedInst.name]: true }))
        if (wireOf(pickedInst.name)) {
          setWireframes((prev) => { const next = { ...prev }; delete next[pickedInst.name]; return next })
          if (viewportRef.current) viewportRef.current.setInstanceWireframe(pickedInst.name, false)
        }
        setOverrides((prev) => {
          const inst = { ...prev.inst }
          delete inst[pickedInst.name]
          return { ...prev, inst }
        })
        if (viewportRef.current && pickedPart) {
          viewportRef.current.setInstanceColor(pickedInst.name, paletteHex(pickedPart, display.palette, pickedSlot, theme, null))
        }
        setPropColorOpen(false)
      }
      const inspectorBody = !pickedInst
        ? h('div', { key: 'none', style: styles.propEmpty }, [
          h('div', { key: 'a' }, '还没有选中零件。'),
          h('div', { key: 'b', style: { marginTop: 4, opacity: 0.75 } }, '在视口里点一个零件，或在零件列表里点一行；选中后这里可以单独调它的颜色、显隐和透明度。'),
        ])
        : h('div', { key: 'sel', style: { display: 'flex', flexDirection: 'column' } }, [
          h('div', { key: 'name', style: styles.propName, 'data-cad-prop-name': pickedInst.name }, [
            h('span', { key: 's', style: styles.swatch(pickedHex) }),
            h('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, displayName(pickedInst.name, pickedInst.part)),
          ]),
          h('div', { key: 'sub', style: styles.propSub }, `${pickedInst.part}${pickedCopies > 1 ? ` · 共 ${pickedCopies} 个副本` : ''}${pickedTris ? ` · ${pickedTris.toLocaleString()} 三角面` : ''}${pickedSize ? ` · ${pickedSize} mm` : ''}`),
          h('div', { key: 'color', style: { ...styles.propRow, position: 'relative' } }, [
            h('span', { key: 'l', style: styles.propLabel }, '颜色'),
            h('span', { key: 's', style: styles.swatch(pickedHex) }),
            h('button', {
              key: 'b',
              type: 'button',
              'data-cad-prop-color': pickedInst.name,
              style: { ...styles.propBtn, marginLeft: 'auto' },
              onClick: () => setPropColorOpen((open) => !open),
            }, '换色'),
            propColorOpen ? h(ColorPopover, {
              key: 'pop',
              theme,
              copies: pickedCopies,
              onPick: (hex) => { pickColor(pickedInst.name, hex); setPropColorOpen(false) },
              onApplyAll: () => { applyToCopies(pickedInst.part, pickedHex); setPropColorOpen(false) },
              onReset: () => { resetColor(pickedInst.part); setPropColorOpen(false) },
              onClose: () => setPropColorOpen(false),
            }) : null,
          ]),
          h('div', { key: 'eye', style: styles.propRow }, [
            h('span', { key: 'l', style: styles.propLabel }, '显隐'),
            h('button', {
              key: 'b',
              type: 'button',
              'data-cad-prop-eye': pickedInst.name,
              style: styles.propBtn,
              onClick: () => toggle(pickedInst.name),
            }, pickedOn ? '显示中 · 点此隐藏' : '已隐藏 · 点此显示'),
          ]),
          h('div', { key: 'op', style: styles.propRow }, [
            h('span', { key: 'l', style: styles.propLabel }, '透明度'),
            h('input', {
              key: 'i',
              type: 'range',
              min: 5,
              max: 100,
              step: 5,
              value: Math.round(opacityOf(pickedInst.name) * 100),
              'data-cad-prop-opacity': pickedInst.name,
              style: styles.slider,
              onInput: (event) => setOpacity(pickedInst.name, Number(event.target.value) / 100),
              onChange: (event) => setOpacity(pickedInst.name, Number(event.target.value) / 100),
            }),
            h('span', { key: 'v', style: styles.propValue }, `${Math.round(opacityOf(pickedInst.name) * 100)}%`),
          ]),
          h('div', { key: 'btns', style: styles.propBtns }, [
            h('button', {
              key: 'iso',
              type: 'button',
              'data-cad-prop-isolate': pickedInst.name,
              style: styles.propBtn,
              title: '只显示这一件，其余隐藏',
              onClick: () => isolate(pickedInst.name),
            }, '隔离显示'),
            h('button', {
              key: 'ghost',
              type: 'button',
              'data-cad-prop-ghost': pickedInst.name,
              style: styles.propBtn,
              title: '其余零件降到 25% 透明度，突出当前选中项',
              onClick: () => ghostOthers(pickedInst.name),
            }, '其余半透明'),
            h('button', {
              key: 'copies',
              type: 'button',
              'data-cad-prop-copies': pickedInst.name,
              style: { ...styles.propBtn, display: pickedCopies > 1 ? '' : 'none' },
              title: `这个零件的 ${pickedCopies} 个副本都设为同样的透明度`,
              onClick: () => opacityToCopies(opacityOf(pickedInst.name)),
            }, `副本同透明度 (${pickedCopies})`),
            h('button', {
              key: 'wire',
              type: 'button',
              'data-cad-prop-wire': pickedInst.name,
              'data-cad-prop-wire-on': wireOf(pickedInst.name) ? '1' : '0',
              style: { ...styles.propBtn, boxShadow: wireOf(pickedInst.name) ? 'inset 0 0 0 1px rgba(77,107,254,.6)' : 'none' },
              onClick: () => toggleWire(pickedInst.name),
            }, wireOf(pickedInst.name) ? '线框：开' : '线框'),
            h('button', { key: 'all', type: 'button', 'data-cad-prop-showall': '1', style: styles.propBtn, onClick: showAll }, '全部显示'),
            h('button', { key: 'rst', type: 'button', 'data-cad-prop-reset': pickedInst.name, style: styles.propBtn, onClick: resetPicked }, '重置此项'),
          ]),
        ])


      // `cad_studio_open` stores the absolute path as the scene title; show the
      // basename (steps read as "魔袋托架_150x62_高107" rather than "/workspace/…").
      const shortName = (sc) => {
        if (!sc) return ''
        const base = String(sc.title || sc.id || '').split('/').pop()
        return base.replace(/\.(step|stp|stl|brep|iges|igs|stpz)$/i, '') || String(sc.id || '')
      }
      const panelBody = panel === 'parts'
        ? rows
        : panel === 'features'
          ? featureBody
        : panel === 'props'
          ? inspectorBody
          : panel === 'motion'
          ? motionBody
          : panel === 'view'
          ? h(ViewMenu, { theme, display, setDisplay, handleRef: viewportRef, inline: true, onClose: () => {} })
          : panel === 'models'
            ? (scenes.length
              ? scenes.map((sc) => h('button', {
                key: sc.id,
                type: 'button',
                'data-cad-scene': sc.id,
                style: styles.modelRow(sc.id === activeModel),
                title: `切换到 ${shortName(sc)}（替换当前视图里的模型，不新开页签）`,
                onClick: () => { switchModel(sc.id) },
              }, [
                h('span', { key: 'n', style: { ...styles.modelName, fontWeight: sc.id === activeModel ? 600 : 400 } }, shortName(sc)),
                h('span', { key: 'm', style: styles.modelMeta }, `${(sc.at ? new Date(sc.at).toLocaleTimeString('zh-CN', { hour12: false }) : '')} · ${sc.instances || 0} 实例 · ${sc.parts || 0} 零件`),
              ]))
              : h('div', { key: 'none', style: styles.treeHint }, '还没有别的模型'))
            : panel === 'info'
              ? [
                ...infoRows.map(([key, value]) => h('div', { key, style: styles.infoRow }, [
                h('span', { key: 'k', style: styles.infoKey }, key),
                h('span', { key: 'v', style: { ...styles.infoVal, maxWidth: '65%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: value }, value),
              ])),
                ...(installNode ? [installNode] : []),
              ]
              : null

      const railItems = [
        { id: 'parts', label: '零件：显隐与配色' },
        { id: 'features', label: '特征列表：改一条就重建' },
        { id: 'props', label: '选中项属性' },
        { id: 'motion', label: '关节与运动、爆炸图' },
        { id: 'view', label: '视图与显示' },
        { id: 'models', label: '切换模型' },
        { id: 'info', label: '模型信息' },
      ]

      return h('div', { style: styles.root, 'data-cad-panel-root': '1' }, [
        h('div', {
          key: 'head',
          style: styles.head,
          'data-cad-model-title': activeKey === 'activity'
            ? shortName(activity || { id: visibleId })
            : shortName(openTabs.find((t) => t.key === activeKey) || {}),
        }, [
          h('div', { key: 'tabs', style: styles.tabs, role: 'tablist' }, [
            h('button', {
              key: 'activity',
              type: 'button',
              role: 'tab',
              'data-cad-tab': 'activity',
              'aria-selected': activeKey === 'activity' ? 'true' : 'false',
              style: styles.tab(activeKey === 'activity', skin, true),
              title: activity ? `活动：跟随本会话的建模操作（当前 ${shortName(activity)}）` : '活动：跟随本会话的建模操作',
              onClick: () => focusTab('activity'),
            }, [
              h('span', { key: 's', style: styles.tabStatus(Boolean(runtime.available)), title: runtime.available ? `FreeCAD 可用：${runtime.binary}` : '没有找到 freecadcmd' }),
              h('span', { key: 'l', style: styles.tabLabel }, '活动'),
              fresh ? h('span', { key: 'n', style: styles.tabDot, title: '活动里有新模型' }) : null,
            ]),
            ...openTabs.map((t) => h('button', {
              key: t.key,
              type: 'button',
              role: 'tab',
              'data-cad-tab': 'model',
              'data-cad-tab-id': t.key,
              'data-cad-tab-scene': t.id,
              'aria-selected': activeKey === t.key ? 'true' : 'false',
              style: styles.tab(activeKey === t.key, skin),
              title: `已打开的模型：${shortName(t)}（不会跟着新的建模操作变）`,
              onClick: () => focusTab(t.key),
            }, [
              h('span', { key: 'l', style: styles.tabLabel }, shortName(t)),
              // With many tabs open the × of every inactive tab would eat the
              // label space; keep it where it is immediately useful (the tab you
              // are on, or the only tab), like a browser does.
              activeKey === t.key || openTabs.length <= 2
                ? h('span', {
                  key: 'x',
                  'data-cad-tab-close': t.key,
                  style: styles.tabClose,
                  title: '关闭这个模型页签',
                  onClick: (event) => { event.stopPropagation(); closeTab(t.key) },
                }, '×')
                : null,
            ])),
            // "+" is its own control with its own dropdown, anchored to the
            // button: the rail's folder switches the current model in place and
            // stays open, "+" always makes a new tab and closes itself.
            h('span', { key: 'addwrap', style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto' } }, [
              openTabs.length < MAX_TABS
                ? h('button', {
                  key: 'add',
                  type: 'button',
                  'data-cad-tab-add': '1',
                  'aria-label': '新增模型页签',
                  'aria-expanded': addOpen ? 'true' : 'false',
                  style: { ...styles.barBtn(panelSkin), marginLeft: 2 },
                  title: `新开一个模型页签（每次选一个模型就加一个，最多 ${MAX_TABS} 个）`,
                  ref: addBtnRef,
                  onClick: () => {
                    // Open toward whichever side has room, so the menu never
                    // lands under the page content beside the pane.
                    const rect = addBtnRef.current ? addBtnRef.current.getBoundingClientRect() : null
                    setAddAlign(rect && rect.right + 232 > window.innerWidth ? 'right' : 'left')
                    setAddOpen((open) => !open)
                  },
                }, '+')
                : null,
              addOpen
                ? h('div', {
                  key: 'addmenu',
                  'data-cad-addmenu': '1',
                  style: { ...styles.addMenu, ...(addAlign === 'right' ? { right: 0, left: 'auto' } : { left: 0, right: 'auto' }), background: panelSkin.background, borderColor: panelSkin.borderColor, color: panelSkin.color },
                }, scenes.length
                  ? scenes.map((sc) => h('button', {
                    key: sc.id,
                    type: 'button',
                    'data-cad-add-scene': sc.id,
                    style: styles.addRow(sc.id === activeModel),
                    title: `${shortName(sc)}（${sc.instances || 0} 实例 · ${sc.parts || 0} 零件）`,
                    onClick: () => { setAddOpen(false); openModel(sc.id) },
                  }, [
                    h('span', { key: 'n', style: { ...styles.modelName, fontWeight: sc.id === activeModel ? 600 : 400 } }, shortName(sc)),
                    h('span', { key: 'm', style: styles.modelMeta }, `${sc.instances || 0} 实例 · ${sc.parts || 0} 零件`),
                  ]))
                  : h('div', { key: 'none', style: styles.addHint }, '还没有别的模型'))
                : null,
            ]),
          ]),
        ]),
        error ? h('div', { key: 'err', style: styles.warn }, error) : null,
        h('div', { key: 'body', style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } }, [
          h('div', {
            key: 'rail',
            role: 'toolbar',
            'aria-label': 'CAD 面板工具',
            style: { ...styles.rail, borderRightColor: panelSkin.borderColor },
          }, railItems.map((item) => h('button', {
            key: item.id,
            type: 'button',
            style: styles.railBtn(panel === item.id),
            'data-cad-rail': item.id,
            'aria-pressed': panel === item.id ? 'true' : 'false',
            'aria-label': item.label,
            title: item.label,
            onClick: () => { setAddOpen(false); setPanel((p) => (p === item.id ? '' : item.id)) },
          }, h(RailIcon, { name: item.id })))),
          h('div', { key: 'main', style: { flex: '1 1 auto', minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' } }, [
            payload
              ? h('div', { key: 'stage', style: styles.stage }, h(Viewport, { payload, visibility, options: { ...display, overrides, opacities, wireframes, restoreCamera: pendingCameraRef.current, onPick: pickInViewport }, handleRef: viewportRef }))
              : h('div', { key: 'empty', style: styles.empty }, '还没有模型。让 AI 跑一次 FreeCAD 脚本或打开一个 STEP 文件，这里会自动显示。'),
            picked && panel !== 'parts'
              ? h('button', {
                key: 'picked',
                type: 'button',
                'data-cad-picked': picked,
                style: { ...styles.pickChip, background: panelSkin.background, color: panelSkin.color, borderColor: panelSkin.borderColor },
                title: '在零件列表里定位',
                onClick: () => setPanel('parts'),
              }, [h('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, picked), h('span', { key: 'h', style: { opacity: 0.5 } }, '›')])
              : null,
            panel
              ? h('div', {
                key: 'panel',
                'data-cad-panel': panel,
                style: { ...styles.floatPanel, background: panelSkin.background, color: panelSkin.color, borderColor: panelSkin.borderColor },
              }, [
                h('div', { key: 'h', style: styles.floatHead }, [
                  h('span', { key: 't' }, panelTitle),
                  h('span', {
                    key: 's',
                    style: { marginLeft: 'auto', fontSize: 9.5, opacity: 0.55, whiteSpace: 'nowrap' },
                    title: panel === 'parts' ? '点行在视口定位，点色块换色，点眼睛显隐' : '',
                  }, panel === 'parts' && payload ? `${(payload.instances || []).length} 实例 · ${partsCount} 零件` : ''),
                ]),
                h('div', { key: 'b', style: styles.floatBody }, panelBody),
              ])
              : null,
          ]),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The right-pane service is registered by another client plugin; it may
        // not exist yet when this entry activates, so retry like dsh-cad does
        // instead of throwing (a throw marks this entry "failed" at boot).
        let panelRegistered = false
        const register = () => {
          if (panelRegistered) return true
          const tabs = ctx.get?.('sidebarRightTabs')
          if (!tabs || typeof tabs.register !== 'function') return false
          const disposers = []
          const keep = (d) => { if (typeof d === 'function') disposers.push(d) }
          try {
            keep(tabs.register({
              id: 'cad-studio',
              kind: 'cad-studio',
              title: () => 'CAD 工作室',
              guide: [{ order: 30, title: () => 'CAD 工作室', description: () => 'AI 跑 CAD 脚本或打开 STEP 后，这里显示最新模型；点左侧实例可显隐。' }],
            }))
            keep(ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'cad-studio' }, Panel),
            ))
            keep(ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'cad-studio' },
                () => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, 'CAD 工作室')),
            ))
            panelRegistered = true
            ctx.effect?.(() => () => {
              panelRegistered = false
              for (const d of disposers.reverse()) {
                try { d() } catch (err) { console.warn('[cad-studio] dispose failed', err) }
              }
            })
            return true
          } catch (err) {
            console.warn('[cad-studio] panel registration failed', err)
            for (const d of disposers.reverse()) { try { d() } catch {} }
            return false
          }
        }
        // A file viewer for better-sidebar, when that plugin is installed.
        // Its service is registered by another client plugin, so wait for it
        // with ctx.inject (which resolves when the dependency appears) rather
        // than probing ctx.get once at activation time.
        let viewerRegistered = false
        const registerViewer = () => {
          if (viewerRegistered) return true
          const caps = ctx.get?.('betterSidebar')
          if (!caps || typeof caps.registerFileViewer !== 'function') return false
          try {
            const dispose = caps.registerFileViewer({
              id: 'cad-studio-file',
              title: 'CAD 工作室',
              exts: FILE_EXTS,
              priority: 120,
              fetchStrategy: 'custom',
              load: async (filePath) => ({ path: filePath }),
              component: CadFileView,
            })
            viewerRegistered = true
            ctx.effect?.(() => () => { try { dispose() } catch {} })
            return true
          } catch (err) {
            console.warn('[cad-studio] file viewer registration failed', err)
            return false
          }
        }
        const watchViewer = () => {
          if (registerViewer()) return
          try {
            if (typeof ctx.inject === 'function') ctx.inject(['betterSidebar'], () => { registerViewer() })
          } catch (err) {
            console.warn('[cad-studio] betterSidebar inject failed', err)
          }
        }

        const delays = [0, 100, 300, 600, 1200, 2400]
        const attempt = (i) => {
          const done = register()
          watchViewer()
          if ((done && viewerRegistered) || i >= delays.length) return
          setTimeout(() => attempt(i + 1), delays[i])
        }
        attempt(0)

        // Place a tab in the right sidebar and open the bar if it is collapsed.
        // Every session starts with an EMPTY rightbar, so a fresh workspace
        // shows nothing at all until the + menu is used — and that menu is not
        // discoverable. `openTab` throws until the host mounted the session
        // surface, hence the retry chain (same pattern as dsh-cad).
        const TAB_KIND = 'cad-studio'
        const steerRightbar = (shown, delayMs) => {
          setTimeout(() => {
            try {
              const scope = shown ? document : document.querySelector('[data-sidebar-right-panel]')
              if (!scope) return
              const re = shown
                ? /(打开|展开|open|show|expand).*(右侧边栏|right|sidebar)/i
                : /(收起|折叠|collapse|hide).*(右侧边栏|right|sidebar)/i
              const btn = Array.from(scope.querySelectorAll('button'))
                .find((candidate) => re.test(candidate.getAttribute('aria-label') || ''))
              if (btn instanceof HTMLElement) btn.click()
            } catch (err) { /* best-effort: the host's own presentation stands */ }
          }, delayMs)
        }
        // Auto-placing the tab is what makes the pane discoverable, but doing it
        // on every session switch hijacks conversations that never touch CAD.
        // Default gate: only sessions that already own a published scene, or
        // that live in the CAD workspace, get the bar opened for them.
        // The conversation id is published on the shell's own DOM
        // (`data-conversation-session`) — the one signal that has stayed stable
        // across host versions; the session store snapshot is a bonus.
        const readDomSession = () => {
          const el = document.querySelector('[data-conversation-session]')
            || document.querySelector('[data-sidebar-right-session]')
          const value = el && (el.getAttribute('data-conversation-session') || el.getAttribute('data-sidebar-right-session'))
          return typeof value === 'string' ? value : ''
        }
        const uiSession = ctx.get?.('uiSession')
        const current = uiSession && uiSession.adapter && uiSession.adapter.current
        const readSession = () => {
          let id = ''
          try {
            if (current != null && typeof current.getSnapshot === 'function') {
              const snap = current.getSnapshot()
              id = (snap && (snap.sessionId || snap.id || (snap.session && snap.session.id) || (snap.header && snap.header.id))) || ''
            }
          } catch (err) { /* no snapshot shape we recognise */ }
          if (!id) id = readDomSession()
          if (typeof id === 'string' && id && id !== panelSession) {
            panelSession = id
          }
          return panelSession
        }
        readSession()

        const AUTO_OPEN_DELAYS = [300, 900, 1800, 3000, 5000]
        const openPane = (index) => {
          const ctrl = ctx.get?.('sidebarRight')
          if (ctrl != null && typeof ctrl.openTab === 'function') {
            try {
              ctrl.openTab(TAB_KIND)
              steerRightbar(true, 250)
              return
            } catch (err) { /* session surface not mounted yet — retry */ }
          }
          if (index < AUTO_OPEN_DELAYS.length) setTimeout(() => openPane(index + 1), AUTO_OPEN_DELAYS[index])
        }
        // Debug surface: `window.__cadStudioAutoOpen` answers "why did the pane
        // open / not open" without digging through the bundle.
        const autoOpenTrace = { mode: '', session: '', opened: 0, why: 'boot' }
        try {
          Object.defineProperty(window, '__cadStudioAutoOpen', {
            configurable: true,
            get: () => ({ ...autoOpenTrace, mode: cadAutoOpen, session: panelSession }),
          })
        } catch (err) { /* a stale definition from a previous apply is fine */ }

        // Policy: never open because a session "has used CAD before", and never
        // on a conversation switch. The single trigger is live work — this
        // session publishes something while the pane is off screen — and then
        // it opens on the live (activity) tab. Everything else stays closed.
        const paneMounted = () => Boolean(document.querySelector('[data-cad-panel-root]'))
        let watchStamp = ''
        let watchBusy = false
        let ranRecently = false
        const watchOnce = async () => {
          readSession()
          if (cadAutoOpen === 'off') { autoOpenTrace.why = 'off'; return }
          if (paneMounted()) { watchStamp = ''; autoOpenTrace.why = 'shown'; return }
          const id = panelSession || ''
          if (!id || watchBusy) return
          watchBusy = true
          try {
            const res = await fetch(`${ROUTE}/state`, { headers: { accept: 'application/json' } })
            if (res.ok) {
              const st = await res.json()
              // A tool is executing for this session right now: that is the
              // trigger the policy asks for, so raise the pane on the live tab.
              const runningNow = Number(st && st.running) > 0
                && (!st.runningSession || st.runningSession === id)
              if (runningNow && !ranRecently) {
                ranRecently = true
                autoOpenTrace.opened += 1
                autoOpenTrace.why = 'running'
                openPane(0)
                return
              }
              if (!runningNow) ranRecently = false
              const latest = st && st.latest
              if (latest && latest.session === id) {
                const stamp = `${latest.id}@${latest.at || ''}`
                const prev = watchStamp
                watchStamp = stamp
                if (prev && prev !== stamp) {
                  autoOpenTrace.opened += 1
                  autoOpenTrace.why = 'activity'
                  openPane(0)
                } else if (!prev) {
                  autoOpenTrace.why = 'armed'
                }
              } else {
                watchStamp = ''
                autoOpenTrace.why = 'idle'
              }
            }
          } catch (err) {
            autoOpenTrace.why = 'probe-failed'
          } finally {
            watchBusy = false
          }
        }
        watchOnce()
        const watchTimer = setInterval(watchOnce, 3000)
        ctx.effect?.(() => () => clearInterval(watchTimer))
        // The session id still has to be tracked (the watcher only opens for the
        // session that is on screen), but a change merely re-arms the baseline.
        const rebase = () => {
          readSession()
          watchStamp = ''
          autoOpenTrace.session = panelSession
        }
        if (current != null && typeof current.subscribe === 'function' && typeof current.getSnapshot === 'function') {
          try {
            const unsubscribe = current.subscribe(() => rebase())
            ctx.effect?.(() => unsubscribe)
          } catch (err) { /* no session store on this host */ }
          // Switching conversations rewrites that attribute without always
          // firing a store event, so watch it directly; the observer is cheap.
          try {
            let lastSeen = readDomSession()
            const observer = new MutationObserver(() => {
              const next = readDomSession()
              if (next && next !== lastSeen) { lastSeen = next; rebase() }
            })
            observer.observe(document.documentElement, {
              subtree: true,
              attributes: true,
              attributeFilter: ['data-conversation-session', 'data-sidebar-right-session'],
            })
            ctx.effect?.(() => observer.disconnect())
          } catch (err) { /* no MutationObserver: the store path above still runs */ }
        }
      },
    }
  },
})
