/**
 * Contract tests for the context-details Host projection.
 *
 * The projection is a pure fold over durable session events, so these tests
 * drive it with synthetic envelopes and assert the invariants the context menu
 * depends on: the per-tool rows reconcile with the aggregate tool price, both
 * lists sort largest first, unchanged events keep the state reference, and a
 * surface replacement removes the catalog it covers.
 *
 * Run: node --test plugins/dsh-context-details/tests/context-details.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'

/** Register the projection on a fake registry and return its definition. */
function registeredProjection() {
  const definitions = []
  plugin.apply({ sessionProjections: { register: (definition) => definitions.push(definition) } })
  assert.equal(definitions.length, 1, 'apply registers exactly one projection')
  return definitions[0]
}

/** Build one request/header event carrying tool schemas. */
function headerEvent(tools, seq = 1) {
  return {
    type: 'request/header',
    seq,
    time: 0,
    data: { header: { config: { provider: 'p', model: 'm' }, ...(tools.length > 0 ? { tools } : {}) } },
  }
}

/** Build one skill-catalog user message event. */
function catalogEvent(entries, { seq = 2, surfaceOp } = {}) {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: {
      role: 'user',
      id: `m${seq}`,
      content: [{ type: 'text', text: 'catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries },
    },
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  }
}

/**
 * Build one non-catalog surface event carrying a replace intent.
 * @param sourceEventSeqs - cited shadowed nodes, or undefined for a record without sources.
 */
function replaceEvent(type, seq, startSeq, endSeq, sourceEventSeqs) {
  return {
    type,
    seq,
    time: 0,
    data: { turn: 1, step: 1, message: { role: 'system', id: `m${seq}`, content: [], source: { kind: 'system-prompt' } } },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

const TOOLS = [
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'edit', description: 'Edit a file with a considerably longer description.', parameters: { type: 'object' } },
  { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
]

const CATALOG = [
  { name: 'review', description: 'Review the current change.' },
  { name: 'agent-experience', description: 'When writing or changing a model-facing tool definition, plus skills and workflows.' },
]

/** Expected per-skill rows: priced by the rendered line, largest first. */
const EXPECTED_SKILLS = CATALOG.map((entry) => ({
  name: entry.name,
  tokens: Math.ceil(`- \`${entry.name}\`: ${entry.description}`.length / 4),
})).sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name))

/** Aggregate tool price the shipped breakdown publishes for one envelope. */
function aggregateTools(tools) {
  return tools.length === 0 ? 0 : Math.ceil(JSON.stringify(tools).length / 4) + 4
}

test('registers one client-visible projection with a strict plain-JSON state', () => {
  const definition = registeredProjection()
  assert.equal(definition.key, 'contextDetails')
  assert.equal(definition.stateVersion, 1)

  const state = definition.init({}, 0)
  assert.deepEqual(state, { tools: [], toolsTotal: 0, skills: [], skillsTotal: 0 })
  assert.equal(definition.wire.view(state), state, 'the view returns the state reference')
  assert.doesNotThrow(() => definition.stateSchema.parse(state))
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(state))
  assert.throws(() => definition.stateSchema.parse({ ...state, extra: 1 }), /unknown key/)
  assert.throws(() => definition.stateSchema.parse({ ...state, toolsTotal: -1 }), /non-negative/)
  assert.throws(() => definition.wire.viewSchema.parse({ ...state, tools: [{ name: 'x', tokens: 1.5 }] }), /non-negative/)
})

test('prices tools by the aggregate formula and reconciles every row with it', () => {
  const definition = registeredProjection()
  const priced = definition.apply(definition.init({}, 0), headerEvent(TOOLS))

  assert.equal(priced.toolsTotal, aggregateTools(TOOLS))
  assert.equal(priced.tools.reduce((sum, item) => sum + item.tokens, 0), priced.toolsTotal, 'rows sum to the aggregate')
  assert.equal(priced.tools.length, TOOLS.length)
  assert.deepEqual(priced.tools.map((item) => item.name).sort(), ['bash', 'edit', 'read'])
  for (let index = 1; index < priced.tools.length; index++) {
    assert.ok(priced.tools[index - 1].tokens >= priced.tools[index].tokens, 'tools sort largest first')
  }
  assert.doesNotThrow(() => definition.stateSchema.parse(priced))
})

test('clears the tool detail for an empty envelope', () => {
  const definition = registeredProjection()
  const priced = definition.apply(definition.init({}, 0), headerEvent(TOOLS))
  const cleared = definition.apply(priced, headerEvent([]))
  assert.deepEqual([cleared.tools, cleared.toolsTotal], [[], 0])
})

test('keeps the state reference for repeated and unrelated events', () => {
  const definition = registeredProjection()
  const priced = definition.apply(definition.init({}, 0), headerEvent(TOOLS))
  assert.equal(definition.apply(priced, headerEvent(TOOLS)), priced, 'an identical envelope keeps the reference')
  assert.equal(definition.apply(priced, { type: 'turn/start', seq: 3, time: 0, data: { turn: 1 } }), priced)
  assert.equal(
    definition.apply(priced, { type: 'user/message', seq: 4, time: 0, data: { role: 'user', source: { kind: 'user' }, content: [] } }),
    priced,
  )
})

test('prices skills by their rendered catalog line', () => {
  const definition = registeredProjection()
  const withTools = definition.apply(definition.init({}, 0), headerEvent(TOOLS))
  const priced = definition.apply(withTools, catalogEvent(CATALOG, { seq: 2 }))

  assert.notEqual(priced, withTools, 'a catalog changes the state')
  assert.deepEqual(priced.skills, EXPECTED_SKILLS)
  assert.equal(priced.skillsTotal, EXPECTED_SKILLS.reduce((sum, item) => sum + item.tokens, 0))
  assert.equal(priced.catalogSeq, 2, 'the newest catalog sequence is tracked')
  assert.equal(priced.tools, withTools.tools, 'pricing skills does not reprice tools')

  const escaped = definition.apply(priced, catalogEvent([{ name: 'tags', description: 'Match <html> & entities.' }], { seq: 5 }))
  assert.equal(escaped.skills[0].tokens, Math.ceil('- `tags`: Match &lt;html&gt; &amp; entities.'.length / 4))
})

test('follows surface replacements of the skill catalog', () => {
  const definition = registeredProjection()
  const withTools = definition.apply(definition.init({}, 0), headerEvent(TOOLS))
  const catalogued = definition.apply(withTools, catalogEvent(CATALOG, { seq: 2 }))

  assert.equal(
    definition.apply(catalogued, replaceEvent('system/message', 6, 4, 5, [4, 5])),
    catalogued,
    'a replacement that does not cite the catalog keeps the reference',
  )

  const replaced = definition.apply(catalogued, replaceEvent('system/message', 7, 1, 3, [1, 2, 3]))
  assert.deepEqual([replaced.skills, replaced.skillsTotal, replaced.catalogSeq], [[], 0, undefined], 'a citing replacement clears the rows')
  assert.equal(replaced.tools, catalogued.tools, 'clearing skills leaves the priced tools untouched')

  const republished = definition.apply(replaced, catalogEvent(CATALOG, { seq: 9 }))
  assert.equal(republished.catalogSeq, 9)
  assert.deepEqual(republished.skills, EXPECTED_SKILLS)

  const updated = definition.apply(
    republished,
    catalogEvent([{ name: 'fresh', description: 'A brand new catalog.' }], { seq: 11, surfaceOp: { op: 'replace', startSeq: 8, endSeq: 10 } }),
  )
  assert.deepEqual(updated.skills.map((item) => item.name), ['fresh'], 'a replacing update publishes its own entries')
  assert.equal(updated.catalogSeq, 11)
})

test('clears the catalog by surface membership, not numeric endpoints', () => {
  const definition = registeredProjection()
  const withTools = definition.apply(definition.init({}, 0), headerEvent(TOOLS))
  const catalogued = definition.apply(withTools, catalogEvent(CATALOG, { seq: 2 }))

  // Surface order, not sequence order, defines a replacement range: the start
  // node can carry a higher seq than the end node.
  const inverted = definition.apply(catalogued, replaceEvent('system/message', 12, 10, 4, [10, 6, 2, 4]))
  assert.deepEqual([inverted.skills, inverted.catalogSeq], [[], undefined], 'a citation that includes the catalog clears it even when startSeq > endSeq')

  // The same inverted endpoints that do not cite the catalog must leave it in place.
  const uninvolved = definition.apply(catalogued, replaceEvent('system/message', 12, 10, 4, [10, 6, 4]))
  assert.equal(uninvolved, catalogued, 'an inverted range between other nodes keeps the catalog')

  // A record without sources falls back to the positional range.
  const uncited = definition.apply(catalogued, replaceEvent('system/message', 12, 4, 1))
  assert.deepEqual([uncited.skills, uncited.catalogSeq], [[], undefined], 'the fallback still clears a numeric range that covers the catalog')
})

test('ignores unreadable catalog records', () => {
  const definition = registeredProjection()
  const catalogued = definition.apply(definition.init({}, 0), catalogEvent(CATALOG, { seq: 2 }))
  assert.equal(definition.apply(catalogued, catalogEvent([{ name: '', description: 'broken' }], { seq: 5 })), catalogued)
  assert.equal(definition.apply(catalogued, catalogEvent([{ name: 'ok' }], { seq: 6 })), catalogued)
  assert.equal(definition.apply(catalogued, { type: 'user/message', seq: 7, time: 0, data: { role: 'user', content: [], source: { kind: 'user' } } }), catalogued)
})

test('distributes rounding across many tools without losing tokens', () => {
  const definition = registeredProjection()
  const many = Array.from({ length: 37 }, (_, index) => ({
    name: `tool-${index}`,
    description: 'x'.repeat(17 + index * 7),
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
  }))
  const priced = definition.apply(definition.init({}, 0), headerEvent(many))
  assert.equal(priced.toolsTotal, aggregateTools(many))
  assert.equal(priced.tools.reduce((sum, item) => sum + item.tokens, 0), priced.toolsTotal)
  assert.equal(priced.tools.length, many.length)
})
