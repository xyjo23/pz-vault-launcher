import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import type { FreezeConfig, MigrationStorageAnalysis, ReferencedModRoot } from '../shared/types'
import { discoverLocalMods, type ResolvedMod } from './mod-resolver'

type TreeFile = { relativePath: string; fullPath: string; bytes: number }

export type QuickMigrationPlan = {
  analysis: MigrationStorageAnalysis
  sourceRoot: string
  sourceGamePath: string
  sourceCachePath: string
  mutableFiles: TreeFile[]
  referencedMods: ReferencedModRoot[]
  modFiles: Map<string, TreeFile[]>
}

const generatedDirectories = new Set(['logs', 'recording', 'screenshots'])
const generatedFiles = new Set(['console.txt', 'logs.zip'])
const planCache = new Map<string, { expires: number; promise: Promise<QuickMigrationPlan> }>()

const walkFiles = async (root: string): Promise<TreeFile[]> => {
  if (!existsSync(root)) return []
  const files: TreeFile[] = []
  const pending = ['']
  while (pending.length) {
    const relativeDirectory = pending.pop()!
    const directory = path.join(root, relativeDirectory)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const fileEntries: Array<{ relativePath: string; fullPath: string }> = []
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name)
      const fullPath = path.join(root, relativePath)
      if (entry.isDirectory()) pending.push(relativePath)
      else if (entry.isFile()) fileEntries.push({ relativePath, fullPath })
    }
    for (let index = 0; index < fileEntries.length; index += 64) {
      files.push(...await Promise.all(fileEntries.slice(index, index + 64).map(async (file) => ({
        ...file,
        bytes: (await fs.stat(file.fullPath)).size
      }))))
    }
  }
  return files
}

const findFiles = async (root: string, fileName: string, maxDepth: number): Promise<string[]> => {
  if (!existsSync(root)) return []
  const result: string[] = []
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of await fs.readdir(current.directory, { withFileTypes: true })) {
      const fullPath = path.join(current.directory, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) result.push(fullPath)
      else if (entry.isDirectory() && current.depth < maxDepth) pending.push({ directory: fullPath, depth: current.depth + 1 })
    }
  }
  return result
}

const unique = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))]

const parseSaveMods = async (filePath: string): Promise<string[]> => {
  const raw = await fs.readFile(filePath, 'utf8')
  return unique(raw.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*mod\s*=\s*(.*?)\s*,?\s*$/i)
    return match?.[1]?.trim() ? [match[1].trim()] : []
  }))
}

const parseIniList = (raw: string, key: string): string[] => {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'im'))
  return match?.[1] ? unique(match[1].split(/[;,]/)) : []
}

const findActiveContext = async (cachePath: string): Promise<{ ids: string[]; contextPath: string | null }> => {
  const saveFiles = await findFiles(path.join(cachePath, 'Saves'), 'mods.txt', 4)
  const saveStats = await Promise.all(saveFiles.map(async (filePath) => ({ filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs })))
  const latestSave = saveStats.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
  const ids = latestSave ? await parseSaveMods(latestSave.filePath) : []
  const serverRoot = path.join(cachePath, 'Server')
  if (existsSync(serverRoot)) {
    for (const entry of await fs.readdir(serverRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ini')) continue
      const raw = await fs.readFile(path.join(serverRoot, entry.name), 'utf8')
      ids.push(...parseIniList(raw, 'Mods'))
    }
  }
  return { ids: unique(ids), contextPath: latestSave?.filePath ?? null }
}

const isMutableCacheFile = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const [topLevel] = normalized.split('/')
  if (topLevel === 'mods' || generatedDirectories.has(topLevel)) return false
  const name = path.basename(normalized)
  if (generatedFiles.has(name) || name.endsWith('.log') || name.endsWith('.dmp') || name.endsWith('.tmp')) return false
  return true
}

const assignTargetNames = (mods: ResolvedMod[]): Array<{ mod: ResolvedMod; name: string }> => {
  const used = new Set<string>()
  return mods.sort((left, right) => left.record.rootPath.localeCompare(right.record.rootPath, 'en')).map((mod) => {
    const base = path.basename(mod.record.rootPath).replace(/[\\/:*?"<>|]/g, '_') || 'mod'
    let name = base
    let suffix = 2
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`
    used.add(name.toLowerCase())
    return { mod, name }
  })
}

const buildPlan = async (sourceRoot: string, config: FreezeConfig): Promise<QuickMigrationPlan> => {
  const sourceGamePath = config.GamePath || path.join(sourceRoot, 'game')
  const sourceCachePath = config.CachePath || path.join(sourceRoot, 'cache')
  const [gameFiles, cacheFiles, installedMods, context] = await Promise.all([
    walkFiles(sourceGamePath),
    walkFiles(sourceCachePath),
    discoverLocalMods(path.join(sourceCachePath, 'mods'), config.Version ?? 'unknown'),
    findActiveContext(sourceCachePath)
  ])

  const byId = new Map<string, ResolvedMod[]>()
  for (const mod of installedMods) {
    const id = mod.record.modId
    if (!id) continue
    const group = byId.get(id) ?? []
    group.push(mod)
    byId.set(id, group)
  }

  const fallbackToAllMods = context.ids.length === 0
  const requestedIds = fallbackToAllMods
    ? unique(installedMods.flatMap((mod) => mod.record.modId ? [mod.record.modId] : []))
    : [...context.ids]
  const selectedIds = new Set(requestedIds)
  const pending = [...requestedIds]
  while (pending.length) {
    const id = pending.pop()!
    for (const mod of byId.get(id) ?? []) {
      for (const dependency of mod.record.require) {
        if (selectedIds.has(dependency)) continue
        selectedIds.add(dependency)
        pending.push(dependency)
      }
    }
  }
  const missingModIds = [...selectedIds].filter((id) => !byId.has(id)).sort((left, right) => left.localeCompare(right, 'en'))
  const selectedRoots = new Map<string, ResolvedMod>()
  for (const id of selectedIds) {
    for (const mod of byId.get(id) ?? []) selectedRoots.set(path.resolve(mod.record.rootPath).toLowerCase(), mod)
  }
  // A stale save can reference MOD IDs that no longer exist in the frozen source.
  // The thin version must still be able to preserve that source faithfully: keep
  // the missing-ID evidence, but materialize every MOD that is actually present
  // instead of silently producing a smaller and less useful subset.
  if (fallbackToAllMods || missingModIds.length > 0) {
    for (const mod of installedMods) selectedRoots.set(path.resolve(mod.record.rootPath).toLowerCase(), mod)
  }

  const referencedMods: ReferencedModRoot[] = []
  const modFiles = new Map<string, TreeFile[]>()
  for (const { mod, name } of assignTargetNames([...selectedRoots.values()])) {
    const relativeRoot = path.relative(sourceCachePath, mod.record.rootPath).toLowerCase()
    const normalizedRoot = `${relativeRoot}${path.sep}`
    const files = relativeRoot.startsWith('..')
      ? await walkFiles(mod.record.rootPath)
      : cacheFiles.filter((file) => file.relativePath.toLowerCase().startsWith(normalizedRoot))
    modFiles.set(mod.record.rootPath, files.map((file) => ({
      relativePath: path.relative(mod.record.rootPath, file.fullPath),
      fullPath: file.fullPath,
      bytes: file.bytes
    })))
    referencedMods.push({
      name,
      sourcePath: mod.record.rootPath,
      targetPath: '',
      modIds: unique([mod.record.modId ?? '']),
      workshopId: mod.record.workshopId,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0)
    })
  }

  const mutableFiles = cacheFiles.filter((file) => isMutableCacheFile(file.relativePath))
  const mutableBytes = mutableFiles.reduce((sum, file) => sum + file.bytes, 0)
  const gameBytes = gameFiles.reduce((sum, file) => sum + file.bytes, 0)
  const cacheBytes = cacheFiles.reduce((sum, file) => sum + file.bytes, 0)
  const referencedModFiles = referencedMods.reduce((sum, mod) => sum + mod.files, 0)
  const referencedModBytes = referencedMods.reduce((sum, mod) => sum + mod.bytes, 0)
  const omittedFiles = Math.max(0, cacheFiles.length - mutableFiles.length - referencedModFiles)
  const omittedBytes = Math.max(0, cacheBytes - mutableBytes - referencedModBytes)
  const analysis: MigrationStorageAnalysis = {
    strategy: 'ThinReference',
    sourceGameFiles: gameFiles.length,
    sourceGameBytes: gameBytes,
    sourceCacheFiles: cacheFiles.length,
    sourceCacheBytes: cacheBytes,
    copiedMutableFiles: mutableFiles.length,
    copiedMutableBytes: mutableBytes,
    referencedModRoots: referencedMods.length,
    referencedModFiles,
    referencedModBytes,
    omittedFiles,
    omittedBytes,
    estimatedWriteBytes: mutableBytes,
    estimatedSavedBytes: Math.max(0, gameBytes + cacheBytes - mutableBytes),
    activeModIds: [...selectedIds].sort((left, right) => left.localeCompare(right, 'en')),
    missingModIds,
    contextPath: context.contextPath,
    fallbackToAllMods
  }
  return { analysis, sourceRoot, sourceGamePath, sourceCachePath, mutableFiles, referencedMods, modFiles }
}

export const analyzeQuickMigration = (sourceRoot: string, config: FreezeConfig): Promise<QuickMigrationPlan> => {
  const key = `${path.resolve(sourceRoot).toLowerCase()}|${config.Version ?? ''}|${config.GameJarSHA256 ?? ''}`
  const cached = planCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.promise
  const promise = buildPlan(sourceRoot, config)
  planCache.set(key, { expires: Date.now() + 30_000, promise })
  promise.catch(() => planCache.delete(key))
  return promise
}

export const materializeQuickMigration = async (plan: QuickMigrationPlan, targetCachePath: string): Promise<ReferencedModRoot[]> => {
  await fs.mkdir(targetCachePath, { recursive: true })
  const mutableDirectories = [...new Set(plan.mutableFiles.map((file) => path.dirname(file.relativePath)).filter((directory) => directory !== '.'))]
  for (let index = 0; index < mutableDirectories.length; index += 64) {
    await Promise.all(mutableDirectories.slice(index, index + 64).map((directory) => fs.mkdir(path.join(targetCachePath, directory), { recursive: true })))
  }
  for (let index = 0; index < plan.mutableFiles.length; index += 32) {
    await Promise.all(plan.mutableFiles.slice(index, index + 32).map(async (file) => {
      const destination = path.join(targetCachePath, file.relativePath)
      await fs.copyFile(file.fullPath, destination)
    }))
  }
  const targetModsPath = path.join(targetCachePath, 'mods')
  await fs.mkdir(targetModsPath, { recursive: true })
  const result: ReferencedModRoot[] = []
  for (const mod of plan.referencedMods) {
    const targetPath = path.join(targetModsPath, mod.name)
    await fs.mkdir(targetPath, { recursive: true })
    const files = plan.modFiles.get(mod.sourcePath) ?? await walkFiles(mod.sourcePath)
    const directories = [...new Set(files.map((file) => path.dirname(file.relativePath)).filter((directory) => directory !== '.'))]
    for (let index = 0; index < directories.length; index += 64) {
      await Promise.all(directories.slice(index, index + 64).map((directory) => fs.mkdir(path.join(targetPath, directory), { recursive: true })))
    }
    let linkedFiles = 0
    let copiedFiles = 0
    for (let index = 0; index < files.length; index += 128) {
      await Promise.all(files.slice(index, index + 128).map(async (file) => {
        const destination = path.join(targetPath, file.relativePath)
        try {
          await fs.link(file.fullPath, destination)
          linkedFiles += 1
        } catch {
          await fs.copyFile(file.fullPath, destination)
          copiedFiles += 1
        }
      }))
    }
    result.push({ ...mod, targetPath, linkMode: 'hardlink', linkedFiles, copiedFiles })
  }
  return result
}
