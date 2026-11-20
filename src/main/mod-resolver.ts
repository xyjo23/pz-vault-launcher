import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import type { CompatibilityModRecord, ModSummary } from '../shared/types'

type ModInfo = Record<string, string[]>

export type ResolvedMod = {
  record: CompatibilityModRecord
  layers: string[]
  metadata: ModInfo
  tileDefinitions: Array<{ name: string; number: number }>
  variantKeys: Array<{ name: string; key: number }>
}

const parseVersion = (value: string): { major: number; minor: number; patch: number; key: number } | null => {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  const patch = Number(match[3] ?? 0)
  return { major, minor, patch, key: major * 1000 + minor }
}

export const gameVersionKey = (value: string): number => parseVersion(value)?.key ?? -1

const readModInfo = async (filePath: string): Promise<ModInfo> => {
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')
    const result: ModInfo = {}
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/)
      if (!match) continue
      const key = match[1].trim().toLowerCase()
      const value = match[2].trim().replace(/^['"]|['"]$/g, '')
      if (!result[key]) result[key] = []
      result[key].push(value)
    }
    return result
  } catch {
    return {}
  }
}

const firstValue = (info: ModInfo, key: string): string | null => info[key]?.find((value) => value.length > 0) ?? null

const splitIds = (info: ModInfo, key: string): string[] => {
  const values = info[key] ?? []
  return [...new Set(values.flatMap((value) => value.split(/[;,]/)).map((value) => value.trim().replace(/^\\+/, '')).filter(Boolean))]
}

const fallbackModName = (directoryName: string): string =>
  directoryName.replace(/^WS\d+__/, '').replace(/[_-]+/g, ' ').trim() || directoryName

const resolveModRoot = async (
  rootPath: string,
  targetVersion: string,
  workshopId: string | null,
  source: CompatibilityModRecord['source'],
  keyPrefix: string
): Promise<ResolvedMod> => {
  const target = parseVersion(targetVersion)
  const entries = await fs.readdir(rootPath, { withFileTypes: true })
  const variants = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, parsed: parseVersion(entry.name) }))
    .filter((entry): entry is { name: string; parsed: NonNullable<ReturnType<typeof parseVersion>> } => Boolean(entry.parsed))
    .filter((entry) => !target || entry.parsed.major === target.major)
    .sort((left, right) => left.parsed.key - right.parsed.key || left.name.localeCompare(right.name, 'en'))
  const compatible = variants.filter((variant) => !target || variant.parsed.key <= target.key)
  const selected = compatible.at(-1) ?? null
  const commonPath = path.join(rootPath, 'common')
  const hasCommon = existsSync(commonPath)
  const usesVersionLayout = hasCommon || variants.length > 0
  const layers = usesVersionLayout
    ? [hasCommon ? commonPath : null, selected ? path.join(rootPath, selected.name) : null].filter((value): value is string => Boolean(value))
    : [rootPath]

  const rootMetadata = await readModInfo(path.join(rootPath, 'mod.info'))
  const commonMetadata = hasCommon ? await readModInfo(path.join(commonPath, 'mod.info')) : {}
  const selectedMetadata = selected ? await readModInfo(path.join(rootPath, selected.name, 'mod.info')) : {}
  const metadata = Object.keys(selectedMetadata).length
    ? selectedMetadata
    : Object.keys(commonMetadata).length
      ? commonMetadata
      : rootMetadata
  const modId = firstValue(metadata, 'id')?.replace(/^\\+/, '') ?? null
  const name = firstValue(metadata, 'name') ?? fallbackModName(path.basename(rootPath))
  const tileDefinitions = (metadata.tiledef ?? []).flatMap((value) => value.split(',')).flatMap((value) => {
    const match = value.trim().match(/^(.*?)\s+(\d+)$/)
    return match ? [{ name: match[1].trim(), number: Number(match[2]) }] : []
  })

  return {
    record: {
      key: `${keyPrefix}:${path.basename(rootPath)}`,
      name,
      modId,
      workshopId,
      source,
      rootPath,
      selectedVersion: selected?.name ?? null,
      variants: variants.map((variant) => variant.name),
      versionMin: firstValue(metadata, 'versionmin'),
      versionMax: firstValue(metadata, 'versionmax'),
      require: splitIds(metadata, 'require'),
      incompatible: splitIds(metadata, 'incompatible'),
      loadAfter: splitIds(metadata, 'loadmodafter'),
      loadBefore: splitIds(metadata, 'loadmodbefore'),
      active: false
    },
    layers,
    metadata,
    tileDefinitions,
    variantKeys: variants.map((variant) => ({ name: variant.name, key: variant.parsed.key }))
  }
}

const discoverProjectMods = async (projectPath: string, workshopId: string, targetVersion: string): Promise<ResolvedMod[]> => {
  const modsPath = path.join(projectPath, 'mods')
  if (!existsSync(modsPath)) return []
  const entries = await fs.readdir(modsPath, { withFileTypes: true })
  return Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
    resolveModRoot(path.join(modsPath, entry.name), targetVersion, workshopId, 'Workshop', workshopId)
  ))
}

const directoryEntries = async (rootPath: string): Promise<import('node:fs').Dirent[]> => {
  const entries = await fs.readdir(rootPath, { withFileTypes: true })
  const result: import('node:fs').Dirent[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) result.push(entry)
    else if (entry.isSymbolicLink()) {
      try {
        if ((await fs.stat(path.join(rootPath, entry.name))).isDirectory()) result.push(entry)
      } catch {
        // Broken junctions are intentionally ignored; the health check reports them.
      }
    }
  }
  return result
}

export const discoverWorkshopMods = async (workshopPath: string | null, targetVersion: string): Promise<ResolvedMod[]> => {
  if (!workshopPath || !existsSync(workshopPath)) return []
  const projects = await fs.readdir(workshopPath, { withFileTypes: true })
  const groups = await Promise.all(projects.filter((entry) => entry.isDirectory()).map((entry) =>
    discoverProjectMods(path.join(workshopPath, entry.name), entry.name, targetVersion)
  ))
  return groups.flat()
}

export const discoverLocalMods = async (modsPath: string | null, targetVersion: string): Promise<ResolvedMod[]> => {
  if (!modsPath || !existsSync(modsPath)) return []
  const entries = await directoryEntries(modsPath)
  const result: ResolvedMod[] = []
  for (const entry of entries) {
    const entryPath = path.join(modsPath, entry.name)
    if (/^\d+$/.test(entry.name) && existsSync(path.join(entryPath, 'mods'))) {
      result.push(...await discoverProjectMods(entryPath, entry.name, targetVersion))
      continue
    }
    const workshopId = entry.name.match(/^WS(\d+)__/)?.[1] ?? null
    result.push(await resolveModRoot(entryPath, targetVersion, workshopId, workshopId ? 'Workshop' : 'Local', workshopId ?? 'local'))
  }
  return result
}

export const toModSummaries = (mods: ResolvedMod[]): ModSummary[] => mods.map(({ record }) => ({
  key: record.key,
  name: record.name,
  modId: record.modId,
  workshopId: record.workshopId,
  source: record.source
})).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

export const collectLayerFiles = async (layers: string[]): Promise<Map<string, string>> => {
  const files = new Map<string, string>()
  for (const layer of layers) {
    if (!existsSync(layer)) continue
    const pending = ['']
    while (pending.length) {
      const relativeDirectory = pending.pop()!
      const directory = path.join(layer, relativeDirectory)
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = path.join(relativeDirectory, entry.name)
        if (entry.isDirectory()) pending.push(relative)
        else if (entry.isFile() && relative.toLowerCase() !== 'mod.info') files.set(relative.toLowerCase(), relative)
      }
    }
  }
  return files
}
