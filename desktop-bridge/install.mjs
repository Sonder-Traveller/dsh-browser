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
 * TWO LAYOUTS
 * DSH Desktop ships in two shapes, and they need different work:
 *
 *   unpacked  `<install>/resources/app/lib/main.js` is a real file. The
 *             long-standing path: copy the module next to main.js and append a
 *             guarded import to it.
 *
 *   packed    `<install>/resources/app.asar` holds the whole app (main.js is
 *             inside the archive) and `resources/app.asar.unpacked` holds the
 *             entries marked `unpacked`, i.e. the native modules. The official
 *             Windows build is packed — where this script used to fail with
 *             "not a DSH Desktop install" on a perfectly good installation,
 *             because it only ever looked for the unpacked main.js.
 *
 * HOW THE PACKED LAYOUT IS HANDLED
 * Electron loads `app.asar` in preference to `app/`, and a directory only wins
 * once the archive is not there. Rewriting the archive in place is not an
 * option either: the official build enables the
 * `EnableEmbeddedAsarIntegrityValidation` fuse (measured: enabled), so a
 * modified app.asar is a broken app. The archive is therefore never touched:
 *
 *   1. extract `app.asar` into `resources/app`, taking the real bytes of
 *      `unpacked` entries from `resources/app.asar.unpacked` (a straight
 *      archive walk would leave the native modules as empty stubs);
 *   2. install the bridge into that tree exactly as in the unpacked layout;
 *   3. rename `app.asar` to `app.asar.before-bridge`, so Electron falls back to
 *      the directory that was just built.
 *
 * The trigger is the ARCHIVE's presence, not the directory's absence. A desktop
 * update writes a new `app.asar` and leaves any earlier extraction lying around
 * (the updater does not know about that directory), so keying off "the tree is
 * missing" would patch the stale tree while Electron keeps loading the archive —
 * a run that reports success with the bridge dead. Whenever the archive is
 * there it is the app, so the tree is rebuilt from it.
 *
 * `--revert` moves the archive back and restores the pristine main.js. The
 * extracted tree then becomes inert (the archive wins again) and can be deleted.
 *
 * WHAT IT DOES (idempotent)
 *   1. copies `plugin-browser-bridge.js` next to the app's main bundle;
 *   2. appends a guarded import to `lib/main.js` that starts it after `whenReady`,
 *      keeping a pristine `main.js.before-bridge` backup the first time;
 *   3. does nothing if the import is already present.
 *
 * USAGE
 *   node desktop-bridge/install.mjs [path-to-DeepSeek-Harness-install]
 * Default path: %LOCALAPPDATA%\Programs\DeepSeek Harness
 * Pass --revert to restore the pre-bridge state instead.
 */
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_INSTALL = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
const args = process.argv.slice(2)
const revert = args.includes('--revert')
const installRoot = args.find(arg => !arg.startsWith('--')) ?? DEFAULT_INSTALL

const resourcesDir = join(installRoot, 'resources')
const appDir = join(resourcesDir, 'app')
const asarPath = join(resourcesDir, 'app.asar')
const asarMoved = `${asarPath}.before-bridge`
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

/**
 * Parse an asar header — a Chromium pickle holding
 * `[payloadSize][jsonLength][json…]`, preceded by an 8-byte outer pickle.
 * @param file - the archive path.
 * @returns the parsed header tree plus the offset where file content starts.
 */
function readAsarHeader(file) {
  const fd = openSync(file, 'r')
  const sizeBuf = Buffer.alloc(8)
  readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  const jsonLength = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength))
  return { fd, header, contentBase: 8 + headerSize }
}

/**
 * Write one asar tree to disk, taking `unpacked` entries from the sibling
 * `.unpacked` directory — their bytes are not in the archive.
 * @param asar - the archive path.
 * @param outDir - directory to extract into.
 * @returns file and byte counts, and how many entries came from `.unpacked`.
 */
function extractAsar(asar, outDir) {
  const { fd, header, contentBase } = readAsarHeader(asar)
  const unpackedRoot = `${asar}.unpacked`
  let files = 0
  let bytes = 0
  let unpackedFiles = 0
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const relativePath = prefix === '' ? name : `${prefix}/${name}`
      const target = join(outDir, ...relativePath.split('/'))
      if (entry.files) {
        mkdirSync(target, { recursive: true })
        walk(entry, relativePath)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      if (entry.unpacked) {
        const source = join(unpackedRoot, ...relativePath.split('/'))
        if (!existsSync(source)) throw new Error(`unpacked entry is missing: ${source}`)
        copyFileSync(source, target)
        unpackedFiles += 1
      } else {
        const buffer = Buffer.alloc(entry.size)
        readSync(fd, buffer, 0, entry.size, contentBase + Number(entry.offset))
        writeFileSync(target, buffer)
      }
      const actual = statSync(target).size
      if (actual !== entry.size) throw new Error(`size mismatch for ${relativePath}: header ${entry.size}, wrote ${actual}`)
      files += 1
      bytes += actual
    }
  }
  mkdirSync(outDir, { recursive: true })
  walk(header, '')
  return { files, bytes, unpackedFiles }
}

// The archive wins whenever it exists, so ITS presence — not the absence of the
// directory — decides the layout. After a desktop update the archive is back
// (a new build) while an older extraction is still lying around, and keying off
// the directory would patch a tree that Electron never loads.
const packedLayout = existsSync(asarPath)
if (!existsSync(mainPath) && !existsSync(asarPath)) {
  console.error('not a DSH Desktop install: neither')
  console.error(`  ${mainPath}`)
  console.error('nor')
  console.error(`  ${asarPath}`)
  console.error('exists. Pass the installation directory as the first argument.')
  process.exit(1)
}

if (revert) {
  let reverted = false
  if (existsSync(asarMoved)) {
    if (existsSync(asarPath)) rmSync(asarPath, { force: true })
    renameSync(asarMoved, asarPath)
    console.log(`restored the app archive: app.asar.before-bridge -> app.asar`)
    reverted = true
  }
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, mainPath)
    console.log(`restored ${mainPath} from ${backupPath}`)
    reverted = true
  }
  if (!reverted) {
    console.error(`nothing to revert in ${installRoot}`)
    process.exit(1)
  }
  console.log(`note: ${appDir} is inert while app.asar exists; delete it to reclaim ~350 MB`)
  process.exit(0)
}

if (packedLayout) {
  const stale = existsSync(appDir)
  const started = Date.now()
  console.log(stale
    ? `packed layout detected (${asarPath}); an earlier extraction is present and will be rebuilt`
    : `packed layout detected (${asarPath})`)
  if (stale) {
    // Rebuild rather than merge: the tree has to describe THIS archive, and a
    // merge would keep files the new build no longer ships. Removing it is safe
    // here — the archive is present, so the app is not running from this
    // directory, and a failure below leaves the archive in place and the
    // installation working.
    rmSync(appDir, { recursive: true, force: true })
  }
  console.log(`extracting into ${appDir} — this writes ~355 MB and can take a minute (measured: 8-55s)...`)
  const result = extractAsar(asarPath, appDir)
  const megabytes = (result.bytes / 1024 / 1024).toFixed(1)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`  extracted ${result.files} files / ${megabytes} MB` +
    ` (${result.unpackedFiles} from app.asar.unpacked) in ${seconds}s`)
  // A fresh extraction invalidates any earlier pristine copy: --revert has to be
  // able to restore the main.js that belongs to THIS build.
  copyFileSync(mainPath, backupPath)
  try {
    renameSync(asarPath, asarMoved)
    console.log('moved the archive aside: app.asar -> app.asar.before-bridge')
    console.log(`  Electron now loads ${appDir}; the archive is untouched, so the asar integrity fuse cannot trip`)
  } catch (error) {
    console.error(`could not move app.asar aside: ${String(error)}`)
    console.error('close DSH Desktop completely and run this again.')
    process.exit(1)
  }
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
