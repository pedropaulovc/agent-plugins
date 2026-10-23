/**
 * Host half of the composer context-details bundle.
 *
 * Publishes one client-visible session projection, `contextDetails`, carrying
 * heuristic token estimates for every model-visible tool schema and every skill
 * in the latest available-skills catalog. Both lists are priced with the same
 * four-characters-per-token heuristic the aggregate `contextBreakdown` uses, so
 * the per-item figures can be compared with — and the tool list reconciles
 * exactly to — the aggregate `Tool definitions` figure.
 *
 * Everything here derives from the durable session log: the tool schemas from
 * the newest `request/header`, and the skills from the newest `user/message`
 * whose source is the skill catalog. No model calls, no extra session events.
 *
 * The projection declares its shape through a local `parse()`-only schema: the
 * registry needs no more than that, and a profile-linked bundle must not depend
 * on a Host package resolving from its checkout.
 *
 * @module @pedropaulovc/dsh-context-details
 */
export const name = '@pedropaulovc/dsh-context-details'

/** The registry is the only Host service this bundle consumes. */
export const inject = ['sessionProjections']

/** Fixed text density the meter uses for every heuristic price. */
const CHARS_PER_TOKEN = 4

/** JSON framing overhead the aggregate tool-schema price adds once per request. */
const HEADER_OVERHEAD = 4

/** Fallback label for a tool schema whose name is absent or malformed. */
const UNNAMED_TOOL = '(unnamed)'

/** Exact key sets the projection state and its client view may carry. */
const TOKEN_DETAIL_KEYS = ['name', 'tokens']
const CONTEXT_DETAILS_KEYS = ['tools', 'toolsTotal', 'skills', 'skillsTotal', 'catalogSeq']

/**
 * Reject an unexpected key rather than silently carrying it into a checkpoint.
 * @param value - object being validated.
 * @param allowed - exact permitted key set.
 * @param where - label used in the failure message.
 */
function rejectUnknownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    throw new Error(`${where}: unknown key "${key}"`)
  }
}

/**
 * Validate one non-negative integer token figure.
 * @param value - candidate figure.
 * @param where - label used in the failure message.
 * @returns the figure, unchanged.
 */
function parseCount(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${where} must be a non-negative integer`)
  return value
}

/**
 * Validate one `{ name, tokens }` row.
 * @param value - candidate row.
 * @param where - label used in the failure message.
 * @returns a normalized copy of the row.
 */
function parseTokenDetail(value, where) {
  if (typeof value !== 'object' || value === null) throw new Error(`${where} must be an object`)
  rejectUnknownKeys(value, TOKEN_DETAIL_KEYS, where)
  if (typeof value.name !== 'string') throw new Error(`${where}.name must be a string`)
  return { name: value.name, tokens: parseCount(value.tokens, `${where}.tokens`) }
}

/**
 * Validate one detail list.
 * @param value - candidate list.
 * @param where - label used in the failure message.
 * @returns a normalized copy of the list.
 */
function parseTokenDetails(value, where) {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value.map((detail, index) => parseTokenDetail(detail, `${where}[${index}]`))
}

/** The projection state schema and client view schema; the registry only parses it. */
const contextDetailsSchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null) throw new Error('contextDetails must be an object')
    rejectUnknownKeys(value, CONTEXT_DETAILS_KEYS, 'contextDetails')
    return {
      tools: parseTokenDetails(value.tools, 'contextDetails.tools'),
      toolsTotal: parseCount(value.toolsTotal, 'contextDetails.toolsTotal'),
      skills: parseTokenDetails(value.skills, 'contextDetails.skills'),
      skillsTotal: parseCount(value.skillsTotal, 'contextDetails.skillsTotal'),
      ...(value.catalogSeq === undefined ? {} : { catalogSeq: parseCount(value.catalogSeq, 'contextDetails.catalogSeq') }),
    }
  },
}

/** The value before any request or skill catalog reached the log. */
function emptyDetails() {
  return { tools: [], toolsTotal: 0, skills: [], skillsTotal: 0 }
}

/**
 * Escape model-facing prose exactly as the skill catalog frame does, so a priced
 * line matches the characters the model actually reads.
 * @param value - raw skill description.
 * @returns the escaped description.
 */
function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Price one skill catalog entry by the exact bullet line it renders as.
 * @param entry - catalog entry with a validated name and description.
 * @returns heuristic tokens for that entry.
 */
function skillTokens(entry) {
  return Math.ceil(`- \`${entry.name}\`: ${escapeText(entry.description)}`.length / CHARS_PER_TOKEN)
}

/**
 * Split a token budget across weights with the largest-remainder method, so the
 * per-item figures sum to the aggregate price instead of drifting from rounding.
 * @param total - tokens to distribute.
 * @param weights - non-negative item sizes.
 * @returns one integer share per weight, summing to `total`.
 */
function allocate(total, weights) {
  const sum = weights.reduce((running, weight) => running + weight, 0)
  if (sum <= 0) return weights.map(() => 0)
  const exact = weights.map((weight) => (total * weight) / sum)
  const shares = exact.map((value) => Math.floor(value))
  const remaining = total - shares.reduce((running, share) => running + share, 0)
  if (remaining <= 0) return shares
  const byRemainder = exact
    .map((value, index) => ({ index, fraction: value - shares[index], weight: weights[index] }))
    .sort((left, right) => right.fraction - left.fraction || right.weight - left.weight || left.index - right.index)
  for (let offset = 0; offset < remaining; offset++) shares[byRemainder[offset % byRemainder.length].index] += 1
  return shares
}

/** Largest first, then by name so equal prices keep a stable, readable order. */
function byLargest(left, right) {
  return right.tokens - left.tokens || left.name.localeCompare(right.name)
}

/**
 * Price every tool schema in one request envelope.
 * @param tools - the envelope's model-visible tool schemas.
 * @returns the sorted per-tool estimates and the aggregate they sum to.
 */
function priceTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools: [], toolsTotal: 0 }
  const serialized = tools.map((tool) => JSON.stringify(tool) ?? '')
  const total = Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + HEADER_OVERHEAD
  const shares = allocate(total, serialized.map((text) => text.length))
  const details = tools.map((tool, index) => ({
    name: typeof tool?.name === 'string' && tool.name !== '' ? tool.name : UNNAMED_TOOL,
    tokens: shares[index],
  }))
  return { tools: details.sort(byLargest), toolsTotal: total }
}

/**
 * Read the validated entries of one durable skill catalog record. Unreadable
 * records are ignored, mirroring the publishing plugin's own tolerance.
 * @param source - message source of the catalog record.
 * @returns the readable entries, or undefined when the record is not a catalog.
 */
function readCatalogEntries(source) {
  const entries = source?.entries
  if (!Array.isArray(entries)) return undefined
  const readable = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name: entryName, description } = entry
    if (typeof entryName !== 'string' || entryName === '' || typeof description !== 'string') return undefined
    readable.push({ name: entryName, description })
  }
  return readable
}

/**
 * Price every advertised skill of one catalog.
 * @param entries - validated catalog entries.
 * @returns the sorted per-skill estimates and their subtotal.
 */
function priceSkills(entries) {
  if (entries.length === 0) return { skills: [], skillsTotal: 0 }
  const details = entries.map((entry) => ({ name: entry.name, tokens: skillTokens(entry) }))
  const skillsTotal = details.reduce((running, detail) => running + detail.tokens, 0)
  return { skills: details.sort(byLargest), skillsTotal }
}

/**
 * Compare two sorted detail lists by name and price.
 * @param left - current list.
 * @param right - candidate list.
 * @returns whether they describe the same items.
 */
function sameDetails(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index].name !== right[index].name || left[index].tokens !== right[index].tokens) return false
  }
  return true
}

/**
 * Session projection folding per-tool and per-skill context costs. The state is
 * plain JSON and identical to the client view it serves, so an unchanged event
 * returns the same reference and republishes nothing.
 */
/**
 * Whether one event removed the catalog's surface node.
 *
 * A replacement's `sourceEventSeqs` must cite every surface node it shadows
 * (the Session append contract enforces this), so membership is the reliable
 * signal. Numeric endpoint comparison is not: the harness resolves endpoints by
 * surface index, so an older catalog replaced after later nodes can produce
 * `startSeq > endSeq`. That range comparison is only a fallback for a record
 * without sources, which a valid log does not produce.
 * @param state - projection state before the event.
 * @param event - committed session event.
 * @returns whether the catalog left the surface.
 */
function catalogRemoved(state, event) {
  const op = event.surfaceOp
  if (op === undefined || op === 'append' || state.catalogSeq === undefined) return false
  const sources = event.sourceEventSeqs
  if (Array.isArray(sources)) return sources.includes(state.catalogSeq)
  const low = Math.min(op.startSeq, op.endSeq)
  const high = Math.max(op.startSeq, op.endSeq)
  return low <= state.catalogSeq && state.catalogSeq <= high
}

export const contextDetailsProjection = {
  key: 'contextDetails',
  stateVersion: 1,
  stateSchema: contextDetailsSchema,
  init: () => emptyDetails(),
  apply: (state, event) => {
    // A replacement that drops the catalog from the surface stops its entries
    // counting until the next catalog arrives.
    let next = state
    if (catalogRemoved(next, event)) {
      next = { ...next, skills: [], skillsTotal: 0, catalogSeq: undefined }
    }
    if (event.type === 'request/header') {
      const priced = priceTools(event.data?.header?.tools)
      if (next.toolsTotal === priced.toolsTotal && sameDetails(next.tools, priced.tools)) return next
      return { ...next, tools: priced.tools, toolsTotal: priced.toolsTotal }
    }
    if (event.type !== 'user/message') return next
    if (event.data?.source?.kind !== 'skill-catalog') return next
    const entries = readCatalogEntries(event.data.source)
    if (entries === undefined) return next
    const priced = priceSkills(entries)
    if (next.skillsTotal === priced.skillsTotal && sameDetails(next.skills, priced.skills) && next.catalogSeq === event.seq) return next
    return { ...next, skills: priced.skills, skillsTotal: priced.skillsTotal, catalogSeq: event.seq }
  },
  wire: { viewSchema: contextDetailsSchema, view: (state) => state },
}

/**
 * Register the projection on the session-projection registry.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(contextDetailsProjection)
}
