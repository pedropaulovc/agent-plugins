/**
 * Client half of the composer context-details bundle.
 *
 * Replaces the shipped composer context meter with the same ring and popover,
 * extended with per-item token estimates: every model-visible tool schema and
 * every advertised skill, largest first, each priced by the Host projection
 * `contextDetails`. The aggregate bar and its three category rows keep the
 * shipped behavior and wording, so the control reads as the host's own menu.
 *
 * The shipped meter is plain UI inside the ui-conversation bundle and exposes no
 * slot, so this entry both hides that one control (only a dialog trigger whose
 * label carries a percentage, never one of ours) and registers its replacement
 * in the same composer dock. When the Host projection is absent the replacement
 * degrades to exactly the shipped three-row menu.
 */
window.__ModuleLoader__.load({
  id: '@pedropaulovc/dsh-context-details',
  factory(require) {
    const React = require('react')
    const reactDom = require('react-dom')
    const h = React.createElement

    /** Locale namespace this bundle owns. */
    const NS = 'context-details'
    /** Marker the localized occupancy sentence is split on, keeping word order locale-owned. */
    const READING_SLOT = '\0'
    /** Ring geometry, matching the shipped meter. */
    const RADIUS = 5.5
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS
    /** Marks this bundle's own trigger so the stock-meter sweep never hides it. */
    const OWN_TRIGGER_ATTRIBUTE = 'data-context-details-trigger'
    const DOCK_SELECTOR = '[data-composer-dock]'
    const DIALOG_TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"]'
    /** Panel geometry: anchor gap, viewport margin, and the list scroll cap. */
    const ANCHOR_GAP = 8
    const VIEWPORT_MARGIN = 12

    const CSS = `
.dsl-ctx-root{flex:none;display:inline-flex}
.dsl-ctx-trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dsl-ctx-trigger:hover,.dsl-ctx-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsl-ctx-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}
.dsl-ctx-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}
.dsl-ctx-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(340px,100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;position:fixed;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsl-ctx-panel:focus{outline:none}
.dsl-ctx-list:focus-visible{outline:1px solid var(--dsw-alias-border-l2);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.dsl-ctx-header{align-items:center;gap:6px;display:flex}
.dsl-ctx-figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}
.dsl-ctx-percent{color:var(--dsw-alias-label-primary);font-weight:500}
.dsl-ctx-headline{color:var(--dsw-alias-label-tertiary)}
.dsl-ctx-headline:empty{display:none}
.dsl-ctx-bar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}
.dsl-ctx-segment{background:var(--meter-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}
.dsl-ctx-swatch{background:var(--meter-tint);vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}
.dsl-ctx-colorSystem{--meter-tint:var(--dsw-static-neutral-bluish-400)}
.dsl-ctx-colorTools{--meter-tint:#a78bfa}
.dsl-ctx-colorMessages{--meter-tint:var(--dsw-static-blue-450)}
.dsl-ctx-rows{margin:6px 0 0}
.dsl-ctx-row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}
.dsl-ctx-row dt{color:var(--dsw-alias-label-secondary)}
.dsl-ctx-row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}
.dsl-ctx-sections{border-top:1px solid var(--dsw-alias-border-l1);margin-top:10px;padding-top:8px}
.dsl-ctx-section+.dsl-ctx-section{margin-top:10px}
.dsl-ctx-sectionHead{align-items:baseline;gap:6px;display:flex}
.dsl-ctx-sectionTitle{color:var(--dsw-alias-label-primary);font-weight:500}
.dsl-ctx-count{color:var(--dsw-alias-label-tertiary)}
.dsl-ctx-total{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto}
.dsl-ctx-list{list-style:none;margin:5px 0 0;padding:0 2px 0 11px;border-left:1px solid var(--dsw-alias-border-l1);max-height:176px;overflow-y:auto;overscroll-behavior:contain}
.dsl-ctx-item{min-width:0;align-items:baseline;gap:12px;padding:2px 0;display:flex}
.dsl-ctx-name{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px}
.dsl-ctx-tokens{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;flex:none}
.dsl-ctx-empty{color:var(--dsw-alias-label-tertiary);margin-top:4px}
.dsl-ctx-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:6px 0 0}
`

    const EN = {
      'context.aria': '{percent} of context used',
      'context.panel': 'Context usage',
      'context.system': 'System prompt',
      'context.tools': 'Tool definitions',
      'context.messages': 'Messages',
      'context.skills': 'Skills',
      'context.count': '{count} items',
      'context.countOne': '1 item',
      'context.emptyTools': 'No tool schemas in context',
      'context.emptySkills': 'No skills advertised',
      'context.note': 'Categories are heuristic estimates; the total above comes from the provider.',
    }

    const ZH = {
      'context.aria': '上下文已用 {percent}',
      'context.panel': '上下文用量',
      'context.system': '系统提示词',
      'context.tools': '工具定义',
      'context.messages': '对话消息',
      'context.skills': '技能',
      'context.count': '{count} 项',
      'context.countOne': '1 项',
      'context.emptyTools': '上下文中没有工具定义',
      'context.emptySkills': '没有可用的技能',
      'context.note': '分类为启发式估算，上方总量来自提供方。',
    }

    /** Panel legend rows, in bar-segment order; each class carries the shared swatch/segment tint. */
    const ROWS = [
      { key: 'systemTokens', label: 'context.system', color: 'dsl-ctx-colorSystem' },
      { key: 'toolsTokens', label: 'context.tools', color: 'dsl-ctx-colorTools' },
      { key: 'messageTokens', label: 'context.messages', color: 'dsl-ctx-colorMessages' },
    ]

    /** Detail sections, in report order. */
    const SECTIONS = [
      { key: 'tools', heading: 'context.tools', empty: 'context.emptyTools', total: 'toolsTotal' },
      { key: 'skills', heading: 'context.skills', empty: 'context.emptySkills', total: 'skillsTotal' },
    ]

    /**
     * Fallback translate for a Client without the locale service; keeps the panel
     * readable instead of throwing on an absent `t` seat.
     * @param t - the framework-provided translate, when present.
     * @returns a translate function for this namespace.
     */
    function translateOf(t) {
      if (typeof t === 'function') return t
      return (key, params) => {
        if (key === 'number.thousand') return `${params?.value ?? ''}K`
        if (key === 'number.million') return `${params?.value ?? ''}M`
        const template = EN[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
      }
    }

    /**
     * Item-count phrase for a section header, with a one-item form.
     * @param count - number of rows.
     * @param t - translate function.
     * @returns the localized count phrase.
     */
    function countText(count, t) {
      return count === 1 ? t('context.countOne') : t('context.count', { count: String(count) })
    }

    /**
     * Format a token count the way the shipped panel does.
     * @param value - non-negative token count.
     * @param t - translate function carrying the shared compact-number templates.
     * @returns a compact localized count.
     */
    function formatTokens(value, t) {
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1e3) return String(value)
      if (value < 1e6) return t('number.thousand', { value: scaled(value / 1e3) })
      return t('number.million', { value: scaled(value / 1e6) })
    }

    /**
     * Bar segments in grid order: categories scaled to their share of the bar,
     * or one neutral track before any breakdown exists.
     * @param breakdown - heuristic composition, or undefined.
     * @param breakdownTotal - sum of its three figures.
     * @param percent - whole percent of the window in use.
     * @returns the ordered segments.
     */
    function segmentsOf(breakdown, breakdownTotal, percent) {
      if (breakdown === undefined || breakdownTotal === 0) return [{ key: 'total', color: undefined, width: percent }]
      return ROWS.map((row) => ({
        key: row.key,
        color: row.color,
        width: (percent * breakdown[row.key]) / breakdownTotal,
      })).filter((segment) => segment.width > 0)
    }

    /**
     * One detail section: its heading, item count, subtotal, and scrollable rows.
     * @param definition - which section to render.
     * @param details - Host projection value, or undefined.
     * @param t - translate function.
     * @returns the section element.
     */
    function detailSection(definition, details, t) {
      const items = details === undefined ? [] : details[definition.key]
      const total = details === undefined ? 0 : details[definition.total]
      return h(
        'section',
        { className: 'dsl-ctx-section', key: definition.key },
        h(
          'div',
          { className: 'dsl-ctx-sectionHead' },
          h('span', { className: 'dsl-ctx-sectionTitle' }, t(definition.heading)),
          h('span', { className: 'dsl-ctx-count' }, countText(items.length, t)),
          items.length === 0 ? null : h('span', { className: 'dsl-ctx-total' }, `~${formatTokens(total, t)}`),
        ),
        items.length === 0
          ? h('div', { className: 'dsl-ctx-empty' }, t(definition.empty))
          : h(
              'ul',
              { className: 'dsl-ctx-list', tabIndex: 0 },
              items.map((item, index) =>
                h(
                  'li',
                  { className: 'dsl-ctx-item', key: `${item.name}:${index}` },
                  h('span', { className: 'dsl-ctx-name', title: item.name }, item.name),
                  h('span', { className: 'dsl-ctx-tokens' }, item.tokens.toLocaleString()),
                ),
              ),
            ),
      )
    }

    /**
     * Composer context meter: the shipped ring and percentage, opening a panel
     * that keeps the aggregate composition and appends per-tool and per-skill
     * token estimates. Renders nothing until a provider reports both pressure
     * and a route capacity.
     * @param props - slot props: projection reader and locale seat.
     * @returns the meter element, or null while occupancy is unknown.
     */
    function ContextDetailsMeter(props) {
      const useProjection = props.useProjection
      const t = translateOf(props.t)
      const pressure = useProjection('contextPressure')
      const breakdown = useProjection('contextBreakdown')
      const details = useProjection('contextDetails')
      const [open, setOpen] = React.useState(false)
      const [placement, setPlacement] = React.useState(null)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
      const contextWindow = pressure?.contextWindow
      const available = typeof usedTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0
      // List lengths, not projection identities, decide the panel's height.
      const toolsCount = details === undefined ? 0 : details.tools.length
      const skillsCount = details === undefined ? 0 : details.skills.length

      React.useEffect(() => {
        if (available) return
        setOpen(false)
      }, [available])

      React.useEffect(() => {
        if (!open) return undefined
        const closeIfOutside = (event) => {
          if (rootRef.current?.contains(event.target)) return
          if (panelRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const closeOnEscape = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false)
        }
        // Pointer dismissal for the mouse, click dismissal for keyboard-activated
        // controls elsewhere in the dock, Escape for both.
        document.addEventListener('pointerdown', closeIfOutside, true)
        document.addEventListener('click', closeIfOutside, true)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
          document.removeEventListener('pointerdown', closeIfOutside, true)
          document.removeEventListener('click', closeIfOutside, true)
          document.removeEventListener('keydown', closeOnEscape)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const panel = panelRef.current
        panel?.focus({ preventScroll: true })
        return () => {
          const active = document.activeElement
          if (active === null || active === document.body || (panel !== null && panel.contains(active))) {
            triggerRef.current?.focus({ preventScroll: true })
          }
        }
      }, [open])

      React.useLayoutEffect(() => {
        if (!open) {
          setPlacement(null)
          return undefined
        }
        const place = () => {
          const trigger = triggerRef.current
          const panel = panelRef.current
          if (trigger === null || panel === null) return
          const anchor = trigger.getBoundingClientRect()
          const width = panel.offsetWidth
          const height = panel.offsetHeight
          const left = Math.min(
            Math.max(VIEWPORT_MARGIN, anchor.left + anchor.width / 2 - width / 2),
            Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - width),
          )
          const above = anchor.top - ANCHOR_GAP - height
          const below = anchor.bottom + ANCHOR_GAP
          const top = above >= VIEWPORT_MARGIN ? above : Math.min(below, window.innerHeight - VIEWPORT_MARGIN - height)
          setPlacement((current) =>
            current !== null && Math.abs(current.left - left) < 0.5 && Math.abs(current.top - top) < 0.5 ? current : { left, top },
          )
        }
        place()
        window.addEventListener('resize', place)
        document.addEventListener('scroll', place, true)
        // The composer grows and shrinks (multi-line input, mode row) without a
        // window resize, so follow the dock's own reflow while the panel is open.
        const dock = triggerRef.current?.closest(DOCK_SELECTOR) ?? null
        const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined
        if (watch !== undefined) {
          if (triggerRef.current !== null) watch.observe(triggerRef.current)
          const composerRoot = dock?.parentElement
          if (composerRoot !== null && composerRoot !== undefined) watch.observe(composerRoot)
        }
        return () => {
          window.removeEventListener('resize', place)
          document.removeEventListener('scroll', place, true)
          watch?.disconnect()
        }
      }, [open, toolsCount, skillsCount, details !== undefined, breakdown !== undefined])

      // Hides the shipped meter this entry replaces. Depends on `available` so it
      // re-arms when occupancy first appears: before that the component renders
      // null and the trigger this sweep anchors on does not exist yet.
      React.useEffect(() => {
        const hidden = []
        const hideShippedMeter = () => {
          const root = rootRef.current
          if (root === null) return
          // Only touch this meter's own composer; another dock belongs to another view.
          const dock = root.closest(DOCK_SELECTOR)
          if (dock === null) return
          for (const button of dock.querySelectorAll(DIALOG_TRIGGER_SELECTOR)) {
            if (button.hasAttribute(OWN_TRIGGER_ATTRIBUTE)) continue
            // The shipped trigger reads as a bare percentage in every locale: its
            // text is "<n>%" whether or not the localization keeps the phrase.
            if (!/^\d+%$/.test((button.textContent ?? '').trim())) continue
            let holder = button
            while (holder.parentElement !== null && holder.parentElement !== dock) holder = holder.parentElement
            if (holder.parentElement !== dock) continue
            // A slot outlet anchor (data-slot) holds every dock entry; never hide it.
            if (holder.hasAttribute('data-slot')) continue
            // A container with other controls is not the shipped trigger's own box.
            if (holder.querySelectorAll('button, input, select, textarea, a[href]').length > 1) continue
            if (holder.contains(root)) continue
            if (hidden.some((row) => row.element === holder)) continue
            hidden.push({ element: holder, display: holder.style.display })
            holder.style.display = 'none'
          }
        }
        hideShippedMeter()
        const dock = rootRef.current?.closest(DOCK_SELECTOR) ?? null
        if (dock === null) return undefined
        const observer = new MutationObserver(hideShippedMeter)
        observer.observe(dock, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          for (const row of hidden) row.element.style.display = row.display
        }
      }, [available])

      if (!available) return null

      const percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100))
      const reading = `${percent}%`
      const ariaLabel = t('context.aria', { percent: reading })
      const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT }).split(READING_SLOT).map((part) => part.trim())
      const breakdownTotal = breakdown === undefined ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
      const segments = segmentsOf(breakdown, breakdownTotal, percent)

      const panel = open
        ? reactDom.createPortal(
            h(
              'div',
              {
                ref: panelRef,
                className: 'dsl-ctx-panel',
                style: placement === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: placement.left, top: placement.top },
                role: 'dialog',
                tabIndex: -1,
                'aria-label': t('context.panel'),
              },
              h(
                'div',
                { className: 'dsl-ctx-header' },
                h('span', { className: 'dsl-ctx-headline' }, headBefore),
                h('span', { className: 'dsl-ctx-percent' }, reading),
                h('span', { className: 'dsl-ctx-headline' }, headAfter),
                h('span', { className: 'dsl-ctx-figures' }, `~${formatTokens(usedTokens, t)} / ${formatTokens(contextWindow, t)}`),
              ),
              h(
                'div',
                { className: 'dsl-ctx-bar' },
                segments.map((segment) =>
                  h('div', {
                    key: segment.key,
                    className: segment.color === undefined ? 'dsl-ctx-segment' : `dsl-ctx-segment ${segment.color}`,
                    style: { width: `${segment.width}%` },
                  }),
                ),
              ),
              breakdown === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsl-ctx-rows' },
                    h(
                      'dl',
                      null,
                      ROWS.map((row) =>
                        h(
                          'div',
                          { className: 'dsl-ctx-row', key: row.key },
                          h(
                            'dt',
                            null,
                            h('span', { className: `dsl-ctx-swatch ${row.color}`, 'aria-hidden': true }),
                            t(row.label),
                          ),
                          h('dd', null, `~${formatTokens(breakdown[row.key], t)}`),
                        ),
                      ),
                    ),
                    // The composition is a heuristic; the header figure is the
                    // provider-reported pressure, so the two do not reconcile.
                    h('p', { className: 'dsl-ctx-note' }, t('context.note')),
                  ),
              details === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsl-ctx-sections' },
                    SECTIONS.map((definition) => detailSection(definition, details, t)),
                  ),
            ),
            document.body,
          )
        : null

      return h(
        'span',
        { ref: rootRef, className: 'dsl-ctx-root' },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'dsl-ctx-trigger',
            'aria-label': ariaLabel,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            [OWN_TRIGGER_ATTRIBUTE]: '',
            title: ariaLabel,
            onClick: () => setOpen((value) => !value),
          },
          h(
            'svg',
            { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': true },
            h('circle', { className: 'dsl-ctx-track', cx: '7', cy: '7', r: RADIUS }),
            h('circle', {
              className: 'dsl-ctx-fill',
              cx: '7',
              cy: '7',
              r: RADIUS,
              strokeDasharray: `${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`,
              transform: 'rotate(-90 7 7)',
            }),
          ),
          h('span', null, reading),
        ),
        panel,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'context-details: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@pedropaulovc/dsh-context-details'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'context-details: styles')
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'context-details',
              order: 50,
              locale: NS,
            },
            ContextDetailsMeter,
          ),
        )
      },
    }
  },
})
