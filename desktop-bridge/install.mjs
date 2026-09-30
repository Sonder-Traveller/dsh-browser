/**
 * Install the plugin browser bridge into an installed DSH Desktop.
 *
 * WHY A SCRIPT
 * The bridge has to live inside the desktop app (it is the only process with
 * Electron access), and the desktop app is somebody else's installed artifact:
 * a desktop update replaces everything this script touches. So the change is
 * expressed as something replayable rather than as a one-off edit — re-run this
 * after every desktop upgrade.
 *
 * WHAT IT DOES (idempotent)
 *   1. copies `plugin-browser-bridge.js` next to the app's main bundle;
 *   2. appends a guarded import to `lib/main.js` that starts it after `whenReady`,
 *      keeping a pristine `main.js.before-bridge` backup the first time;
 *   3. does nothing if the import is already present.
 *
 * USAGE
 *   node apps/desktop/bridge/install.mjs [path-to-DeepSeek-Harness-install]
 * Default path: %LOCALAPPDATA%\Programs\DeepSeek Harness
 * Pass --revert to restore the pre-bridge main.js instead.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_INSTALL = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
const args = process.argv.slice(2)
const revert = args.includes('--revert')
const installRoot = args.find(arg => !arg.startsWith('--')) ?? DEFAULT_INSTALL

const appDir = join(installRoot, 'resources', 'app')
const mainPath = join(appDir, 'lib', 'main.js')
const bridgeTarget = join(appDir, 'lib', 'plugin-browser-bridge.js')
const bridgeSource = join(import.meta.dirname, 'plugin-browser-bridge.js')
const backupPath = `${mainPath}.before-bridge`

/** The exact block appended to main.js. Keep it recognisable: idempotence and
 *  reverting both key off this marker. */
const MARKER = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'
const SNIPPET = `
${MARKER} pages.
// The plugin runs inside the Node-mode host, where there is no Electron API, so the
// shell is the only process that can own a view. Exposing the existing webview
// guests (and their CDP) is what lets the agent work on the page the human is
// looking at, instead of spawning a second, parallel browser window.
// Installed by apps/desktop/bridge/install.mjs — re-run it after a desktop upgrade.
// A bridge failure is never fatal to the shell.
app.whenReady().then(async () => {
	try {
		const bridge = await import("./plugin-browser-bridge.js");
		bridge.start();
	} catch (error) {
		console.error("[dsh-browser-bridge] start failed:", error);
	}
});
`

if (!existsSync(mainPath)) {
  console.error(`not a DSH Desktop install (no ${mainPath})`)
  process.exit(1)
}

if (revert) {
  if (!existsSync(backupPath)) {
    console.error(`nothing to revert: ${backupPath} does not exist`)
    process.exit(1)
  }
  copyFileSync(backupPath, mainPath)
  console.log(`reverted ${mainPath} from ${backupPath}`)
  process.exit(0)
}

const current = readFileSync(mainPath, 'utf8')
if (current.includes(MARKER)) {
  console.log('bridge already installed (main.js carries the marker); refreshing the module copy')
  copyFileSync(bridgeSource, bridgeTarget)
  process.exit(0)
}

if (!existsSync(backupPath)) {
  copyFileSync(mainPath, backupPath)
  console.log(`backed up main.js -> ${backupPath}`)
}

// Append before the trailing `export {};` so the import stays inside the module.
const exportTail = 'export {};'
const insertAt = current.lastIndexOf(exportTail)
if (insertAt === -1) {
  console.error('unexpected main.js shape: no trailing `export {};` to insert before')
  process.exit(1)
}
const patched = `${current.slice(0, insertAt)}${SNIPPET}${current.slice(insertAt)}`
writeFileSync(mainPath, patched)

copyFileSync(bridgeSource, bridgeTarget)
console.log(`installed bridge into ${appDir}`)
console.log(`  module: ${bridgeTarget}`)
console.log(`  patch:  ${mainPath} (+${SNIPPET.split('\n').length} lines)`)
console.log('restart DSH Desktop to activate it.')
