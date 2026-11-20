import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import type {
  CompatibilityContext,
  CompatibilityIssue,
  CompatibilityReport,
  CompatibilitySeverity,
  FileOverlap,
  FileOverlapClassification,
  GameIdentity
} from '../shared/types'
import { readGameIdentity } from './game-identity'
import { detectSteamInstallation } from './steam-service'
import { collectLayerFiles, discoverLocalMods, discoverWorkshopMods, gameVersionKey, type ResolvedMod } from './mod-resolver'
import { getSnapshot } from './vault-service'

type AnalysisSource = {
  source: 'Steam' | 'Frozen'
  label: string
  gamePath: string
  cachePath: string
  workshopPath: string | null
  buildId: string
  identity: GameIdentity
  outputRoot: string
  frozenRevision: string | null
  frozenHash: string | null
}

const severityRank: Record<CompatibilitySeverity, number> = { blocker: 0, warning: 1, unknown: 2, pass: 3 }

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))]

const issue = (
  id: string,
  severity: CompatibilitySeverity,
  category: CompatibilityIssue['category'],
  title: string,
  summary: string,
  evidence: string[] = [],
  modIds: string[] = []
): CompatibilityIssue => ({ id, severity, category, title, summary, evidence, modIds: unique(modIds) })

const resolveSource = async (): Promise<AnalysisSource> => {
  const snapshot = await getSnapshot()
  if (snapshot.activeSource === 'Steam') {
    const steam = await detectSteamInstallation()
    if (!steam.detected || !steam.gamePath || !steam.cachePath) throw new Error(steam.issue ?? 'Steam 原版不可用。')
    const outputRoot = snapshot.managerRoot
      ? path.join(snapshot.managerRoot, 'reports', 'compatibility')
      : path.join(app.getPath('userData'), 'reports', 'compatibility')
    return {
      source: 'Steam',
      label: `Steam 原版 ${steam.version} · Build ${steam.buildId}`,
      gamePath: steam.gamePath,
      cachePath: steam.cachePath,
      workshopPath: steam.workshopPath,
      buildId: steam.buildId,
      identity: {
        version: steam.version,
        revision: steam.revision,
        buildId: steam.buildId,
        jarSha256: steam.gameJarSha256,
        status: steam.identityStatus,
        source: steam.identityStatus === 'cache-only' ? 'cache' : steam.version === 'unknown' ? 'unknown' : 'binary',
        cachedVersion: steam.cachedVersion,
        cachedRevision: steam.cachedRevision,
        evidence: [
          `Steam manifest：${steam.manifestPath ?? '未知'}`,
          `BuildID：${steam.buildId}`,
          `Core.class：${steam.version}`,
          `GitVersion.class：${steam.revision ?? '未知'}`,
          `projectzomboid.jar SHA-256：${steam.gameJarSha256 ?? '未知'}`,
          `运行缓存：${steam.cachedVersion ?? '无'} / ${steam.cachedRevision ?? '无'}`,
          `游戏目录：${steam.gamePath}`
        ]
      },
      outputRoot,
      frozenRevision: null,
      frozenHash: null
    }
  }

  const config = snapshot.config
  if (!config?.GamePath || !config.CachePath) throw new Error(snapshot.issue ?? '当前冻结版本不可用。')
  const identity = await readGameIdentity(config.GamePath, config.BuildID ?? 'unknown', config.CachePath)
  return {
    source: 'Frozen',
    label: config.DisplayName?.trim() || `冻结版本 ${identity.version}`,
    gamePath: config.GamePath,
    cachePath: config.CachePath,
    workshopPath: null,
    buildId: config.BuildID ?? 'unknown',
    identity,
    outputRoot: config.ReportPath || path.join(config.FreezeRoot, 'reports'),
    frozenRevision: config.Revision ?? config.FullVersion?.match(/\b([a-f0-9]{7,40})\b/i)?.[1] ?? null,
    frozenHash: config.GameJarSHA256 ?? null
  }
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

const parseSaveMods = async (filePath: string): Promise<string[]> => {
  const raw = await fs.readFile(filePath, 'utf8')
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*mod\s*=\s*(.*?)\s*,?\s*$/i)
    return match?.[1]?.trim() ? [match[1].trim()] : []
  })
}

const parseIniList = (raw: string, key: string): string[] => {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'im'))
  return match?.[1] ? unique(match[1].split(/[;,]/).map((value) => value.trim())) : []
}

const buildContexts = async (
  cachePath: string,
  installedModIds: Set<string>,
  installedWorkshopIds: Set<string>
): Promise<{ active: CompatibilityContext | null; servers: CompatibilityContext[] }> => {
  const saveFiles = await findFiles(path.join(cachePath, 'Saves'), 'mods.txt', 4)
  const saveStats = await Promise.all(saveFiles.map(async (filePath) => ({ filePath, stats: await fs.stat(filePath) })))
  const latestSave = saveStats.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]
  const active = latestSave ? (() => null as CompatibilityContext | null)() : null
  let activeContext = active
  if (latestSave) {
    const modIds = await parseSaveMods(latestSave.filePath)
    activeContext = {
      kind: 'save',
      name: path.basename(path.dirname(latestSave.filePath)),
      path: latestSave.filePath,
      modIds,
      workshopIds: [],
      missingModIds: modIds.filter((id) => !installedModIds.has(id)),
      missingWorkshopIds: []
    }
  }

  const serverRoot = path.join(cachePath, 'Server')
  const serverFiles = existsSync(serverRoot)
    ? (await fs.readdir(serverRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ini')).map((entry) => path.join(serverRoot, entry.name))
    : []
  const servers = await Promise.all(serverFiles.map(async (filePath): Promise<CompatibilityContext> => {
    const raw = await fs.readFile(filePath, 'utf8')
    const modIds = parseIniList(raw, 'Mods')
    const workshopIds = parseIniList(raw, 'WorkshopItems')
    return {
      kind: 'server',
      name: path.basename(filePath, path.extname(filePath)),
      path: filePath,
      modIds,
      workshopIds,
      missingModIds: modIds.filter((id) => !installedModIds.has(id)),
      missingWorkshopIds: workshopIds.filter((id) => !installedWorkshopIds.has(id))
    }
  }))
  return { active: activeContext, servers }
}

const classifyFile = (relativePath: string): FileOverlapClassification => {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const extension = path.extname(normalized)
  if (/^(icon|poster|preview)\.(png|jpg|jpeg)$/.test(normalized) || normalized === 'mod.info') return 'metadata'
  if (normalized.includes('/translate/')) return 'translation'
  if (normalized.includes('/tile_definitions/') || extension === '.tiles' || /tiledef/i.test(normalized)) return 'tile-definition'
  if (normalized.includes('/maps/') || ['.lotheader', '.lotpack', '.bin'].includes(extension)) return 'map'
  if (normalized.includes('/lua/') || extension === '.lua') return 'lua'
  if (normalized.includes('/scripts/') && extension === '.txt') return 'scripts'
  if (['.jar', '.class', '.dll', '.exe'].includes(extension)) return 'binary'
  if (['.png', '.jpg', '.jpeg', '.dds', '.xml', '.x', '.fbx', '.wav', '.ogg', '.bank', '.pack'].includes(extension)) return 'asset'
  return 'other'
}

const overlapSeverity = (classification: FileOverlapClassification): CompatibilitySeverity => {
  if (classification === 'translation' || classification === 'metadata') return 'pass'
  if (classification === 'scripts' || classification === 'map' || classification === 'tile-definition' || classification === 'asset') return 'warning'
  return 'unknown'
}

const findDependencyCycles = (activeIds: string[], dependencies: Map<string, string[]>): string[][] => {
  const cycles: string[][] = []
  const active = new Set(activeIds)
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      const start = stack.indexOf(id)
      if (start >= 0) cycles.push([...stack.slice(start), id])
      return
    }
    state.set(id, 1)
    stack.push(id)
    for (const dependency of dependencies.get(id) ?? []) if (active.has(dependency)) visit(dependency)
    stack.pop()
    state.set(id, 2)
  }
  for (const id of activeIds) visit(id)
  return cycles.filter((cycle, index) => cycles.findIndex((candidate) => [...candidate].sort().join('|') === [...cycle].sort().join('|')) === index)
}

const analyzeFiles = async (
  mods: ResolvedMod[],
  gamePath: string
): Promise<{ overlaps: FileOverlap[]; overlapCount: number; baseOverrideCount: number; binaryModIds: string[] }> => {
  const owners = new Map<string, { displayPath: string; modIds: Set<string> }>()
  const baseOverrides = new Set<string>()
  const binaryModIds = new Set<string>()
  for (const mod of mods) {
    const modId = mod.record.modId ?? mod.record.name
    const files = await collectLayerFiles(mod.layers)
    for (const [normalized, displayPath] of files) {
      const owner = owners.get(normalized) ?? { displayPath, modIds: new Set<string>() }
      owner.modIds.add(modId)
      owners.set(normalized, owner)
      if (existsSync(path.join(gamePath, displayPath))) baseOverrides.add(normalized)
      if (classifyFile(displayPath) === 'binary') binaryModIds.add(modId)
    }
  }
  const allOverlaps = [...owners.values()].filter((owner) => owner.modIds.size > 1).map((owner): FileOverlap => {
    const classification = classifyFile(owner.displayPath)
    return {
      relativePath: owner.displayPath,
      classification,
      severity: overlapSeverity(classification),
      modIds: [...owner.modIds].sort((left, right) => left.localeCompare(right, 'en')),
      overridesBaseGame: baseOverrides.has(owner.displayPath.toLowerCase())
    }
  }).sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.modIds.length - left.modIds.length || left.relativePath.localeCompare(right.relativePath, 'en'))
  return { overlaps: allOverlaps.slice(0, 120), overlapCount: allOverlaps.length, baseOverrideCount: baseOverrides.size, binaryModIds: [...binaryModIds] }
}

export const analyzeCompatibility = async (): Promise<CompatibilityReport> => {
  const source = await resolveSource()
  const issues: CompatibilityIssue[] = []

  if (source.identity.status === 'stale-cache') {
    issues.push(issue('identity-stale-cache', 'warning', 'identity', '运行缓存版本已过期', '游戏二进制身份与 Zomboid/version.txt 不一致；报告以二进制为准。', source.identity.evidence))
  } else if (source.identity.status === 'cache-only' || source.identity.status === 'unknown') {
    issues.push(issue('identity-unverified', 'blocker', 'identity', '无法验证游戏二进制身份', '兼容性分析不能只依赖运行缓存，请修复或验证 projectzomboid.jar。', source.identity.evidence))
  } else {
    issues.push(issue('identity-verified', 'pass', 'identity', '游戏身份已从二进制确认', `${source.identity.version} · Build ${source.identity.buildId} · revision ${source.identity.revision ?? '未知'}`, source.identity.evidence))
  }

  if (source.source === 'Frozen') {
    if (source.frozenRevision && source.identity.revision && source.frozenRevision !== source.identity.revision) {
      issues.push(issue('frozen-revision-mismatch', 'blocker', 'identity', '冻结元数据与游戏文件不一致', `元数据 revision ${source.frozenRevision}，实际二进制 revision ${source.identity.revision}。`, [source.gamePath]))
    }
    if (source.frozenHash && source.identity.jarSha256 && source.frozenHash !== source.identity.jarSha256) {
      issues.push(issue('frozen-hash-mismatch', 'blocker', 'identity', '冻结核心 JAR 已变化', '记录的 projectzomboid.jar SHA-256 与当前文件不一致。', [source.gamePath]))
    }
  }

  const workshopMods = source.workshopPath ? await discoverWorkshopMods(source.workshopPath, source.identity.version) : []
  const localMods = await discoverLocalMods(path.join(source.cachePath, 'mods'), source.identity.version)
  const roots = new Set<string>()
  const mods = [...workshopMods, ...localMods].filter((mod) => {
    const resolved = path.resolve(mod.record.rootPath).toLowerCase()
    if (roots.has(resolved)) return false
    roots.add(resolved)
    return true
  })
  const installedIds = new Set(mods.flatMap((mod) => mod.record.modId ? [mod.record.modId] : []))
  const workshopIds = new Set(mods.flatMap((mod) => mod.record.workshopId ? [mod.record.workshopId] : []))
  const contexts = await buildContexts(source.cachePath, installedIds, workshopIds)
  const selectedContext = contexts.active ?? contexts.servers[0] ?? null
  const activeOrder = selectedContext?.modIds ?? []
  const activeSet = new Set(activeOrder)
  for (const mod of mods) mod.record.active = Boolean(mod.record.modId && activeSet.has(mod.record.modId))

  if (!selectedContext) {
    issues.push(issue('context-missing', 'unknown', 'save', '没有找到启用模组上下文', '未找到存档 mods.txt 或服务器配置；文件重叠将按全部已安装 MOD 扫描。', [source.cachePath]))
  } else if (selectedContext.missingModIds.length) {
    issues.push(issue('active-mods-missing', 'blocker', selectedContext.kind, '启用列表引用了缺失 MOD', `${selectedContext.missingModIds.length} 个 Mod ID 无法在当前内容中解析。`, [selectedContext.path, ...selectedContext.missingModIds], selectedContext.missingModIds))
  } else {
    issues.push(issue('active-mods-resolved', 'pass', selectedContext.kind, '启用列表解析完整', `${activeOrder.length} 个启用 Mod ID 均有本地内容。`, [selectedContext.path]))
  }

  for (const server of contexts.servers) {
    if (server.missingModIds.length || server.missingWorkshopIds.length) {
      issues.push(issue(`server-missing-${server.name}`, 'blocker', 'server', `服务器配置“${server.name}”存在缺失内容`, `缺少 ${server.missingModIds.length} 个 Mod ID、${server.missingWorkshopIds.length} 个 Workshop 项目。`, [server.path, ...server.missingModIds, ...server.missingWorkshopIds], server.missingModIds))
    }
  }

  const byId = new Map<string, ResolvedMod[]>()
  for (const mod of mods) {
    if (!mod.record.modId) {
      issues.push(issue(`missing-id-${mod.record.key}`, 'warning', 'dependency', `MOD 缺少 id：${mod.record.name}`, '无法参与依赖、存档和服务器 Mod ID 对齐。', [mod.record.rootPath]))
      continue
    }
    const group = byId.get(mod.record.modId) ?? []
    group.push(mod)
    byId.set(mod.record.modId, group)
  }
  for (const [modId, group] of byId) {
    if (group.length > 1) issues.push(issue(`duplicate-${modId}`, 'blocker', 'dependency', `重复 Mod ID：${modId}`, `${group.length} 个目录声明了同一个运行时 Mod ID。`, group.map((mod) => mod.record.rootPath), [modId]))
  }

  for (const mod of mods) {
    const normalizedGroups = new Map<number, string[]>()
    for (const variant of mod.variantKeys) normalizedGroups.set(variant.key, [...(normalizedGroups.get(variant.key) ?? []), variant.name])
    for (const names of normalizedGroups.values()) {
      if (names.length > 1) issues.push(issue(`variant-ambiguous-${mod.record.key}-${names.join('-')}`, 'warning', 'version', `版本目录选择存在歧义：${mod.record.name}`, `${names.join('、')} 在游戏的 major.minor 规则下属于同一版本级别。`, [mod.record.rootPath], mod.record.modId ? [mod.record.modId] : []))
    }
  }

  const versionKey = gameVersionKey(source.identity.version)
  const chosenMods = activeSet.size ? mods.filter((mod) => mod.record.modId && activeSet.has(mod.record.modId)) : mods
  const chosenById = new Map(chosenMods.flatMap((mod) => mod.record.modId ? [[mod.record.modId, mod] as const] : []))
  const dependencies = new Map<string, string[]>()
  for (const mod of chosenMods) {
    const id = mod.record.modId
    if (!id) continue
    dependencies.set(id, mod.record.require)
    const min = mod.record.versionMin ? gameVersionKey(mod.record.versionMin) : -1
    const max = mod.record.versionMax ? gameVersionKey(mod.record.versionMax) : -1
    if ((min >= 0 && versionKey < min) || (max >= 0 && versionKey > max)) {
      issues.push(issue(`version-bound-${id}`, 'blocker', 'version', `版本范围不兼容：${id}`, `目标版本 ${source.identity.version}，声明范围 ${mod.record.versionMin ?? '不限'} ～ ${mod.record.versionMax ?? '不限'}。`, [mod.record.rootPath], [id]))
    }
    for (const required of mod.record.require) {
      if (!activeSet.size ? !chosenById.has(required) : !activeSet.has(required)) {
        issues.push(issue(`missing-dependency-${id}-${required}`, 'blocker', 'dependency', `缺少依赖：${id} → ${required}`, chosenById.has(required) ? '依赖已安装但未在当前上下文启用。' : '依赖未安装。', [mod.record.rootPath], [id, required]))
      }
    }
  }

  for (const cycle of findDependencyCycles([...chosenById.keys()], dependencies)) {
    issues.push(issue(`dependency-cycle-${cycle.join('-')}`, 'blocker', 'dependency', '检测到循环依赖', cycle.join(' → '), cycle, cycle))
  }

  const activeIndex = new Map(activeOrder.map((id, index) => [id, index]))
  const seenPairs = new Set<string>()
  for (const mod of chosenMods) {
    const id = mod.record.modId
    if (!id) continue
    for (const incompatible of mod.record.incompatible) {
      if (!chosenById.has(incompatible)) continue
      const pair = [id, incompatible].sort().join('|')
      if (seenPairs.has(pair)) continue
      seenPairs.add(pair)
      issues.push(issue(`incompatible-${pair}`, 'blocker', 'conflict', `互斥 MOD 同时启用：${id} / ${incompatible}`, 'mod.info 的 incompatible 规则被命中。', [mod.record.rootPath], [id, incompatible]))
    }
    if (activeSet.size) {
      const current = activeIndex.get(id) ?? -1
      const requiredBefore = unique([...mod.record.require, ...mod.record.loadAfter])
      for (const before of requiredBefore) {
        const target = activeIndex.get(before)
        if (target !== undefined && target > current) issues.push(issue(`order-after-${id}-${before}`, 'warning', 'load-order', `加载顺序不满足：${id}`, `${id} 应在 ${before} 之后加载。`, [selectedContext!.path], [id, before]))
      }
      for (const after of mod.record.loadBefore) {
        const target = activeIndex.get(after)
        if (target !== undefined && target < current) issues.push(issue(`order-before-${id}-${after}`, 'warning', 'load-order', `加载顺序不满足：${id}`, `${id} 应在 ${after} 之前加载。`, [selectedContext!.path], [id, after]))
      }
    }
  }

  const tileNumbers = new Map<number, Set<string>>()
  for (const mod of chosenMods) for (const tile of mod.tileDefinitions) {
    const owners = tileNumbers.get(tile.number) ?? new Set<string>()
    owners.add(mod.record.modId ?? mod.record.name)
    tileNumbers.set(tile.number, owners)
  }
  for (const [number, owners] of tileNumbers) if (owners.size > 1) {
    issues.push(issue(`tiledef-${number}`, 'blocker', 'conflict', `重复 tiledef 编号：${number}`, `${[...owners].join('、')} 使用相同 tiledef 文件编号。`, [`tiledef=${number}`], [...owners]))
  }

  const files = await analyzeFiles(chosenMods, source.gamePath)
  const overlapCounts = new Map<FileOverlapClassification, number>()
  for (const overlap of files.overlaps) overlapCounts.set(overlap.classification, (overlapCounts.get(overlap.classification) ?? 0) + 1)
  for (const [classification, count] of overlapCounts) {
    const severity = overlapSeverity(classification)
    if (severity === 'pass') continue
    issues.push(issue(`overlaps-${classification}`, severity, classification === 'binary' ? 'security' : 'files', `${classification} 文件存在同路径覆盖`, `报告中保留前 120 条证据；当前分类至少 ${count} 条。`, files.overlaps.filter((overlap) => overlap.classification === classification).slice(0, 8).map((overlap) => `${overlap.relativePath} ← ${overlap.modIds.join(', ')}`), unique(files.overlaps.filter((overlap) => overlap.classification === classification).flatMap((overlap) => overlap.modIds))))
  }
  if (files.baseOverrideCount) issues.push(issue('base-overrides', 'unknown', 'files', 'MOD 覆盖原版路径', `${files.baseOverrideCount} 个有效文件路径与原版游戏重合，需要结合版本 API 与内容差异继续验证。`, [source.gamePath]))
  if (files.binaryModIds.length) issues.push(issue('binary-mods', 'unknown', 'security', '检测到 Java/本地二进制 MOD', '二进制扩展依赖精确游戏 revision，且需要单独进行来源与安全验证。', files.binaryModIds, files.binaryModIds))
  if (!issues.some((entry) => entry.category === 'dependency' && entry.severity === 'blocker')) issues.push(issue('dependency-pass', 'pass', 'dependency', '依赖图未发现阻断项', '未发现缺失依赖、循环依赖或重复 Mod ID。'))
  if (!issues.some((entry) => entry.id.startsWith('tiledef-'))) issues.push(issue('tiledef-pass', 'pass', 'conflict', 'tiledef 编号未发现重复', `检查了 ${tileNumbers.size} 个有效编号。`))

  issues.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.title.localeCompare(right.title, 'zh-CN'))
  const blockers = issues.filter((entry) => entry.severity === 'blocker').length
  const warnings = issues.filter((entry) => entry.severity === 'warning').length
  const unknowns = issues.filter((entry) => entry.severity === 'unknown').length
  const passes = issues.filter((entry) => entry.severity === 'pass').length
  const verdict: CompatibilitySeverity = blockers ? 'blocker' : warnings ? 'warning' : unknowns ? 'unknown' : 'pass'
  await fs.mkdir(source.outputRoot, { recursive: true })
  const reportPath = path.join(source.outputRoot, `latest-${source.source.toLowerCase()}.json`)
  const report: CompatibilityReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: source.source,
    sourceLabel: source.label,
    reportPath,
    identity: source.identity,
    verdict,
    summary: {
      installedMods: mods.length,
      activeMods: activeOrder.length,
      workshopProjects: workshopIds.size,
      blockers,
      warnings,
      unknowns,
      passes,
      overlapPaths: files.overlapCount,
      baseGameOverrides: files.baseOverrideCount
    },
    activeContext: contexts.active,
    serverContexts: contexts.servers,
    issues,
    overlaps: files.overlaps,
    mods: mods.map((mod) => mod.record).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, 'zh-CN'))
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  return report
}
