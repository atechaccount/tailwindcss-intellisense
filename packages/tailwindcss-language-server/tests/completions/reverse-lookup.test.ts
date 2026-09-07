import { expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type CompletionItem, type TextEdit } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { css, defineTest, js } from '../../src/testing'
import { createClient, type Client } from '../utils/client'

async function complete(client: Client, markedText: string, lang = 'html') {
  let offset = markedText.indexOf('|')
  let text = markedText.replace('|', '')
  let doc = await client.open({ lang, text })
  let document = TextDocument.create(doc.uri.toString(), lang, 0, text)
  let result = await doc.completions({
    position: document.positionAt(offset),
    context: { triggerKind: 1 },
  })
  return { doc, document, result }
}

for (let version of [3, 4]) {
  defineTest({
    // This exercises many documents plus live settings changes, which also
    // revalidate every open document in the real server.
    options: { timeout: 45000 },
    name: `v${version}: reverse lookup is opt-in and uses the real Tailwind compiler`,
    fs:
      version === 3
        ? { 'tailwind.config.js': js`module.exports = { content: ['./**/*.html'] }` }
        : {
            'app.css': css`
              @import 'tailwindcss';
            `,
          },
    prepare: async ({ root }) => ({ client: await createClient({ root }) }),
    handle: async ({ client }) => {
      let { doc, result: defaults } = await complete(client, '<div class="width:40px|">')
      expect(defaults.isIncomplete).toBe(false)
      expect(defaults.items.some((item) => item.filterText === 'width:40px')).toBe(false)

      await client.updateSettings({ tailwindCSS: { experimental: { reverseLookup: true } } })
      let enabled = await doc.completions({ line: 0, character: 22 })
      expect(enabled.isIncomplete).toBe(true)
      expect(enabled.items.map((item) => item.label)).toEqual(['w-10'])
      expect(enabled.items[0].detail).toContain('40px')

      let examples = [
        ['width:40px', 'w-10'],
        ['width: 40px', 'w-10'],
        ['width 40', 'w-10'],
        ['width:40', 'w-10'],
        ['height:40px', 'h-10'],
        ['padding:16px', 'p-4'],
        ['margin:-16px', '-m-4'],
        ['display:flex', 'flex'],
        ['position:absolute', 'absolute'],
        ['width:100%', 'w-full'],
        ['color:#fff', 'text-white'],
        ['background-color:#000000', 'bg-black'],
        ['opacity:50%', 'opacity-50'],
        ['font-weight:bold', 'font-bold'],
        ['line-height:1.5', 'leading-normal'],
        ['width:41px', 'w-[41px]'],
        // text-base also sets line-height, so it is not an exact equivalent.
        ['font-size:16px', 'text-[16px]'],
        ['hover:width:40px', 'hover:w-10'],
        ['[&:focus]:width:40px', '[&:focus]:w-10'],
      ]
      for (let [query, expected] of examples) {
        let { document, result } = await complete(client, `<div class="flex ${query}| p-4">`)
        expect(
          result.items.map((item) => item.label),
          query,
        ).toContain(expected)
        let item = result.items.find((item) => item.label === expected)
        expect(TextDocument.applyEdits(document, [item.textEdit as TextEdit]), query).toBe(
          `<div class="flex ${expected} p-4">`,
        )
        expect(item.filterText, query).toBe(query)
        let resolved = await client.conn.sendRequest<CompletionItem>('completionItem/resolve', item)
        expect(resolved.documentation, query).toMatchObject({ kind: 'markdown' })
      }

      let middle = await complete(client, '<div class="width:4|0px flex">')
      expect(middle.result.items.map((item) => item.label)).toEqual(['w-10'])
      expect(
        TextDocument.applyEdits(middle.document, [middle.result.items[0].textEdit as TextEdit]),
      ).toBe('<div class="w-10 flex">')

      // Root font size is a request setting, not a fixed assumption in the index.
      await client.updateSettings({
        tailwindCSS: { experimental: { reverseLookup: true }, rootFontSize: 20 },
      })
      expect(
        (await doc.completions({ line: 0, character: 22 })).items.map((item) => item.label),
      ).toEqual(['w-8'])

      await client.updateSettings({ tailwindCSS: { experimental: { reverseLookup: false } } })
      expect(await doc.completions({ line: 0, character: 22 })).toEqual(defaults)

      await client.updateSettings({
        tailwindCSS: { experimental: { reverseLookup: true }, suggestions: false },
      })
      expect(await doc.completions({ line: 0, character: 22 })).toBeNull()
      await client.conn.sendRequest('shutdown')
    },
  })

  defineTest({
    name: `v${version}: reverse lookup respects prefixes, custom themes, blocklists, and reloads`,
    fs:
      version === 3
        ? {
            'tailwind.config.js': js`
          module.exports = {
            content: ['./**/*.html'],
            prefix: 'tw-',
            important: '#app',
            blocklist: ['tw-w-10'],
            theme: { extend: { width: { lesson: '41px' } } },
          }
        `,
          }
        : {
            'app.css': css`
              @import 'tailwindcss' prefix(tw);
              @source not inline('tw:w-10');
              @theme {
                --container-lesson: 41px;
              }
            `,
          },
    prepare: async ({ root }) => ({
      client: await createClient({
        root,
        settings: { tailwindCSS: { experimental: { reverseLookup: true } } },
      }),
    }),
    handle: async ({ client, root }) => {
      let prefix = version === 3 ? 'tw-' : 'tw:'
      let { doc, result } = await complete(client, '<div class="width:41px|">')
      expect(result.items.map((item) => item.label)).toContain(`${prefix}w-lesson`)
      let blocked = (await complete(client, '<div class="width:40px|">')).result
      expect(blocked.items.map((item) => item.label)).not.toContain(`${prefix}w-10`)
      expect(blocked.items.map((item) => item.label)).toContain(`${prefix}w-[40px]`)

      let variant = (await complete(client, '<div class="hover:width:41px|">')).result
      expect(variant.items.map((item) => item.label)).toContain(
        version === 3 ? 'hover:tw-w-lesson' : 'tw:hover:w-lesson',
      )

      // Verify invalidation through an actual project reload, not just a mock.
      let didReload = new Promise<void>((resolve) => {
        let registration = client.conn.onNotification('@/tailwindCSS/projectReloaded', () => {
          registration.dispose()
          resolve()
        })
      })
      let filename = path.join(root, version === 3 ? 'tailwind.config.js' : 'app.css')
      let content = await fs.readFile(filename, 'utf8')
      await fs.writeFile(filename, content.replace('41px', '43px'))
      await client.notifyChangedFiles({ changed: [filename] })
      await didReload

      let afterReload = await doc.completions({ line: 0, character: 22 })
      expect(afterReload.items.map((item) => item.label)).not.toContain(`${prefix}w-lesson`)
      expect(afterReload.items.map((item) => item.label)).toContain(`${prefix}w-[41px]`)
      expect(
        (await complete(client, '<div class="width:43px|">')).result.items.map(
          (item) => item.label,
        ),
      ).toContain(`${prefix}w-lesson`)
      await client.conn.sendRequest('shutdown')
    },
  })
}

defineTest({
  name: 'Reverse lookup works in JSX, class functions, @apply, and multiline class attributes',
  fs: {
    'app.css': css`
      @import 'tailwindcss';
    `,
  },
  prepare: async ({ root }) => ({
    client: await createClient({
      root,
      settings: {
        tailwindCSS: { experimental: { reverseLookup: true }, classFunctions: ['clsx', 'tw'] },
      },
      capabilities(caps) {
        caps.textDocument.completion.completionList = { itemDefaults: ['editRange', 'data'] }
      },
    }),
  }),
  handle: async ({ client }) => {
    for (let [lang, markedText] of [
      ['javascriptreact', '<div className="flex width: 40px| p-4" />'],
      ['javascript', 'clsx("flex width: 40px| p-4")'],
      ['typescript', 'tw`flex width: 40px| p-4`'],
      ['css', '.example { @apply flex width: 40px|; }'],
      ['html', '<div class="flex\n  width: 40px|\n p-4">'],
    ]) {
      let { document, result } = await complete(client, markedText, lang)
      expect(result.items.map((item) => item.label)).toEqual(['w-10'])
      expect(TextDocument.applyEdits(document, [result.items[0].textEdit as TextEdit])).toBe(
        markedText.replace('width: 40px|', 'w-10'),
      )
    }
    await client.conn.sendRequest('shutdown')
  },
})
