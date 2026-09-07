import { describe, expect, test, vi } from 'vitest'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { TextEdit } from 'vscode-languageserver'
import escapeClassName from 'css.escape'
import { parse, type AstNode } from '../css'
import { completionsFromClassList, doComplete, resolveCompletionItem } from '../completionProvider'
import { createState, getDefaultTailwindSettings, type State } from '../util/state'
import { createDocument } from '../util/test-utils'
import { segment } from '../util/segment'
import { provideReverseLookupCompletions } from './reverse-lookup'

function project() {
  let utilities = new Map([
    ['w-0', 'width: 0px;'],
    ['w-8', 'width: 2rem;'],
    ['w-10', 'width: calc(var(--spacing) * 10);'],
    ['w-40', 'width: 10rem;'],
    ['w-card', 'width: 73px;'],
    ['w-full', 'width: 100%;'],
    ['w-em', 'width: 2.5em;'],
    ['w-side-effects', 'width: 40px; height: 40px;'],
    ['w-nested', 'width: 40px; &:hover { height: 40px; }'],
    ['p-4', 'padding: 1rem;'],
    ['-m-4', 'margin: -1rem;'],
    ['flex', 'display: flex;'],
    ['inline-flex', 'display: inline-flex;'],
    ['hidden', 'display: none;'],
    ['text-base', 'font-size: 1rem; line-height: 1.5rem;'],
    ['text-black', '--tw-text-opacity: 1; color: rgb(0 0 0 / var(--tw-text-opacity));'],
    ['bg-white', 'background-color: #fff;'],
    ['font-bold', 'font-weight: 700;'],
    ['opacity-50', 'opacity: 0.5;'],
    ['leading-normal', 'line-height: 1.5;'],
  ])

  let compile = vi.fn((classes: string[]): AstNode[][] =>
    classes.map((className) => {
      let base = segment(className, ':').pop()
      let css = utilities.get(base)
      let arbitrary = /^(w|p|m|text|bg|leading)-\[(.+)\]$/.exec(base)
      if (arbitrary) {
        let property = {
          w: 'width',
          p: 'padding',
          m: 'margin',
          text: 'font-size',
          bg: 'background-color',
          leading: 'line-height',
        }[arbitrary[1]]
        css = `${property}: ${arbitrary[2]};`
      }
      let property = /^\[([\w-]+):(.+)\]$/.exec(base)
      if (property) css = `${property[1]}: ${property[2]};`
      if (!css) return []
      return parse(`.${escapeClassName(className)} { ${css} }`)
    }),
  )
  let state = createState({
    v4: true,
    jit: true,
    version: '4.1.18',
    separator: ':',
    config: {},
    classList: Array.from(utilities.keys(), (name) => [name, { color: null }]),
    variants: [
      {
        name: 'hover',
        values: [],
        hasDash: false,
        isArbitrary: false,
        selectors: () => ['&:hover'],
      },
    ],
    designSystem: {
      theme: { entries: () => [] },
      compile,
      resolveThemeValue: (name) => (name === '--spacing' ? '0.25rem' : undefined),
      candidatesToCss: () => [null],
    } as unknown as State['designSystem'],
    completionItemData: { _projectKey: 'test-project' },
  })
  return { state, compile, utilities }
}

function complete(state: State, text: string, rootFontSize = 16) {
  return provideReverseLookupCompletions(
    state,
    text,
    { start: { line: 0, character: 12 }, end: { line: 0, character: 12 + text.length } },
    rootFontSize,
  )
}

function labels(state: State, text: string, rootFontSize = 16) {
  return complete(state, text, rootFontSize)?.items.map((item) => item.label)
}

describe('CSS reverse lookup', () => {
  test.each([
    'width:40px',
    'width: 40px',
    'width : 40px',
    'width 40px',
    'width 40',
    'width:40',
    'WIDTH:40px',
    'width:40px;',
  ])('recognizes %s', (text) => {
    let { state } = project()
    expect(labels(state, text)).toEqual(['w-10'])
  })

  test('replaces the entire query, uses the query for filtering, and includes CSS details', () => {
    let { state } = project()
    expect(complete(state, 'flex width: 40px')).toEqual({
      isIncomplete: true,
      items: [
        expect.objectContaining({
          label: 'w-10',
          detail: 'width: 2.5rem /* 40px */;',
          filterText: 'width: 40px',
          textEdit: {
            range: { start: { line: 0, character: 17 }, end: { line: 0, character: 28 } },
            newText: 'w-10',
          },
          data: { _projectKey: 'test-project', className: 'w-10' },
        }),
      ],
    })
  })

  test('handles a query on a later line without editing previous classes', () => {
    let { state } = project()
    let result = provideReverseLookupCompletions(
      state,
      'flex\n  width: 40px',
      {
        start: { line: 2, character: 8 },
        end: { line: 3, character: 13 },
      },
      16,
    )
    expect(result.items[0].textEdit).toEqual({
      range: { start: { line: 3, character: 2 }, end: { line: 3, character: 13 } },
      newText: 'w-10',
    })
  })

  test.each([
    ['padding:16px', 'p-4'],
    ['margin -16', '-m-4'],
    ['width:100%', 'w-full'],
    ['width:2.5em', 'w-em'],
    ['width:0', 'w-0'],
    ['width:73px', 'w-card'],
    ['display:flex', 'flex'],
    ['display:fl', 'flex'],
    ['display:none', 'hidden'],
    ['color:#000000', 'text-black'],
    ['background-color:white', 'bg-white'],
    ['opacity:50%', 'opacity-50'],
    ['line-height:1.5', 'leading-normal'],
    ['font-weight:bold', 'font-bold'],
    ['width:41px', 'w-[41px]'],
    ['font-size:16px', 'text-[16px]'],
  ])('matches %s to %s', (text, label) => {
    let { state } = project()
    expect(labels(state, text)).toEqual([label])
  })

  test('does not equate unrelated units or match numeric prefixes', () => {
    let { state } = project()
    expect(labels(state, 'width:40px')).not.toContain('w-em')
    expect(labels(state, 'width:40px')).not.toContain('w-40')
    expect(labels(state, 'width:2.5rem')).toEqual(['w-10'])
    expect(labels(state, 'width:40em')).toEqual(['w-[40em]'])
  })

  test.each([
    'hover:flex',
    'w-10',
    '[width:40px]',
    'w-[40px]',
    'flex w-10',
    'unknown:40px',
    'constructor:40px',
    'width:40px block',
    'width:40px\n',
    'width:\n40px',
    'width:40px;height:20px',
    'width:40px!important',
  ])('leaves ordinary or unsupported input alone: %s', (text) => {
    let { state, compile } = project()
    expect(complete(state, text)).toBeNull()
    expect(compile).not.toHaveBeenCalled()
  })

  test.each([
    'width:nonsense',
    'width:-40px',
    'width:40p',
    'padding:16px_32px',
    'display:frobnicate',
    'width:url(foo)',
    'width:40px!important;',
  ])('does not invent an arbitrary utility for invalid input: %s', (text) => {
    let { state } = project()
    expect(complete(state, text)?.items ?? []).toEqual([])
  })

  test('does not suggest utilities with additional effects or nested rules', () => {
    let { state } = project()
    expect(labels(state, 'width:40px')).toEqual(['w-10'])
    expect(labels(state, 'font-size:16px')).not.toContain('text-base')
  })

  test('shows a bounded list when the value is empty and refreshes as it changes', () => {
    let { state } = project()
    expect(labels(state, 'width:')).toContain('w-10')
    expect(labels(state, 'width: ')).toContain('w-10')
    expect(labels(state, 'width:4')).toEqual(['w-[4px]'])
    expect(labels(state, 'width:40')).toEqual(['w-10'])
    expect(labels(state, 'width:400')).toEqual(['w-[400px]'])
    state.classList = Array.from({ length: 80 }, (_, i) => [`w-[${i}px]`, { color: null }])
    expect(complete(state, 'width:').items).toHaveLength(50)
  })

  test('preserves variants and applies the project prefix', () => {
    let { state } = project()
    expect(labels(state, 'hover:width:40px')).toEqual(['hover:w-10'])
    state.designSystem.theme.prefix = 'tw'
    state.variants.unshift({
      name: 'tw',
      values: [],
      hasDash: false,
      isArbitrary: false,
      selectors: () => [],
    })
    state.classList = [...state.classList]
    expect(labels(state, 'width:40px')).toEqual(['tw:w-10'])
    expect(labels(state, 'hover:width:40px')).toEqual(['tw:hover:w-10'])
    expect(labels(state, 'tw:hover:width:40px')).toEqual(['tw:hover:w-10'])
    expect(complete(state, 'hover:tw:width:40px')).toBeNull()
    expect(complete(state, 'unknown:width:40px')).toBeNull()
  })

  test('honors blocklists for both named and arbitrary suggestions', () => {
    let { state } = project()
    state.blocklist = ['w-10']
    expect(labels(state, 'width:40px')).toEqual(['w-[40px]'])
    expect(labels(state, 'hover:width:40px')).toEqual(['hover:w-10'])
    state.blocklist = ['w-10', 'w-[40px]', '[width:40px]']
    expect(labels(state, 'width:40px')).toEqual([])
    state.blocklist = ['hover:w-10', 'hover:w-[40px]', 'hover:[width:40px]']
    expect(labels(state, 'hover:width:40px')).toEqual([])
  })

  test('caches only the requested family and applies the current root font size', () => {
    let { state, compile } = project()
    expect(labels(state, 'width:40px')).toEqual(['w-10'])
    expect(
      compile.mock.calls.every(([names]) => names.every((name) => name.startsWith('w-'))),
    ).toBe(true)
    compile.mockClear()
    expect(labels(state, 'width:160px')).toEqual(['w-40'])
    expect(labels(state, 'width:40px', 20)).toEqual(['w-8'])
    expect(compile).not.toHaveBeenCalled()
  })

  test('invalidates cached values when either the class list or compiler changes', () => {
    let { state, utilities } = project()
    expect(labels(state, 'width:40px')).toEqual(['w-10'])
    utilities.set('w-10', 'width: 80px;')
    state.classList = [...state.classList]
    expect(labels(state, 'width:40px')).toEqual(['w-[40px]'])
    expect(labels(state, 'width:80px')).toEqual(['w-10'])
    utilities.set('w-10', 'width: 90px;')
    state.designSystem = { ...state.designSystem }
    expect(labels(state, 'width:90px')).toEqual(['w-10'])
  })

  test('uses custom spacing values and resolves theme variables in a query', () => {
    let { state } = project()
    state.designSystem.resolveThemeValue = (name) => (name === '--spacing' ? '0.5rem' : undefined)
    expect(labels(state, 'width:80px')).toEqual(['w-10'])
    expect(labels(state, 'width:40px')).toEqual(['w-[40px]'])
    expect(labels(state, 'width:var(--spacing)')).toEqual(['w-[var(--spacing)]'])
  })

  test('does not confuse nearly equal numeric values', () => {
    let { state } = project()
    expect(labels(state, 'width:40.0000004px')).toEqual(['w-[40.0000004px]'])
  })

  test('keeps custom property names case-sensitive', () => {
    let { state, utilities } = project()
    utilities.set('w-variable', 'width: var(--Size);')
    state.classList.push(['w-variable', { color: null }])
    expect(labels(state, 'width:var(--Size)')).toEqual(['w-variable'])
    expect(labels(state, 'width:var(--size)')).toEqual(['w-[var(--size)]'])
  })

  test('rejects utilities with public custom-property side effects', () => {
    let { state, utilities } = project()
    utilities.set('w-with-variable', '--brand: red; width: 40px;')
    state.classList.push(['w-with-variable', { color: null }])
    expect(labels(state, 'width:40px')).toEqual(['w-10'])
  })

  test('a failing utility does not abort the whole search', () => {
    let { state, compile } = project()
    let original = compile.getMockImplementation()
    compile.mockImplementation((classes) => {
      if (classes.includes('w-card')) throw new Error('Plugin failed')
      return original(classes)
    })
    expect(labels(state, 'width:40px')).toEqual(['w-10'])
  })

  test('does not retain another project’s theme values', () => {
    let first = project()
    let second = project()
    second.utilities.set('w-10', 'width: 80px;')
    expect(labels(first.state, 'width:40px')).toEqual(['w-10'])
    expect(labels(second.state, 'width:40px')).toEqual(['w-[40px]'])
    expect(labels(first.state, 'width:40px')).toEqual(['w-10'])
  })

  test('does not opt older Tailwind engines into reverse lookup', () => {
    let { state, compile } = project()
    state.v4 = false
    state.version = '2.2.19'
    expect(complete(state, 'width:40px')).toBeNull()
    expect(compile).not.toHaveBeenCalled()
  })
})

describe('completion integration', () => {
  test('defaults to off and performs no reverse-lookup compilation when disabled', () => {
    expect(getDefaultTailwindSettings().tailwindCSS.experimental.reverseLookup).toBe(false)
    let { state, compile } = project()
    let range = { start: { line: 0, character: 12 }, end: { line: 0, character: 22 } }
    let defaults = completionsFromClassList(state, 'width:40px', range, 16)
    let disabled = completionsFromClassList(state, 'width:40px', range, 16, undefined, undefined, {
      reverseLookup: false,
    })
    expect(disabled).toEqual(defaults)
    expect(compile).not.toHaveBeenCalled()
    let enabled = completionsFromClassList(state, 'width:40px', range, 16, undefined, undefined, {
      reverseLookup: true,
    })
    expect(enabled.items.map((item) => item.label)).toEqual(['w-10'])
    expect(compile).toHaveBeenCalled()
  })

  test('respects the pixel-equivalent display setting without changing matching', () => {
    let { state } = project()
    let result = completionsFromClassList(
      state,
      'width:40px',
      {
        start: { line: 0, character: 12 },
        end: { line: 0, character: 22 },
      },
      16,
      undefined,
      undefined,
      { reverseLookup: true, showPixelEquivalents: false },
    )
    expect(result.items.map((item) => item.label)).toEqual(['w-10'])
    expect(result.items[0].detail).toBe('width: 2.5rem;')
  })

  test('honors caller-provided completion filters', () => {
    let { state } = project()
    let result = completionsFromClassList(
      state,
      'width:40px',
      {
        start: { line: 0, character: 12 },
        end: { line: 0, character: 22 },
      },
      16,
      () => false,
      undefined,
      { reverseLookup: true },
    )
    expect(result.items).toEqual([])
  })

  test('ordinary suggestions stay identical when the setting is enabled', () => {
    let { state, compile } = project()
    let range = { start: { line: 0, character: 12 }, end: { line: 0, character: 18 } }
    expect(
      completionsFromClassList(state, 'hover:', range, 16, undefined, undefined, {
        reverseLookup: true,
      }),
    ).toEqual(completionsFromClassList(state, 'hover:', range, 16))
    expect(compile).not.toHaveBeenCalled()
  })

  test.each([
    ['html', '<div class="flex width: 40px| p-4"></div>', {}],
    ['javascriptreact', '<div className="flex width: 40px| p-4" />', {}],
    ['javascript', 'clsx("flex width: 40px| p-4")', { classFunctions: ['clsx'] }],
    ['javascript', 'tw`flex width: 40px| p-4`', { classFunctions: ['tw'] }],
    ['css', '.example { @apply flex width: 40px|; }', {}],
    [
      'plaintext',
      'classes("flex width: 40px| p-4")',
      { experimental: { classRegex: ['classes\\("([^"]*)"\\)'] } },
    ],
  ])('reads the setting in %s class contexts', async (lang, markedText, settings) => {
    let { state } = project()
    let text = markedText.replace('|', '')
    let file = createDocument({
      name: `/reverse-${lang}-${markedText.length}`,
      lang,
      content: text,
      settings: {
        tailwindCSS: {
          ...settings,
          experimental: {
            ...('experimental' in settings ? settings.experimental : {}),
            reverseLookup: true,
          },
        },
      },
    })
    state.editor = file.state.editor
    let result = await doComplete(state, file.doc, file.doc.positionAt(markedText.indexOf('|')))
    expect(result.items.map((item) => item.label)).toEqual(['w-10'])
    expect(result.items[0].textEdit).toEqual({
      range: {
        start: file.doc.positionAt(text.indexOf('width')),
        end: file.doc.positionAt(markedText.indexOf('|')),
      },
      newText: 'w-10',
    })
    let resolved = await resolveCompletionItem(state, result.items[0])
    expect(resolved.documentation).toMatchObject({ kind: 'markdown' })
    expect(resolved.detail).toContain('40px')
  })

  test.each([
    ['html', '<div class="width:4|0px flex">', 'w-10', '<div class="w-10 flex">'],
    ['javascriptreact', "<div className='width:40|px' />", 'w-10', "<div className='w-10' />"],
    ['javascript', 'clsx("width:40p|x")', 'w-10', 'clsx("w-10")'],
    ['css', '.example { @apply width:|40px; }', 'w-10', '.example { @apply w-10; }'],
    ['plaintext', 'classes(width:40|px)', 'w-10', 'classes(w-10)'],
    ['html', '<div class="color:rgb(0,0,|0)">', 'text-black', '<div class="text-black">'],
    [
      'html',
      '<div class="width:var(--sp|acing)">',
      'w-[var(--spacing)]',
      '<div class="w-[var(--spacing)]">',
    ],
  ])(
    'replaces the complete value when the cursor is in the middle (%s)',
    async (lang, markedText, expected, output) => {
      let { state } = project()
      let file = createDocument({
        name: `/middle-${lang}-${markedText.length}`,
        lang,
        content: markedText.replace('|', ''),
        settings: {
          tailwindCSS: {
            classFunctions: ['clsx'],
            experimental: { reverseLookup: true, classRegex: ['classes\\(([^)]*)\\)'] },
          },
        },
      })
      state.editor = file.state.editor
      let result = await doComplete(state, file.doc, file.doc.positionAt(markedText.indexOf('|')))
      expect(result.items.map((item) => item.label)).toEqual([expected])
      expect(TextDocument.applyEdits(file.doc, [result.items[0].textEdit as TextEdit])).toBe(output)
    },
  )

  test('does not reverse-complete ordinary CSS declarations or inline styles', async () => {
    for (let [lang, text] of [
      ['css', '.example { width:40px'],
      ['html', '<div style="width:40px'],
    ]) {
      let { state, compile } = project()
      let file = createDocument({
        name: `/not-a-class-${lang}`,
        lang,
        content: text,
        settings: { tailwindCSS: { experimental: { reverseLookup: true } } },
      })
      state.editor = file.state.editor
      let result = await doComplete(state, file.doc, file.doc.positionAt(text.length))
      expect(result?.items.some((item) => item.label === 'w-10')).not.toBe(true)
      expect(compile).not.toHaveBeenCalled()
    }
  })
})
