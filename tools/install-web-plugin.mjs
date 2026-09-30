/**
 * Install or upgrade dsh-builtin-browser in the web profile — the whole procedure,
 * in the order that keeps the profile healthy.
 *
 * WHY THIS EXISTS
 * A non-frozen `pnpm install` in profiles/web re-resolves the dependency graph, and
 * as a side effect it prunes the nested `node_modules` of packages the profile links
 * to (via `link:`) and materializes the farm's `@deepseek-ai/dsh-tools` as a real
 * registry directory. That breaks module resolution for the plugins that share it:
 * 156 `ERR_MODULE_NOT_FOUND` for cordis, 12 "failed to import", 9 "waiting for
 * services", and the whole startup is judged failed. It has happened four times, and
 * one of those times was an install run to ship 0.3.0 — the trigger is the install
 * itself, not carelessness.
 *
 * So the repair is not optional advice, it is step 3 of every install. Running this
 * script instead of `pnpm install` is what makes that structural rather than
 * something somebody has to remember.
 *
 * WHAT IT DOES
 *   1. snapshot the current pin, then set profiles/web/package.json to the version;
 *   2. pnpm install in profiles/web (not frozen — it has to edit the lockfile);
 *   3. immediately run repair-web-profile.mjs --apply;
 *   4. verify: the repaired junctions are present and the doctor reports healthy.
 *
 * USAGE
 *   node install-web-plugin.mjs 0.3.1
 *   node install-web-plugin.mjs            # reinstall whatever is currently pinned
 *   node install-web-plugin.mjs --verify   # check only, change nothing
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME ?? 'D:\\dsh-home'
const PROFILE = join(HOME, 'profiles', 'web')
const PACKAGE = join(PROFILE, 'package.json')
const PLUGIN = 'dsh-builtin-browser'
const HERE = import.meta.dirname
/**
 * Where the repair tool lives.
 *
 * It is a separate, environment-specific script rather than part of this package, so
 * this script looks for it in the places it has actually been kept: beside this file,
 * beside the DSH checkout, and one level up (its historical home). `DSH_REPAIR_TOOL`
 * overrides the search when it lives somewhere else entirely.
 */
function findRepairTool() {
  const candidates = [
    process.env.DSH_REPAIR_TOOL,
    join(HERE, 'repair-web-profile.mjs'),
    join(process.env.DSH_HARNESS ?? 'D:\\deepseek-harness', 'scripts', 'repair-web-profile.mjs'),
    join(HERE, '..', 'repair-web-profile.mjs'),
    'D:\\dsh-legacy-archive\\repair-web-profile.mjs',
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * What must hold for the profile to resolve modules correctly.
 *
 * The repo's own nested `node_modules` is a REAL directory — it is the one that
 * holds junctions of its own; requiring a junction there would be wrong. What must
 * never happen is the farm's `dsh-tools` turning into a registry copy: that is the
 * one pnpm materializes, and the one four plugins break on.
 */
const CHECKS = [
  { path: join(process.env.DSH_HARNESS ?? 'D:\\deepseek-harness', 'packages', 'core', 'tools', 'node_modules'), expect: 'directory' },
  { path: join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'), expect: 'junction' },
]

const args = process.argv.slice(2)
const verifyOnly = args.includes('--verify')
const version = args.find(arg => !arg.startsWith('--'))

/** Run a command, streaming nothing but failing loudly. */
function run(command, commandArgs, cwd) {
  console.log(`  $ ${command} ${commandArgs.join(' ')}`)
  execFileSync(command, commandArgs, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
}

/** Read the profile's pin for this plugin. */
function currentPin() {
  return JSON.parse(readFileSync(PACKAGE, 'utf8')).dependencies?.[PLUGIN]
}

/** What shape is each required path in right now? */
function junctionReport() {
  return CHECKS.map(check => {
    if (!existsSync(check.path)) return { ...check, state: 'missing' }
    const stats = lstatSync(check.path)
    const state = stats.isSymbolicLink() ? 'junction' : 'directory'
    return { ...check, state, ok: state === check.expect }
  })
}

console.log(`web-profile plugin install  (profile: ${PROFILE})`)
console.log(`pin now: ${currentPin()}`)

if (verifyOnly) {
  const report = junctionReport()
  for (const entry of report) console.log(`  ${entry.state.padEnd(15)} ${entry.path}`)
  const broken = report.filter(entry => entry.ok !== true)
  console.log(broken.length === 0 ? 'VERIFY: healthy' : `VERIFY: ${broken.length} broken`)
  process.exit(broken.length === 0 ? 0 : 1)
}

if (!existsSync(PACKAGE)) {
  console.error(`not a dsh web profile (no ${PACKAGE})`)
  process.exit(1)
}

// ---- 1. pin the version -----------------------------------------------------
if (version !== undefined) {
  if (currentPin() === version) {
    console.log(`step 1: already pinned at ${version}`)
  } else {
    copyFileSync(PACKAGE, `${PACKAGE}.bak-before-${version}`)
    const document = JSON.parse(readFileSync(PACKAGE, 'utf8'))
    document.dependencies[PLUGIN] = version
    writeFileSync(PACKAGE, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`step 1: pinned ${version} (backup: ${PACKAGE}.bak-before-${version})`)
  }
} else {
  console.log('step 1: no version given, keeping the current pin')
}

// ---- 2. install -------------------------------------------------------------
console.log('step 2: pnpm install (this is the step that causes the damage)')
run('pnpm', ['install', '--ignore-scripts'], PROFILE)

// ---- 3. repair, immediately -------------------------------------------------
console.log('step 3: repair the profile (never skip this)')
const repair = findRepairTool()
if (repair === undefined) {
  console.error('  repair tool not found — set DSH_REPAIR_TOOL to its path; the profile is likely damaged now')
  process.exit(1)
}
run(process.execPath, [repair, '--apply'], import.meta.dirname)

// ---- 4. verify --------------------------------------------------------------
console.log('step 4: verify')
const report = junctionReport()
for (const entry of report) console.log(`  ${entry.state.padEnd(15)} ${entry.path}`)
const broken = report.filter(entry => entry.ok !== true)
if (broken.length > 0) {
  console.error(`FAILED: ${broken.length} junction(s) still broken after repair`)
  process.exit(1)
}
console.log(`installed: ${currentPin()}`)
console.log('done — restart the web host to load it')
