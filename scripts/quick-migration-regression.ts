import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { activateVersion, getSnapshot, listCurrentMods, runAction } from '../src/main/vault-service'

const testRoot = process.env.PZ_E2E_ROOT
const versionId = process.env.PZ_E2E_EXISTING_ID
if (!testRoot || !versionId) throw new Error('PZ_E2E_ROOT and PZ_E2E_EXISTING_ID are required.')

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

const main = async (): Promise<void> => {
  app.setPath('userData', path.join(testRoot, '.launcher-user-data'))
  await app.whenReady()
  await activateVersion(versionId)
  const snapshot = await getSnapshot()
  if (!snapshot.isHealthy || !snapshot.config) throw new Error(snapshot.issue ?? 'Version is unhealthy.')
  const config = snapshot.config
  const references = config.ReferencedMods ?? []
  if (config.StorageMode !== 'ThinReference' || references.length < 2) throw new Error('Expected a thin version with at least two MOD references.')

  const baselineVerify = await runAction('Verify')
  if (!baselineVerify.ok) throw new Error(baselineVerify.output)
  const realPathMismatches: string[] = []
  for (const reference of references) {
    if (reference.linkMode === 'hardlink') continue
    const [sourceRealPath, targetRealPath] = await Promise.all([fs.realpath(reference.sourcePath), fs.realpath(reference.targetPath)])
    if (path.resolve(sourceRealPath).toLowerCase() !== path.resolve(targetRealPath).toLowerCase()) realPathMismatches.push(reference.name)
  }
  if (realPathMismatches.length) throw new Error(`Incorrect junction targets: ${realPathMismatches.join(', ')}`)

  const mods = await listCurrentMods()
  if (mods.length !== references.length || mods.some((mod) => !mod.modId)) throw new Error(`MOD resolver mismatch: ${mods.length}/${references.length}`)

  const baseOfflinePath = `${config.BaseFreezeRoot}.e2e-offline`
  if (!config.BaseFreezeRoot || existsSync(baseOfflinePath)) throw new Error('Base dependency test path is unavailable.')
  await fs.rename(config.BaseFreezeRoot, baseOfflinePath)
  try {
    const unhealthy = await getSnapshot()
    if (unhealthy.isHealthy || !unhealthy.issue?.includes('基础冻结版')) throw new Error('Missing base dependency was not detected.')
  } finally {
    await fs.rename(baseOfflinePath, config.BaseFreezeRoot)
  }

  const broken = references[0]
  const brokenOfflinePath = `${broken.targetPath}.e2e-offline`
  await fs.rename(broken.targetPath, brokenOfflinePath)
  try {
    const unhealthy = await getSnapshot()
    if (unhealthy.isHealthy || !unhealthy.issue?.includes(broken.name)) throw new Error('Missing MOD junction was not detected.')
  } finally {
    await fs.rename(brokenOfflinePath, broken.targetPath)
  }

  const wrong = references[0]
  const wrongTarget = references[1]
  const correctOfflinePath = `${wrong.targetPath}.e2e-correct`
  await fs.rename(wrong.targetPath, correctOfflinePath)
  try {
    await fs.symlink(wrongTarget.sourcePath, wrong.targetPath, 'junction')
    const wrongVerify = await runAction('Verify')
    if (wrongVerify.ok || !wrongVerify.output.includes('[错链][MOD 引用]')) throw new Error('Wrong MOD junction target was not detected.')
  } finally {
    if (existsSync(wrong.targetPath)) await fs.unlink(wrong.targetPath)
    await fs.rename(correctOfflinePath, wrong.targetPath)
  }
  const restoredVerify = await runAction('Verify')
  if (!restoredVerify.ok) throw new Error(`Reference restore failed: ${restoredVerify.output}`)

  const baseOptions = path.join(config.BaseFreezeRoot, '..', '..', '..', 'cache', 'options.ini')
  const actualBaseOptions = path.join(path.dirname(config.GamePath), 'cache', 'options.ini')
  const sourceOptions = existsSync(actualBaseOptions) ? actualBaseOptions : baseOptions
  const targetOptions = path.join(config.CachePath, 'options.ini')
  const [sourceBefore, targetBefore] = await Promise.all([fs.readFile(sourceOptions), fs.readFile(targetOptions)])
  await fs.writeFile(targetOptions, Buffer.concat([targetBefore, Buffer.from('\n# E2E isolation marker\n', 'utf8')]))
  try {
    const sourceAfter = await fs.readFile(sourceOptions)
    if (hash(sourceBefore) !== hash(sourceAfter)) throw new Error('Target cache mutation changed the base cache.')
  } finally {
    await fs.writeFile(targetOptions, targetBefore)
  }

  const launchResults: Array<{ round: number; pid: number; aliveAfterSeconds: number }> = []
  for (let round = 1; round <= 3; round += 1) {
    const launch = await runAction('Launch')
    const pid = Number(launch.output.match(/PID=(\d+)/)?.[1])
    if (!launch.ok || !Number.isInteger(pid)) throw new Error(`Launch ${round} did not return a PID: ${launch.output}`)
    await wait(10_000)
    try {
      process.kill(pid, 0)
    } catch {
      throw new Error(`Launch ${round} exited before the 10-second observation.`)
    }
    launchResults.push({ round, pid, aliveAfterSeconds: 10 })
    process.kill(pid)
    await wait(1_500)
  }

  console.log(`E2E_REGRESSION=${JSON.stringify({
    versionId,
    version: config.Version,
    revision: config.Revision,
    references: references.length,
    resolvedMods: mods.length,
    baseOfflineDetected: true,
    missingJunctionDetected: true,
    wrongJunctionDetected: true,
    cacheIsolation: true,
    launches: launchResults
  })}`)
}

void main().then(() => app.quit()).catch((error) => {
  console.error(`E2E_FATAL=${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  app.exit(1)
})
