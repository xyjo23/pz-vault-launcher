import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import type { CompatibilityModRecord, ModSummary } from '../shared/types'

type ModInfo = Record<string, string[]>

export type ResolvedMod = {
  record: CompatibilityModRecord
  layers: string[]
  metadata: ModInfo
  metadataPath: string | null
  metadataError: string | null
  resolutionIssue: string | null
  tileDefinitions: Array<{ name: string; number: number }>
  variantKeys: Array<{ name: string; key: number }>
}

const parseVersion = (value: string): { major: number; minor: number; patch: number; key: number } | null => {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  const patch = Number(match[3] ?? 0)
  return { major, minor, patch, key: major * 1_000_000 + minor * 1_000 + patch }
}

export const gameVersionKey = (value: string): number => parseVersion(value)?.key ?? -1

const readModInfo = async (filePath: string): Promise<{ data: ModInfo; error: string | null }> => {
  if (!existsSync(filePath)) return { data: {}, error: null }
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
    return { data: result, error: null }
  } catch (error) {
    return { data: {}, error: error instanceof Error ? error.message : '读取失败' }
  }
}

const firstValue = (info: ModInfo, key: string): string | null => info[key]?.find((value) => value.length > 0) ?? null

export const normalizeModId = (value: string): string => value.trim().replace(/^[\\+]+/, '').trim()

const splitIds = (info: ModInfo, key: string): string[] => {
  const values = info[key] ?? []
  return [...new Set(values.flatMap((value) => value.split(/[;,]/)).map(normalizeModId).filter(Boolean))]
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
  const allVariants = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, parsed: parseVersion(entry.name) }))
    .filter((entry): entry is { name: string; parsed: NonNullable<ReturnType<typeof parseVersion>> } => Boolean(entry.parsed))
  const variants = allVariants
    .filter((entry) => !target || entry.parsed.major === target.major)
    .sort((left, right) => left.parsed.key - right.parsed.key || left.name.localeCompare(right.name, 'en'))
  const compatible = variants.filter((variant) => !target || variant.parsed.key <= target.key)
  const selected = compatible.at(-1) ?? null
  const commonPath = path.join(rootPath, 'common')
  const hasCommon = existsSync(commonPath)
  const usesVersionLayout = hasCommon || allVariants.length > 0
  const layers = usesVersionLayout
    ? [hasCommon ? commonPath : null, selected ? path.join(rootPath, selected.name) : null].filter((value): value is string => Boolean(value))
    : [rootPath]

  const rootMetadataPath = path.join(rootPath, 'mod.info')
  const commonMetadataPath = path.join(commonPath, 'mod.info')
  const selectedMetadataPath = selected ? path.join(rootPath, selected.name, 'mod.info') : null
  const rootMetadata = await readModInfo(rootMetadataPath)
  const commonMetadata = hasCommon ? await readModInfo(commonMetadataPath) : { data: {}, error: null }
  const selectedMetadata = selectedMetadataPath ? await readModInfo(selectedMetadataPath) : { data: {}, error: null }
  const metadataSource = Object.keys(selectedMetadata.data).length
    ? { data: selectedMetadata.data, path: selectedMetadataPath }
    : Object.keys(commonMetadata.data).length
      ? { data: commonMetadata.data, path: commonMetadataPath }
      : { data: rootMetadata.data, path: existsSync(rootMetadataPath) ? rootMetadataPath : null }
  const metadata = metadataSource.data
  const metadataErrors = [
    selectedMetadataPath && existsSync(selectedMetadataPath) && selectedMetadata.error ? `${selectedMetadataPath}：${selectedMetadata.error}` : null,
    !Object.keys(selectedMetadata.data).length && hasCommon && existsSync(commonMetadataPath) && commonMetadata.error ? `${commonMetadataPath}：${commonMetadata.error}` : null,
    metadataSource.path === rootMetadataPath && rootMetadata.error ? `${rootMetadataPath}：${rootMetadata.error}` : null
  ].filter((value): value is string => Boolean(value))
  const resolutionIssue = usesVersionLayout && layers.length === 0
    ? `没有适用于游戏 ${targetVersion} 的 common 或版本目录；可见目录：${allVariants.map((variant) => variant.name).join('、') || '无'}`
    : null
  const modId = firstValue(metadata, 'id') ? normalizeModId(firstValue(metadata, 'id')!) : null
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
    metadataPath: metadataSource.path,
    metadataError: metadataErrors.length ? metadataErrors.join('；') : null,
    resolutionIssue,
    tileDefinitions,
    variantKeys: allVariants.map((variant) => ({ name: variant.name, key: variant.parsed.key }))
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
