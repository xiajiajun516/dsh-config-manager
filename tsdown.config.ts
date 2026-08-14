/**
 * tsdown config — client-half bundle only.
 *
 * The host half is built by `tsc -p tsconfig.build.json` into lib/ (structure
 * preserved, ESM). This config bundles src/client/index.ts into lib/client.js
 * with the exact loader shape @linxin666/dsh-ssh ships (verified against its
 * published lib/client.js):
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-config-manager",
 *     factory: (require) => { ... cjs bundle ... return module.exports; }
 *   });
 *
 * - format 'cjs' + external react/react-dom → the factory's `require` parameter
 *   resolves them (the client runtime supplies react);
 * - CSS Modules (`*.module.css`) are compiled by lightningcss in a small
 *   rolldown plugin that rewrites the import to a virtual JS module and
 *   generates the same inline style-tag injector the dsh-ssh panel uses, so
 *   the single client.js carries its own styles (the loader only fetches
 *   client.js — no separate css asset is ever loaded);
 * - `clean: false` so tsdown never wipes the tsc-built host lib/.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'
import { transform as transformCss } from 'lightningcss'

/** Loader id must match the package name (dsh-ssh uses "@linxin666/dsh-ssh"). */
const LOADER_ID = 'dsh-config-manager'

/** Virtual-module prefix for compiled CSS Modules. */
const CSS_VIRTUAL_PREFIX = '\0config-manager-css:'

/**
 * A CSS Module import becomes a virtual module whose id must NOT end in `.css`
 * (tsdown's css-guard / @tsdown/css filters match `.css` ids and would
 * re-process the generated JS as stylesheet text). `.css.js` keeps it opaque.
 */
function cssVirtualId(filePath: string): string {
  return `${CSS_VIRTUAL_PREFIX}${filePath.replace(/\.css$/i, '.css.js')}`
}

/** CSS Modules → inline style-tag injector (dsh-ssh's panel.module.css pattern). */
function cssModulesPlugin(): Plugin {
  return {
    name: 'config-manager:css-modules',
    resolveId(source, importer) {
      if (typeof source !== 'string' || !source.endsWith('.module.css')) return null
      // Resolve against the importer so the virtual id carries the real path.
      const base = importer ? dirname(importer) : process.cwd()
      return { id: cssVirtualId(resolve(base, source)), moduleSideEffects: false }
    },
    load(id) {
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const filePath = id.slice(CSS_VIRTUAL_PREFIX.length).replace(/\.css\.js$/i, '.css')
      const code = readFileSync(filePath, 'utf8')
      const result = transformCss({
        filename: filePath,
        code: Buffer.from(code),
        cssModules: true,
        minify: true,
      })
      const classes: Record<string, string> = {}
      const exports = result.exports as Record<string, unknown> | undefined
      if (exports) {
        for (const [key, value] of Object.entries(exports)) {
          if (value !== null && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
            classes[key] = value.name
          }
        }
      }
      const css = Buffer.from(result.code).toString('utf8')
      const tagId = `${LOADER_ID}/config-manager.module.css`
      const moduleCode = [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== "undefined" && document.querySelector("style[data-tag=\\"${tagId}\\"]") === null) {`,
        `  const tag = document.createElement("style");`,
        `  tag.dataset.plugin = ${JSON.stringify(LOADER_ID)};`,
        '  tag.dataset.tag = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
      return { code: moduleCode, map: null, moduleSideEffects: false, moduleType: 'js' }
    },
  }
}

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  deps: {
    neverBundle: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  },
  plugins: [cssModulesPlugin()],
  sourcemap: true,
  clean: false,
  hash: false,
  // Force lib/client.js (not .cjs): the package is `type: module` and the
  // loader/runtime serves the `./client` export by that exact filename
  // (dsh-ssh ships lib/client.js the same way).
  outExtensions: ({ format }) => (format === 'cjs' ? { js: '.js', dts: '.d.ts' } : undefined),
  banner: [
    'window.__ModuleLoader__.load({',
    '\tid: "dsh-config-manager",',
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '',
  ].join('\n'),
  footer: [
    '',
    '\t\treturn module.exports;',
    '\t}',
    '});',
  ].join('\n'),
})
