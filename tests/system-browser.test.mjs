// Choosing which browser carries the agent's pages.
//
// Detection is a pure function of the environment so it can be tested without a
// particular machine: an explicit choice must never silently become a different
// browser, and an unavailable choice must be reported rather than guessed at.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectBrowser, SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'

/** An env where every candidate path exists. */
const everything = {
  DSH_BROWSER_CHROME_PATH: process.execPath,
  DSH_BROWSER_EDGE_PATH: process.execPath,
}

test('the bundled choice never resolves to a system browser', () => {
  assert.equal(detectBrowser('bundled', everything), undefined)
})

test('an explicit choice resolves to that browser', () => {
  assert.equal(detectBrowser('chrome', everything)?.kind, 'chrome')
  assert.equal(detectBrowser('edge', everything)?.kind, 'edge')
  assert.equal(detectBrowser('auto', everything)?.kind, 'chrome', 'auto prefers Chrome')
})

test('an injected path wins over the hardcoded locations', () => {
  // The environment override exists for non-default installs; when it points at a
  // real file it must be used, which is also how this test avoids depending on
  // whether Chrome happens to be installed on the machine running it.
  assert.equal(detectBrowser('chrome', { DSH_BROWSER_CHROME_PATH: process.execPath })?.path, process.execPath)
})

test('a path that does not exist is never returned', () => {
  // Whatever is resolved must be a real executable: a stale override pointing at an
  // uninstalled browser must not be handed to spawn.
  const found = detectBrowser('auto', {
    DSH_BROWSER_CHROME_PATH: 'D:\\definitely\\missing\\chrome.exe',
    DSH_BROWSER_EDGE_PATH: 'D:\\definitely\\missing\\msedge.exe',
  })
  if (found !== undefined) {
    assert.notEqual(found.path, 'D:\\definitely\\missing\\chrome.exe')
    assert.notEqual(found.path, 'D:\\definitely\\missing\\msedge.exe')
  }
})

test('the resolved path is the one that exists', () => {
  const found = detectBrowser('chrome', everything)
  assert.equal(found?.path, process.execPath)
})

// Reported bug: merely loading the plugin launched Chrome, because the host started
// the browser in its constructor. Registration has to be inert — a browser may only
// appear once something actually asks for a page.
test('constructing the host starts nothing', () => {
  // A path that cannot launch: if construction tried, this would spawn (and fail).
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: join(tmpdir(), 'definitely-not-a-browser.exe') },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  assert.equal(host.started, false, 'no process at construction')
  assert.equal(host.available(), true, 'and the host is still usable')
  // Disposing an unused host must be a clean no-op (nothing to kill, nothing to throw).
  assert.doesNotThrow(() => host.dispose())
})

test('an unused host never spawns anything', () => {
  // Same contract from the other side: registering and releasing must leave no
  // process behind. `started` is the observable proof.
  const host = new SystemBrowserViewHost(
    { kind: 'edge', path: join(tmpdir(), 'also-not-a-browser.exe') },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  host.dispose()
  assert.equal(host.started, false)
})
