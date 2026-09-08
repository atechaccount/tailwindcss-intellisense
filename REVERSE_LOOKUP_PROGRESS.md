# CSS → Tailwind reverse lookup (enabled by default in this local build)

## Goal

Help people learning Tailwind find a utility by typing a CSS property name or
declaration in a class completion context, for example `width`, `wid`, or
`width:40px`. Reverse lookup is enabled by default in this local build, but can
be disabled with `tailwindCSS.experimental.reverseLookup: false`.

## Initial plan (2026-09-07)

1. Add `tailwindCSS.experimental.reverseLookup` as a boolean setting, defaulting
   to `true` in this local build, in the VS Code settings UI and language-service
   configuration.
2. Recognize a single CSS property/value query in existing class completion
   contexts. Also recognize an unambiguous property prefix such as `width` or
   `wid` and offer the matching utility family directly, without requiring a
   colon. For supported length properties, explicitly interpret bare numbers as
   pixels. Replace the whole query when a suggestion is accepted, leaving
   surrounding classes and valid variants intact.
3. Match common properties against the active project's generated utilities,
   respecting its theme, prefix, blocklist, and configured root font size. Prefer
   named utilities and offer a validated arbitrary-value utility when appropriate.
   Target Tailwind v3 and v4; do not attempt a general CSS-block converter.
4. Keep the feature isolated and lazy: no reverse-lookup index or compilation
   work while disabled, and cache reusable work without retaining stale project
   configuration.
5. Add focused parser/matcher and completion regression tests, including opt-in
   behavior, replacement ranges, units, custom themes, and version differences.
6. Document how to enable/use the feature, run the relevant tests/build checks,
   review the diff, and commit both the implementation and this progress record.

## Completed

- Added the default-on setting to the VS Code manifest, typed configuration,
  and language-service defaults. It supports User, Workspace, and language-specific
  settings. The existing `tailwindCSS.suggestions` switch remains authoritative.
- Added reverse completion for common dimensions, spacing, offsets, gaps, border
  radius, typography, colors, opacity, and layout keywords. Supports colon
  separators, optional whitespace after the colon, and bare pixel lengths.
  Unitless CSS properties keep their usual meaning. Whitespace-only syntax such
  as `width 40px` is deliberately not supported because spaces separate classes.
- Added property-prefix mode (`width`, `wid`, `hover:width`) that offers the
  matching utility family directly and replaces the typed property prefix when a
  suggestion is accepted. Short/standard utility prefixes such as `w-`, `flex`,
  and `text-` remain in normal Tailwind completion. Bare values such as `40px`
  are not treated as reverse lookups.
- Added property browsing (`width:`), partial keyword searches (`display:fl`),
  named matches, and compiler-checked arbitrary-value fallbacks. Numeric searches
  do not guess the nearest spacing step. Results include CSS details and reuse
  the existing full CSS preview when resolved.
- Wired the feature into class attributes, JSX, configured class functions/tagged
  templates, custom class regexes, and `@apply`. Normal class/variant completion
  is unchanged. Reverse queries replace their entire value, including when the
  cursor is in the middle, without consuming adjacent classes or delimiters.
- Used the active compiler instead of a fixed value-to-class table. Handles v3
  and v4 prefixes, variants, custom theme values, blocklists, scoped v3 `important`
  selectors, rem/pixel conversions, and the pixel-equivalent display setting.
- Limited indexing to the requested utility family. Cached CSS values are reused
  across queries but invalidated when the class list or compiler context changes.
  No reverse index/compilation is performed while disabled. Caches are isolated
  per project; root font size is applied per request rather than cached.
- Avoided misleading matches for utilities that also set unrelated properties,
  nested/conditional rules, or public custom properties. A failing utility does
  not abort the rest of a lookup.
- Added **77 focused language-service tests** and **5 language-server integration
  tests** (each integration test exercises multiple scenarios). Integration tests
  use real Tailwind **3.4.18** and **4.1.18** compilers, including live setting
  changes, theme reloads, prefixes, blocklists, cursor edits, and CSS previews.
- Added README instructions, examples, scope/limitations, and a prerelease
  changelog entry. No dependencies or lockfiles were changed.

## Verification

Final verification was run on 2026-09-07 with Node.js 22.22.3 and pnpm 9.6.0.
`pnpm` was invoked through `npx --yes pnpm@9.6.0` because it was not globally
installed in the environment.

| Check                                                                       | Result                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                            | Passed; see optional dependency warning below        |
| Language-server fixture setup: `node tests/prepare.mjs`                     | Passed                                               |
| Language-service suite: `vitest run --silent`                               | **815 passed** across 7 files                        |
| Language-server suite: `vitest run --maxWorkers=2 --silent`                 | **300 passed, 2 pre-existing skips** across 29 files |
| Language-syntax suite: `vitest run --silent`                                | **15 passed**                                        |
| Language-service `tsc --noEmit`                                             | Passed                                               |
| VS Code extension `check` (`tsc --noEmit`, also run by `build`)             | Passed                                               |
| `pnpm --filter @tailwindcss/language-service build`                         | Passed                                               |
| `pnpm --filter vscode-tailwindcss build`                                    | Passed                                               |
| `pnpm --filter @tailwindcss/language-server build`                          | Passed                                               |
| Prettier on changed TypeScript/configuration files and this progress record | Passed                                               |
| `git diff --check`                                                          | Passed                                               |

**Total: 1,130 tests passed; 2 existing tests skipped.** Build output and temporary
fixtures/logs are not part of the commit. Existing unrelated README formatting
was preserved rather than reformatted wholesale.

### Existing verification issue (not introduced by this change)

The standalone language-server `tsc --noEmit` command reports **16 errors** involving
its existing ES2018/CommonJS configuration, ES2022 regex flags, `import.meta`, and
Vite dependency typings (`WebSocket`, `Worker`, and `rollup/parseAst`). An archived
copy of base commit `5067ff7ec0b4b8bb5c3325a69c1f3410eb5b350a` was checked using the
same installed dependencies. It reports the **same 16 diagnostic messages**.
Those unrelated configuration/dependency errors were not changed; the language
server build and full test suite, plus the extension type-check, pass.

The initial dependency installation also warned that optional `keytar` could not
install its native binary because of certificate/network errors. Installation
still succeeded, and none of the executed tests or builds required that binary.

## Not completed / limitations

- **Interactive desktop VS Code testing** was not performed. Automated LSP tests
  cover settings, completion data/filtering, edits, and resolved documentation,
  but the Settings checkbox and suggestion menu have not been visually tested in
  an Extension Development Host.
- Not a general CSS-to-Tailwind converter: no whole CSS blocks, stylesheet/inline
  style refactoring, natural-language queries, or multi-value shorthand matching.
  Values must be on one line with no internal whitespace. This is not a complete
  CSS parser or a runtime CSS-variable/cascade evaluator.
- Only the listed common properties and their supported utility families are
  searched. Arbitrarily named plugin utilities outside those families are not
  indexed. Longhand/shorthand equivalence and multi-property utilities are not
  inferred. Unsupported queries/values may have no reverse result.
- Emmet reverse lookup and Tailwind v1/v2 reverse lookup are not implemented.
  Existing features for those versions remain unchanged and their regression
  tests pass. Not every v3/v4 minor version has been individually tested.
- Results are capped at 50; typing a more specific value narrows the search.
- No marketplace release, VSIX packaging, push, or pull request was requested or
  performed. The code and this document are delivered together in a local commit
  on `arena/01a07e8f-tailwindcss-intellisense`.

## Use the feature

Reverse lookup is enabled by default in this local build. To disable it
explicitly, set the following in User or Workspace settings:

```json
{
  "tailwindCSS.experimental.reverseLookup": false
}
```

With the default theme and a 16px root font size, typing `width` or `wid` in a
class list suggests the `w-*` family (including `w-10`), and typing `width:40px`
suggests `w-10`. Accept the suggestion to replace the property prefix or
declaration. Whitespace syntax such as `width 40` is not supported.
