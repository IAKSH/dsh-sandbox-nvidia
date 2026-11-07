/**
 * Regression: the profile must grant the session workspace, so a confined wrap
 * exposes the NVIDIA nodes (otherwise the profile's fresh `--dev` tmpfs hides
 * them and `nvidia-smi` reports it cannot reach the driver).
 *
 * This is the harness-level counterpart of `bwrap-e2e.mjs`: that suite proves
 * the INJECTION works, this one proves the LIVE PROFILE CONFIG grants it.
 *
 * Uses the real cordis, the real `LocalSandboxProvider`, and the real config
 * parsed out of the profile's `cordis.patch.yml` — the same objects the harness
 * uses. Skips when the harness checkout, bwrap, or the GPU are unavailable, so
 * it stays green on CI boxes without them (same convention as bwrap-e2e.mjs).
 *
 * DSH_HARNESS        harness checkout root (default /home/dsh/deepseek-harness)
 * DSH_PROFILE_PATCH  profile patch to read config from
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const HARNESS = process.env.DSH_HARNESS ?? '/home/dsh/deepseek-harness'
const CORDIS = `${HARNESS}/vendor/cordis/lib/index.js`
const PROVIDER = `${HARNESS}/packages/sandbox/sandbox-local/lib/index.js`
const PATCH = process.env.DSH_PROFILE_PATCH ?? '/home/dsh/.dsh/profiles/web/cordis.patch.yml'

const hasHarness = existsSync(CORDIS) && existsSync(PROVIDER)
const hasPatch = existsSync(PATCH)

const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], { timeout: 5000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0
const smi = spawnSync('nvidia-smi', ['-L'], { timeout: 5000, encoding: 'utf8' })
const gpuUsable = bwrapUsable && smi.status === 0

/**
 * Parse the sandbox-nvidia entry's config out of a live patch file.
 * Comment-only and blank lines are skipped WITHOUT leaving the `workspaces`
 * block: stripping a trailing comment turns `  # note` into spaces, which a
 * naive scan would mistake for a non-list item and close the block.
 */
function realConfig(patchPath) {
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const start = lines.findIndex(l => /^\s*-\s+id:\s+sandbox-nvidia\s*$/.test(l))
  assert.notEqual(start, -1, 'sandbox-nvidia entry missing from the profile patch')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^\s*-\s+id:\s+/.test(lines[i])) { end = i; break }
  const entry = lines.slice(start, end)
  const workspaces = []
  let inWs = false
  for (const raw of entry) {
    if (/^\s*#/.test(raw)) continue
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    if (/^\s*disabled:\s*true\s*$/.test(line)) continue
    if (/^\s*workspaces:\s*$/.test(line)) { inWs = true; continue }
    if (inWs) {
      const m = line.match(/^\s+-\s*(\/\S+)\s*$/)
      if (m) { workspaces.push(m[1]); continue }
      inWs = false
    }
  }
  return { enabled: !entry.some(l => /^\s*disabled:\s*true\s*$/.test(l)), allSessions: false, sessions: [], workspaces }
}

const skip = !hasHarness ? 'harness checkout not found'
  : !hasPatch ? 'profile patch not found'
    : !bwrapUsable ? 'bwrap unavailable' : false

describe('live profile grant', { skip }, () => {
  const config = realConfig(PATCH)

  it('parses a non-empty allow-list of absolute workspace roots', () => {
    assert.ok(config.workspaces.length > 0, 'workspaces allow-list is empty: deny-by-default grants nothing')
    for (const root of config.workspaces) assert.match(root, /^\/\S+$/u)
  })

  it('grants the session workspace root itself, not only its children', async () => {
    // The 2026-10-27 outage: the list held /home/dsh/repos, /mnt/hdd/repos and
    // /home/dsh/deepseek-harness while the session workspace WAS /home/dsh, so
    // every call was denied. At least one root must be an ancestor of the
    // workspace sessions actually use (/home/dsh here).
    const sessionRoot = process.env.DSH_SESSION_WORKSPACE ?? '/home/dsh'
    const covered = config.workspaces.some(root => sessionRoot === root || sessionRoot.startsWith(`${root}/`))
    assert.ok(covered, `session workspace ${sessionRoot} is not covered by workspaces: ${JSON.stringify(config.workspaces)}`)
  })

  it('keeps the path boundary: a sibling prefix is NOT granted', async () => {
    const { Context } = await import(pathToFileURL(CORDIS).href)
    const pm = await import(pathToFileURL(PROVIDER).href)
    const LocalSandboxProvider = pm.LocalSandboxProvider ?? pm.default
    const { default: plugin } = await import(new URL('../lib/index.js', import.meta.url))
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider)
    await ctx.plugin(plugin, config)
    const res = await ctx.sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: '/definitely-not-granted', sessionId: 's' })
    assert.ok(!res.argv.includes('--dev-bind'), 'unrelated workspace must stay ungranted')
    await ctx.fiber.dispose()
  })

  it('injects --dev-bind and yields working CUDA for every EXISTING granted root', async () => {
    const { Context } = await import(pathToFileURL(CORDIS).href)
    const pm = await import(pathToFileURL(PROVIDER).href)
    const LocalSandboxProvider = pm.LocalSandboxProvider ?? pm.default
    const { default: plugin } = await import(new URL('../lib/index.js', import.meta.url))
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider)
    await ctx.plugin(plugin, config)

    const roots = config.workspaces.filter(root => existsSync(root))
    assert.ok(roots.length > 0, 'no granted root exists on disk; nothing to verify')
    for (const root of roots) {
      const res = await ctx.sandbox.confine(['bash', '-c', 'nvidia-smi -L'], { mode: 'workspace-write', workspaceRoot: root, sessionId: 's' })
      assert.ok(res.argv.includes('--dev-bind'), `no --dev-bind injected for granted root ${root}`)
      if (!gpuUsable) continue
      const run = spawnSync(res.argv[0], res.argv.slice(1), { encoding: 'utf8', timeout: 20000 })
      assert.equal(run.status, 0, `wrap failed for ${root}: ${run.stderr}`)
      assert.match(run.stdout, /GPU \d+/u, `no GPU visible inside the sandbox for ${root}`)
    }
    await ctx.fiber.dispose()
  })
})
