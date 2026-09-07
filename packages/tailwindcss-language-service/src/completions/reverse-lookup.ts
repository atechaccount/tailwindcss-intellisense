import { CompletionItemKind, type CompletionList, type Range } from 'vscode-languageserver'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import escapeClassName from 'css.escape'
import * as culori from 'culori'
import { fromPostCSSAst, type AstNode } from '../css'
import { getVariantsFromClassName } from '../util/getVariantsFromClassName'
import * as jit from '../util/jit'
import { naturalExpand } from '../util/naturalExpand'
import { addPixelEquivalentsToValue } from '../util/pixelEquivalents'
import {
  evaluateExpression,
  inlineThemeValues,
  replaceCssCalc,
  replaceCssVars,
} from '../util/rewriting'
import { segment } from '../util/segment'
import * as semver from '../util/semver'
import type { State } from '../util/state'

type ValueKind = 'length' | 'number' | 'color' | 'keyword' | 'line-height'

interface Property {
  roots: string[]
  kind: ValueKind
  negative?: boolean
}

// These are utility *families*, not a table of CSS values. Values are read from
// the active project's compiler so custom theme values and disabled utilities
// are respected. Restricting the search avoids compiling every utility on the
// first keystroke, and keeps CSS properties distinct from variants like hover:.
const properties: Record<string, Property> = {
  width: { roots: ['w'], kind: 'length' },
  height: { roots: ['h'], kind: 'length' },
  'min-width': { roots: ['min-w'], kind: 'length' },
  'max-width': { roots: ['max-w'], kind: 'length' },
  'min-height': { roots: ['min-h'], kind: 'length' },
  'max-height': { roots: ['max-h'], kind: 'length' },
  padding: { roots: ['p'], kind: 'length' },
  'padding-top': { roots: ['pt'], kind: 'length' },
  'padding-right': { roots: ['pr'], kind: 'length' },
  'padding-bottom': { roots: ['pb'], kind: 'length' },
  'padding-left': { roots: ['pl'], kind: 'length' },
  margin: { roots: ['m'], kind: 'length', negative: true },
  'margin-top': { roots: ['mt'], kind: 'length', negative: true },
  'margin-right': { roots: ['mr'], kind: 'length', negative: true },
  'margin-bottom': { roots: ['mb'], kind: 'length', negative: true },
  'margin-left': { roots: ['ml'], kind: 'length', negative: true },
  top: { roots: ['top'], kind: 'length', negative: true },
  right: { roots: ['right'], kind: 'length', negative: true },
  bottom: { roots: ['bottom'], kind: 'length', negative: true },
  left: { roots: ['left'], kind: 'length', negative: true },
  inset: { roots: ['inset'], kind: 'length', negative: true },
  gap: { roots: ['gap'], kind: 'length' },
  'row-gap': { roots: ['gap-y'], kind: 'length' },
  'column-gap': { roots: ['gap-x'], kind: 'length' },
  'border-radius': { roots: ['rounded'], kind: 'length' },
  'font-size': { roots: ['text'], kind: 'length' },
  'letter-spacing': { roots: ['tracking'], kind: 'length', negative: true },
  'line-height': { roots: ['leading'], kind: 'line-height' },
  'font-weight': { roots: ['font'], kind: 'number' },
  'z-index': { roots: ['z'], kind: 'number', negative: true },
  order: { roots: ['order'], kind: 'number', negative: true },
  opacity: { roots: ['opacity'], kind: 'number' },
  'flex-grow': { roots: ['grow', 'flex-grow'], kind: 'number' },
  'flex-shrink': { roots: ['shrink', 'flex-shrink'], kind: 'number' },
  'flex-basis': { roots: ['basis'], kind: 'length' },
  color: { roots: ['text'], kind: 'color' },
  'background-color': { roots: ['bg'], kind: 'color' },
  'border-color': { roots: ['border'], kind: 'color' },
  'outline-color': { roots: ['outline'], kind: 'color' },
  'text-decoration-color': { roots: ['decoration'], kind: 'color' },
  display: {
    roots: [
      'block',
      'inline',
      'flex',
      'table',
      'flow-root',
      'grid',
      'contents',
      'list-item',
      'hidden',
    ],
    kind: 'keyword',
  },
  position: { roots: ['static', 'fixed', 'absolute', 'relative', 'sticky'], kind: 'keyword' },
  visibility: { roots: ['visible', 'invisible', 'collapse'], kind: 'keyword' },
  overflow: { roots: ['overflow'], kind: 'keyword' },
  'overflow-x': { roots: ['overflow-x'], kind: 'keyword' },
  'overflow-y': { roots: ['overflow-y'], kind: 'keyword' },
  'box-sizing': { roots: ['box'], kind: 'keyword' },
  'text-align': { roots: ['text'], kind: 'keyword' },
  'align-items': { roots: ['items'], kind: 'keyword' },
  'justify-content': { roots: ['justify'], kind: 'keyword' },
  'flex-direction': { roots: ['flex'], kind: 'keyword' },
  'flex-wrap': { roots: ['flex'], kind: 'keyword' },
}

const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/
const DIMENSION = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z]+|%)?$/i
const LENGTH_UNIT =
  /^(?:px|rem|em|ex|ch|cap|ic|lh|rlh|cm|mm|q|in|pt|pc|[sld]?v[whib]|[sld]?vmin|[sld]?vmax|cq[whib]|cqmin|cqmax|%)$/i
const MAX_RESULTS = 50

interface Query {
  text: string
  property: string
  value: string
  variants: string[]
}

interface Candidate {
  className: string
  value: string
  important: boolean
}

interface Cache {
  classList: State['classList']
  designSystem: State['designSystem']
  jitContext: State['jitContext']
  properties: Map<string, Candidate[]>
}

// Project rebuilds replace the class list / compiler context. Keeping those
// identities in the cache prevents theme edits from producing stale matches.
// Values stay in CSS units so rootFontSize can differ per document/request.
const caches = new WeakMap<State, Cache>()

function parseQuery(state: State, classList: string): Query | null {
  // Queries intentionally stay on one line and contain one scalar value. Do not
  // swallow neighboring classes, arbitrary classes, or a CSS block.
  let line = classList.slice(classList.lastIndexOf('\n') + 1)
  let match = /(?:^|[\t ])(\S+?)(?:[\t ]*:[\t ]*|[\t ]+)([^\s:;{}[\]"'`\\!]*);?$/.exec(line)
  if (!match) return null

  let parts = segment(match[1], state.separator)
  let property = parts.pop().toLowerCase()
  if (!Object.hasOwn(properties, property)) return null

  let before = parts.length > 0 ? parts.join(state.separator) + state.separator : ''
  if (before && getVariantsFromClassName(state, before).offset !== before.length) return null

  let prefix = state.v4 ? state.designSystem.theme.prefix : null
  if (prefix && parts.includes(prefix)) {
    if (parts[0] !== prefix) return null
    parts.shift()
  }

  let value = match[2]
  if (properties[property].kind === 'length' && NUMBER.test(value)) value += 'px'

  return { text: match[0].trimStart(), property, value, variants: parts }
}

function withVariants(state: State, className: string, variants: string[] = []): string {
  let prefix = state.v4 ? state.designSystem.theme.prefix : null
  return [...(prefix ? [prefix] : []), ...variants, className].join(state.separator)
}

function compile(state: State, className: string): AstNode[] {
  try {
    if (state.v4) return state.designSystem.compile([className])[0]
    return fromPostCSSAst(jit.generateRules(state, [className]).root)
  } catch {
    // A failing plugin utility should not break the other lookup results.
    return []
  }
}

function candidateFor(state: State, className: string, property: string): Candidate | null {
  let fullClassName = withVariants(state, className)
  let nodes = compile(state, fullClassName).filter(
    (node) => node.kind !== 'comment' && !(node.kind === 'at-rule' && node.name === '@property'),
  )

  // Only suggest a utility as an equivalent if it has a single, unconditional
  // effect. For example, text-base sets a line height too, and size-10 changes
  // height as well as width. Neither is an exact match for just one declaration.
  if (nodes.length !== 1 || nodes[0].kind !== 'rule') return null
  let rule = nodes[0]
  let selector = `.${escapeClassName(fullClassName)}`
  let importantScope = !state.v4 && state.config?.important
  if (
    rule.selector !== selector &&
    !(
      typeof importantScope === 'string' &&
      (rule.selector === `${importantScope} ${selector}` ||
        rule.selector === `${importantScope} :is(${selector})`)
    )
  ) {
    return null
  }
  if (rule.nodes.some((node) => node.kind !== 'declaration' && node.kind !== 'comment')) return null

  let declarations = rule.nodes.filter((node) => node.kind === 'declaration')
  let effects = declarations.filter((node) => !node.property.startsWith('--tw-'))
  if (effects.length !== 1 || effects[0].property !== property || !effects[0].value) return null

  let variables = new Map(declarations.map((node) => [node.property, node.value]))
  let value = replaceCssVars(effects[0].value, {
    replace: ({ name }) => variables.get(name) ?? null,
  })
  value = inlineThemeValues(value, state)
  value = replaceCssCalc(value, (expr) => evaluateExpression(expr.value))

  return { className, value: value.trim(), important: effects[0].important }
}

function candidatesFor(state: State, property: string): Candidate[] {
  let cache = caches.get(state)
  if (
    !cache ||
    cache.classList !== state.classList ||
    cache.designSystem !== state.designSystem ||
    cache.jitContext !== state.jitContext
  ) {
    cache = {
      classList: state.classList,
      designSystem: state.designSystem,
      jitContext: state.jitContext,
      properties: new Map(),
    }
    caches.set(state, cache)
  }

  let candidates = cache.properties.get(property)
  if (candidates) return candidates

  let prefix = state.v4 ? '' : state.config?.prefix ?? ''
  candidates = []
  for (let [className] of state.classList) {
    let name = className.replace(/^-/, '')
    if (!name.startsWith(prefix)) continue
    name = name.slice(prefix.length)
    if (!properties[property].roots.some((root) => name === root || name.startsWith(`${root}-`))) {
      continue
    }
    let candidate = candidateFor(state, className, property)
    if (candidate) candidates.push(candidate)
  }

  cache.properties.set(property, candidates)
  return candidates
}

function normalize(value: string, property: string, rootFontSize: number): string {
  if (properties[property].kind === 'color') {
    let color = culori.parse(value)
    if (color) {
      let rgb = culori.converter('rgb')(color)
      return [rgb.r ?? 0, rgb.g ?? 0, rgb.b ?? 0, rgb.alpha ?? 1]
        .map((part) => part.toFixed(6))
        .join(',')
    }
  }

  if (property === 'font-weight') {
    if (value.toLowerCase() === 'normal') value = '400'
    if (value.toLowerCase() === 'bold') value = '700'
  }

  let dimension = DIMENSION.exec(value)
  if (dimension) {
    let number = Number(dimension[1])
    let unit = (dimension[2] ?? '').toLowerCase()
    if (unit === 'rem') {
      number *= rootFontSize
      unit = 'px'
    }
    if (number === 0 && unit === '' && properties[property].kind === 'length') unit = 'px'
    if (property === 'opacity' && unit === '%') {
      number /= 100
      unit = ''
    }
    return `${Number(number.toPrecision(15))}${unit}`
  }

  // CSS keywords are case-insensitive; custom property names are not.
  return value.includes('(') ? value : value.toLowerCase()
}

function canUseArbitraryValue(property: string, value: string): boolean {
  if (/^(?:inherit|initial|unset|revert|revert-layer)$/.test(value)) return true
  if (/^var\(--[\w-]+\)$/.test(value)) return true

  let spec = properties[property]
  if (spec.kind === 'color') return Boolean(culori.parse(value))

  let dimension = DIMENSION.exec(value)
  if (!dimension || (!spec.negative && Number(dimension[1]) < 0)) return false
  let unit = dimension[2] ?? ''

  if (spec.kind === 'length') return LENGTH_UNIT.test(unit)
  if (spec.kind === 'line-height') return unit === '' || LENGTH_UNIT.test(unit)
  if (spec.kind === 'number') {
    if (property === 'z-index' || property === 'order') {
      return unit === '' && Number.isInteger(Number(dimension[1]))
    }
    return unit === '' || (property === 'opacity' && unit === '%')
  }
  return false
}

export function provideReverseLookupCompletions(
  state: State,
  classList: string,
  range: Range,
  rootFontSize: number,
  showPixelEquivalents = true,
  document?: TextDocument,
): CompletionList | null {
  if (
    !state.classList ||
    (!state.v4 && (!state.jit || !state.version || !semver.gte(state.version, '3.0.0')))
  ) {
    return null
  }

  let query = parseQuery(state, classList)
  if (!query) return null

  let filterText = query.text
  let end = { ...range.end }
  if (document) {
    // When completing in the middle of a value, include the rest of that value
    // in both the lookup and the edit. Otherwise width:40|px would insert w-10px.
    // Never consume a following class, string delimiter, or enclosing function.
    let after = document.getText({
      start: range.end,
      end: { line: range.end.line + 1, character: 0 },
    })
    let depth = [...query.value].reduce(
      (depth, c) => depth + (c === '(' ? 1 : c === ')' ? -1 : 0),
      0,
    )
    let suffix = ''
    for (let c of after) {
      if (!/[\w.%#,+()\-]/.test(c)) break
      if (c === ')' && depth === 0) break
      if (c === '(') depth++
      if (c === ')') depth--
      suffix += c
    }
    if (suffix) {
      query = parseQuery(state, classList + suffix)
      if (!query) return null
      end.character += suffix.length
    }
  }

  let queryValue = inlineThemeValues(query.value, state)
  queryValue = replaceCssCalc(queryValue, (expr) => evaluateExpression(expr.value))
  let target = normalize(queryValue, query.property, rootFontSize)
  let candidates = candidatesFor(state, query.property).filter((candidate) => {
    if (!query.value) return true
    let value = normalize(candidate.value, query.property, rootFontSize)
    return (
      value === target ||
      // Completing a keyword, e.g. display:fl → flex. Numeric searches are
      // exact: width:40 must not suggest a class that actually means 400px.
      (/^[a-z-]+$/i.test(query.value) && value.startsWith(target))
    )
  })

  function available(candidate: Candidate): boolean {
    let className = withVariants(state, candidate.className, query.variants)
    return (
      !state.blocklist?.includes(className) &&
      (query.variants.length === 0 || compile(state, className).length > 0)
    )
  }

  candidates = candidates.filter(available)

  if (candidates.length === 0 && canUseArbitraryValue(query.property, query.value)) {
    let prefix = state.v4 ? '' : state.config?.prefix ?? ''
    let names = [
      `${prefix}${properties[query.property].roots[0]}-[${query.value}]`,
      `[${query.property}:${query.value}]`,
    ]
    // Arbitrary properties, unlike utilities, do not take a v3 prefix.
    for (let name of names) {
      let candidate = candidateFor(state, name, query.property)
      if (!candidate || normalize(candidate.value, query.property, rootFontSize) !== target)
        continue
      if (!available(candidate)) continue
      candidates.push(candidate)
      break
    }
  }

  let replacementRange = {
    start: { line: end.line, character: end.character - query.text.length },
    end,
  }

  return {
    // Re-query the server as the CSS value changes, including after spaces.
    isIncomplete: true,
    items: candidates.slice(0, MAX_RESULTS).map((candidate, index) => {
      let className = withVariants(state, candidate.className, query.variants)
      let value = showPixelEquivalents
        ? addPixelEquivalentsToValue(candidate.value, rootFontSize)
        : candidate.value
      let detail = `${query.property}: ${value}${candidate.important ? ' !important' : ''};`
      return {
        label: className,
        kind: CompletionItemKind.Constant,
        detail,
        labelDetails: { description: detail },
        filterText,
        sortText: naturalExpand(index),
        textEdit: { range: replacementRange, newText: className },
        data: { ...state.completionItemData, className },
      }
    }),
  }
}
