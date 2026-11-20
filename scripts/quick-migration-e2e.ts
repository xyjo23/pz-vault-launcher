import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import type { MigrationRequest } from '../src/shared/types'
import { executeMigration, previewMigration } from '../src/main/migration-service'
import { activateVersion, getSnapshot, listCurrentMods, runAction } from '../src/main/vault-service'

const testRoot = process.env.PZ_E2E_ROOT
const baseFreezeRoot = process.env.PZ_E2E_BASE
const label = process.env.PZ_E2E_LABEL ?? `QuickMigration_E2E_${Date.now()}`
const existingId = process.env.PZ_E2E_EXISTING_ID

if (!testRoot || !baseFreezeRoot) throw new Error('PZ_E2E_ROOT and PZ_E2E_BASE are required.')
if (!existsSync(path.join(baseFreezeRoot, 'metadata', 'freeze.json'))) throw new Error(`Invalid base freeze: ${baseFreezeRoot}`)

const userData = path.join(testRoot, '.launcher-user-data')
const frozenRoot = path.join(testRoot, 'frozen')
const sourceId = '__e2e_base_source'
const sourceAlias = path.join(frozenRoot, sourceId)

const main = async (): Promise<void> => {
  app.setPath('userData', userData)
  await fs.mkdir(frozenRoot, { recursive: true })
  await fs.mkdir(userData, { recursive: true })
  if (existsSync(sourceAlias) && (await fs.lstat(sourceAlias)).isSymbolicLink()) await fs.unlink(sourceAlias)
  await fs.mkdir(path.join(sourceAlias, 'metadata'), { recursive: true })
  await fs.copyFile(path.join(baseFreezeRoot, 'metadata', 'freeze.json'), path.join(sourceAlias, 'metadata', 'freeze.json'))
  await fs.writeFile(path.join(userData, 'launcher-settings.json'), JSON.stringify({ managerRoot: testRoot, activeSource: 'Frozen' }, null, 2), 'utf8')

  await app.whenReady()

  const request: MigrationRequest = {
    sourceType: 'Frozen',
    sourceId,
    mode: 'FastLink',
    label,
    protectSaves: false
  }

  if (existingId) {
    await activateVersion(existingId)
    console.log(`E2E_REUSE=${JSON.stringify({ existingId })}`)
  } else {
    const preview = await previewMigration(request)
    console.log(`E2E_PREVIEW=${JSON.stringify({
      canRun: preview.canRun,
      targetPath: preview.targetPath,
      warnings: preview.warnings,
      analysis: preview.analysis ? {
        writeBytes: preview.analysis.estimatedWriteBytes,
        savedBytes: preview.analysis.estimatedSavedBytes,
        modRoots: preview.analysis.referencedModRoots,
        missingModIds: preview.analysis.missingModIds
      } : null
    })}`)
    if (!preview.canRun) throw new Error(`Preview blocked: ${preview.warnings.join(' | ')}`)

    const migration = await executeMigration(request)
    console.log(`E2E_MIGRATION=${JSON.stringify(migration)}`)
    if (!migration.ok) throw new Error(migration.output)
  }

  const snapshot = await getSnapshot()
  console.log(`E2E_SNAPSHOT=${JSON.stringify({
    healthy: snapshot.isHealthy,
    activeSource: snapshot.activeSource,
    issue: snapshot.issue,
    freezeRoot: snapshot.config?.FreezeRoot,
    gamePath: snapshot.config?.GamePath,
    cachePath: snapshot.config?.CachePath,
    storageMode: snapshot.config?.StorageMode,
    baseFreezeRoot: snapshot.config?.BaseFreezeRoot,
    referencedMods: snapshot.config?.ReferencedMods?.length
  })}`)
  if (!snapshot.isHealthy || snapshot.config?.StorageMode !== 'ThinReference') throw new Error(snapshot.issue ?? 'Thin version is not healthy.')

  const mods = await listCurrentMods()
  console.log(`E2E_MODS=${JSON.stringify({ resolved: mods.length, withModId: mods.filter((mod) => mod.modId).length })}`)

  const verify = await runAction('Verify')
  console.log(`E2E_VERIFY=${JSON.stringify(verify)}`)
  if (!verify.ok) throw new Error(verify.output)

  const launch = await runAction('Launch')
  console.log(`E2E_LAUNCH=${JSON.stringify(launch)}`)
  if (!launch.ok) throw new Error(launch.output)
}

void main().then(() => app.quit()).catch((error) => {
  console.error(`E2E_FATAL=${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  app.exit(1)
})
