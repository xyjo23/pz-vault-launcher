import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

import { app, dialog, shell } from 'electron'

import type { ActionResult, FreezeConfig, FreezeVersionSummary, LauncherAction, LauncherSnapshot, ModSummary } from '../shared/types'
import { readGameIdentity } from './game-identity'
import { discoverLocalMods, discoverWorkshopMods, toModSummaries } from './mod-resolver'
import { detectSteamInstallation, launchSteamGame, validateSteamGame } from './steam-service'

const ACTIONS: ReadonlySet<LauncherAction> = new Set(['Launch', 'Verify', 'BackupSave'])

const getSettingsPath = (): string => path.join(app.getPath('userData'), 'launcher-settings.json')

type LauncherSettings = { managerRoot: string | null; activeSource: 'Steam' | 'Frozen' }

const readSettings = async (): Promise<LauncherSettings> => {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as { managerRoot?: unknown }
    const managerRoot = typeof parsed.managerRoot === 'string' ? parsed.managerRoot : null
    const activeSource = (parsed as { activeSource?: unknown }).activeSource === 'Steam' ? 'Steam' : managerRoot ? 'Frozen' : 'Steam'
    return { managerRoot, activeSource }
  } catch {
    return { managerRoot: null, activeSource: 'Steam' }
  }
}

const saveManagerRoot = async (managerRoot: string): Promise<void> => {
  const settings = await readSettings()
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true })
  await fs.writeFile(getSettingsPath(), JSON.stringify({ ...settings, managerRoot }, null, 2), 'utf8')
}

const saveActiveSource = async (activeSource: LauncherSettings['activeSource']): Promise<void> => {
  const settings = await readSettings()
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true })
  await fs.writeFile(getSettingsPath(), JSON.stringify({ ...settings, activeSource }, null, 2), 'utf8')
}

const parseJson = <T>(raw: string): T => JSON.parse(raw.replace(/^\uFEFF/, '')) as T
const isAsciiPath = (value: string): boolean => /^[\x20-\x7E]+$/.test(value)

const thinDependencyIssue = (config: FreezeConfig): string | null => {
  if (config.StorageMode !== 'ThinReference') return null
  if (!isAsciiPath(config.CachePath)) return `薄版本缓存路径包含游戏启动器无法可靠解析的非 ASCII 字符：${config.CachePath}`
  if (!config.BaseFreezeRoot || !existsSync(config.BaseFreezeRoot)) return `薄版本依赖的基础冻结版不存在：${config.BaseFreezeRoot ?? '未登记'}`
  const unsupported = (config.ReferencedMods ?? []).find((mod) => mod.linkMode !== 'hardlink')
  if (unsupported) return `薄版本使用游戏无法识别的旧式 MOD 目录联接，需要重新创建：${unsupported.name}`
  const missing = (config.ReferencedMods ?? []).find((mod) => !existsSync(mod.sourcePath) || !existsSync(mod.targetPath))
  return missing ? `薄版本 MOD 引用不存在：${missing.name}` : null
}

export const listCurrentMods = async (): Promise<ModSummary[]> => {
  const snapshot = await getSnapshot()
  if (snapshot.activeSource === 'Steam') {
    const steam = await detectSteamInstallation()
    const workshop = await discoverWorkshopMods(steam.workshopPath, steam.version)
    const local = await discoverLocalMods(steam.cachePath ? path.join(steam.cachePath, 'mods') : null, steam.version)
    return toModSummaries([...workshop, ...local])
  }
  if (!snapshot.config?.GamePath || !snapshot.config.CachePath) return []
  const identity = await readGameIdentity(snapshot.config.GamePath, snapshot.config.BuildID ?? 'unknown', snapshot.config.CachePath)
  return toModSummaries(await discoverLocalMods(path.join(snapshot.config.CachePath, 'mods'), identity.version))
}

const getLastBackup = async (
  backupPath: string
): Promise<LauncherSnapshot['lastBackup']> => {
  try {
    const entries = await fs.readdir(backupPath, { withFileTypes: true })
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^cache-snapshot_.*\.zip$/i.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(backupPath, entry.name)
          const stats = await fs.stat(fullPath)
          return { name: entry.name, createdAt: stats.mtime.toISOString(), size: stats.size }
        })
    )
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  } catch {
    return null
  }
}

export const getSnapshot = async (): Promise<LauncherSnapshot> => {
  const { managerRoot, activeSource } = await readSettings()
  if (!managerRoot) {
    return {
      activeSource,
      isConfigured: false,
      isHealthy: false,
      managerRoot: null,
      enginePath: null,
      config: null,
      lastBackup: null,
      issue: null
    }
  }

  const configPath = path.join(managerRoot, 'current-freeze.json')
  const enginePath = path.join(managerRoot, 'tools', 'PZ-Freeze-Manager.ps1')

  try {
    const config = parseJson<FreezeConfig>(await fs.readFile(configPath, 'utf8'))
    const requiredPaths = [config.FreezeRoot, config.GamePath, config.CachePath]
    const missingPath = requiredPaths.find((candidate) => !candidate || !existsSync(candidate))
    const dependencyIssue = missingPath ? null : thinDependencyIssue(config)
    return {
      activeSource,
      isConfigured: true,
      isHealthy: !missingPath && !dependencyIssue,
      managerRoot,
      enginePath,
      config,
      lastBackup: await getLastBackup(config.BackupPath),
      issue: missingPath ? `Required path is missing: ${missingPath}` : dependencyIssue
    }
  } catch (error) {
    return {
      activeSource,
      isConfigured: true,
      isHealthy: false,
      managerRoot,
      enginePath,
      config: null,
      lastBackup: null,
      issue: existsSync(configPath)
        ? (error instanceof Error ? error.message : 'Unable to read the freeze configuration.')
        : '版本库已就绪，尚未创建受管版本。'
    }
  }
}

export const chooseManagerRoot = async (): Promise<LauncherSnapshot> => {
  const result = await dialog.showOpenDialog({
    title: 'Select the PZ Freeze Manager folder',
    properties: ['openDirectory'],
    buttonLabel: 'Use this folder'
  })
  if (result.canceled || !result.filePaths[0]) return getSnapshot()

  const managerRoot = result.filePaths[0]
  const entries = await fs.readdir(managerRoot)
  const looksLikeManager = existsSync(path.join(managerRoot, 'current-freeze.json')) || existsSync(path.join(managerRoot, 'tools', 'PZ-Freeze-Manager.ps1'))
  if (entries.length > 0 && !looksLikeManager) {
    await dialog.showMessageBox({
      type: 'warning',
      title: '目录中已有其他文件',
      message: '请选择空目录，或选择已有的 PZ 版本管理目录。'
    })
    return getSnapshot()
  }

  await fs.mkdir(path.join(managerRoot, 'frozen'), { recursive: true })
  await fs.mkdir(path.join(managerRoot, 'logs'), { recursive: true })
  await saveManagerRoot(managerRoot)
  return getSnapshot()
}

export const listVersions = async (): Promise<FreezeVersionSummary[]> => {
  const snapshot = await getSnapshot()
  if (!snapshot.managerRoot) return []

  const frozenRoot = path.join(snapshot.managerRoot, 'frozen')
  try {
    const entries = await fs.readdir(frozenRoot, { withFileTypes: true })
    const versions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const freezeRoot = path.join(frozenRoot, entry.name)
      const metadataPath = path.join(freezeRoot, 'metadata', 'freeze.json')
      try {
        const config = parseJson<FreezeConfig>(await fs.readFile(metadataPath, 'utf8'))
        const gamePath = config.StorageMode === 'ThinReference' ? config.GamePath : path.join(freezeRoot, 'game')
        const cachePath = config.StorageMode === 'ThinReference' ? config.CachePath : path.join(freezeRoot, 'cache')
        const dependencyHealthy = thinDependencyIssue(config) === null
        return {
          id: entry.name,
          name: config.DisplayName?.trim() || entry.name,
          freezeRoot,
          version: config.Version ?? entry.name,
          fullVersion: config.FullVersion,
          buildId: config.BuildID,
          created: config.Created,
          workshopProjectCount: config.WorkshopProjectCount,
          effectiveModCount: config.EffectiveModCount,
          storageMode: config.StorageMode ?? 'FullCopy',
          isActive: snapshot.activeSource === 'Frozen' && path.resolve(snapshot.config?.FreezeRoot ?? '') === path.resolve(freezeRoot),
          isHealthy: dependencyHealthy && existsSync(gamePath) && existsSync(cachePath)
        } satisfies FreezeVersionSummary
      } catch {
        return null
      }
    }))
    const validVersions = versions.filter((version): version is NonNullable<typeof version> => version !== null)
    return validVersions.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
  } catch {
    return []
  }
}

export const activateVersion = async (versionId: string): Promise<LauncherSnapshot> => {
  const managerRoot = (await readSettings()).managerRoot
  if (!managerRoot) throw new Error('Select a valid freeze manager folder first.')
  if (!versionId || path.basename(versionId) !== versionId) throw new Error('Invalid version identifier.')

  const freezeRoot = path.join(managerRoot, 'frozen', versionId)
  const metadataPath = path.join(freezeRoot, 'metadata', 'freeze.json')
  const configPath = path.join(managerRoot, 'current-freeze.json')
  const config = parseJson<FreezeConfig>(await fs.readFile(metadataPath, 'utf8'))
  const gamePath = config.StorageMode === 'ThinReference' ? config.GamePath : path.join(freezeRoot, 'game')
  const cachePath = config.StorageMode === 'ThinReference' ? config.CachePath : path.join(freezeRoot, 'cache')
  const dependencyIssue = thinDependencyIssue(config)
  if (dependencyIssue) throw new Error(dependencyIssue)
  if (!existsSync(gamePath) || !existsSync(cachePath)) throw new Error('The selected frozen version is incomplete.')

  const nextConfig: FreezeConfig = {
    ...config,
    ManagerRoot: managerRoot,
    FreezeRoot: freezeRoot,
    GamePath: gamePath,
    CachePath: cachePath,
    ManifestPath: path.join(freezeRoot, 'manifests'),
    ReportPath: path.join(freezeRoot, 'reports'),
    BackupPath: path.join(freezeRoot, 'backups'),
    LaunchArguments: (config.LaunchArguments ?? ['-nosteam']).map((argument) =>
      argument.startsWith('-cachedir=') ? `-cachedir=${cachePath}` : argument
    )
  }

  if (existsSync(configPath)) await fs.copyFile(configPath, `${configPath}.launcher-backup`)
  await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2), 'utf8')
  await saveActiveSource('Frozen')
  return getSnapshot()
}

export const activateSteam = async (): Promise<LauncherSnapshot> => {
  await saveActiveSource('Steam')
  return getSnapshot()
}

export const runAction = async (action: LauncherAction): Promise<ActionResult> => {
  if (!ACTIONS.has(action)) throw new Error(`Unsupported action: ${action}`)
  const snapshot = await getSnapshot()
  if (snapshot.activeSource === 'Steam') {
    if (action === 'Launch') {
      await launchSteamGame()
      return { ok: true, action, message: 'Steam 原版已启动。', output: 'steam://run/108600', finishedAt: new Date().toISOString() }
    }
    if (action === 'Verify') {
      await validateSteamGame()
      return { ok: true, action, message: '已交给 Steam 执行完整性验证。', output: 'steam://validate/108600', finishedAt: new Date().toISOString() }
    }
    throw new Error('Steam 原版存档备份尚未开放。')
  }
  if (!snapshot.isHealthy || !snapshot.managerRoot || !snapshot.config) {
    throw new Error(snapshot.issue ?? 'Select a valid freeze manager folder first.')
  }

  if (!snapshot.enginePath || !existsSync(snapshot.enginePath) || (snapshot.config.StorageMode === 'ThinReference' && action !== 'BackupSave')) {
    return runNativeAction(action, snapshot.config)
  }

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    snapshot.enginePath,
    '-Action',
    action,
    '-ManagerRoot',
    snapshot.managerRoot
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      const ok = code === 0
      resolve({
        ok,
        action,
        message: ok ? `${action} completed.` : `${action} failed with exit code ${code}.`,
        output: output.trim(),
        finishedAt: new Date().toISOString()
      })
    })
  })
}

const hashFile = (filePath: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
})

const parseManifest = async (manifestPath: string): Promise<Array<{ relativePath: string; sha256: string }>> => {
  const raw = (await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '')
  return raw.split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","\d+","([A-Fa-f0-9]{64})"$/)
    if (!match) throw new Error(`无法解析清单行：${line.slice(0, 120)}`)
    return { relativePath: match[1].replace(/""/g, '"'), sha256: match[2].toUpperCase() }
  })
}

const verifyManifest = async (root: string, manifestPath: string): Promise<{ checked: number; missing: string[]; changed: string[] }> => {
  const rows = await parseManifest(manifestPath)
  const missing: string[] = []
  const changed: string[] = []
  for (let index = 0; index < rows.length; index += 8) {
    await Promise.all(rows.slice(index, index + 8).map(async (row) => {
      const filePath = path.join(root, row.relativePath)
      if (!existsSync(filePath)) {
        missing.push(row.relativePath)
      } else if (await hashFile(filePath) !== row.sha256) {
        changed.push(row.relativePath)
      }
    }))
  }
  return { checked: rows.length, missing, changed }
}

const collectRelativeFiles = async (root: string): Promise<string[]> => {
  if (!existsSync(root)) return []
  const files: string[] = []
  const pending = ['']
  while (pending.length) {
    const relativeDirectory = pending.pop()!
    for (const entry of await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) pending.push(relativePath)
      else if (entry.isFile()) files.push(relativePath)
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

const isHardLinkedTree = async (source: string, target: string): Promise<boolean> => {
  const [sourceFiles, targetFiles] = await Promise.all([collectRelativeFiles(source), collectRelativeFiles(target)])
  if (sourceFiles.length !== targetFiles.length || sourceFiles.some((file, index) => file.toLowerCase() !== targetFiles[index]?.toLowerCase())) return false
  for (let index = 0; index < sourceFiles.length; index += 64) {
    const valid = await Promise.all(sourceFiles.slice(index, index + 64).map(async (relativePath) => {
      const [sourceStats, targetStats] = await Promise.all([fs.stat(path.join(source, relativePath)), fs.stat(path.join(target, relativePath))])
      if (sourceStats.size !== targetStats.size) return false
      return !sourceStats.ino || !targetStats.ino || (sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino)
    }))
    if (valid.some((value) => !value)) return false
  }
  return true
}

const runNativeAction = async (action: LauncherAction, config: FreezeConfig): Promise<ActionResult> => {
  const finishedAt = (): string => new Date().toISOString()
  if (action === 'Launch') {
    const executable = path.join(config.GamePath, 'ProjectZomboid64.exe')
    if (!existsSync(executable)) throw new Error(`游戏程序不存在：${executable}`)
    const args = config.LaunchArguments ?? ['-nosteam', `-cachedir=${config.CachePath}`]
    const child = spawn(executable, args, { cwd: config.GamePath, detached: true, stdio: 'ignore', windowsHide: false })
    const earlyExit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 2_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code ?? -1)
      })
    })
    if (earlyExit !== null) throw new Error(`游戏进程在启动后 2 秒内退出，退出码 ${earlyExit}。请检查游戏目录、Java 参数和缓存路径。`)
    child.unref()
    return { ok: true, action, message: '冻结版本已启动并通过早期存活检查。', output: `${executable}\n${args.join(' ')}\nPID=${child.pid ?? 'unknown'}`, finishedAt: finishedAt() }
  }

  if (action === 'Verify') {
    if (config.StorageMode === 'ThinReference') {
      const identity = await readGameIdentity(config.GamePath, config.BuildID ?? 'unknown', config.CachePath)
      const identityProblems = [
        config.BaseRevision && identity.revision !== config.BaseRevision ? `revision 预期 ${config.BaseRevision}，实际 ${identity.revision ?? 'unknown'}` : null,
        config.BaseGameJarSHA256 && identity.jarSha256 !== config.BaseGameJarSHA256 ? '游戏 JAR SHA-256 与基础版本记录不一致' : null
      ].filter((value): value is string => Boolean(value))
      const missingReferences = (config.ReferencedMods ?? []).filter((mod) => !existsSync(mod.sourcePath) || !existsSync(mod.targetPath))
      const wrongReferences: string[] = []
      for (const mod of (config.ReferencedMods ?? []).filter((item) => !missingReferences.includes(item))) {
        try {
          if (mod.linkMode === 'hardlink') {
            if (!await isHardLinkedTree(mod.sourcePath, mod.targetPath)) wrongReferences.push(mod.name)
          } else {
            const [sourceRealPath, targetRealPath] = await Promise.all([fs.realpath(mod.sourcePath), fs.realpath(mod.targetPath)])
            if (path.resolve(sourceRealPath).toLowerCase() !== path.resolve(targetRealPath).toLowerCase()) wrongReferences.push(mod.name)
          }
        } catch {
          wrongReferences.push(mod.name)
        }
      }
      const problems = identityProblems.length + missingReferences.length + wrongReferences.length
      const output = [
        `基础游戏：${identity.version} / ${identity.revision ?? 'unknown'} / ${identity.jarSha256 ?? 'no-hash'}`,
        `MOD 引用：检查 ${config.ReferencedMods?.length ?? 0}，缺失 ${missingReferences.length}，错链 ${wrongReferences.length}`,
        ...identityProblems.map((problem) => `[身份] ${problem}`),
        ...missingReferences.slice(0, 20).map((mod) => `[缺失][MOD 引用] ${mod.name} -> ${mod.sourcePath}`),
        ...wrongReferences.slice(0, 20).map((name) => `[错链][MOD 引用] ${name}`)
      ].join('\n')
      return { ok: problems === 0, action, message: problems === 0 ? '薄版本依赖与身份校验通过。' : `薄版本校验发现 ${problems} 个问题。`, output, finishedAt: finishedAt() }
    }
    if (!config.ManifestPath) throw new Error('当前版本没有 SHA-256 基线清单。')
    const gameManifest = path.join(config.ManifestPath, 'game.sha256.csv')
    const modManifest = path.join(config.ManifestPath, 'mods.sha256.csv')
    if (!existsSync(gameManifest)) throw new Error(`缺少游戏基线清单：${gameManifest}`)
    const game = await verifyManifest(config.GamePath, gameManifest)
    const mods = existsSync(modManifest)
      ? await verifyManifest(path.join(config.CachePath, 'mods'), modManifest)
      : { checked: 0, missing: [], changed: [] }
    const problems = game.missing.length + game.changed.length + mods.missing.length + mods.changed.length
    const output = [
      `游戏：检查 ${game.checked}，缺失 ${game.missing.length}，变化 ${game.changed.length}`,
      `MOD：检查 ${mods.checked}，缺失 ${mods.missing.length}，变化 ${mods.changed.length}`,
      ...game.missing.slice(0, 20).map((item) => `[缺失][游戏] ${item}`),
      ...game.changed.slice(0, 20).map((item) => `[变化][游戏] ${item}`),
      ...mods.missing.slice(0, 20).map((item) => `[缺失][MOD] ${item}`),
      ...mods.changed.slice(0, 20).map((item) => `[变化][MOD] ${item}`)
    ].join('\n')
    return { ok: problems === 0, action, message: problems === 0 ? 'SHA-256 完整性校验通过。' : `完整性校验发现 ${problems} 个问题。`, output, finishedAt: finishedAt() }
  }

  throw new Error('当前版本库没有旧维护引擎，原生存档备份将在下一阶段开放。')
}

export const openLogs = async (): Promise<boolean> => {
  const snapshot = await getSnapshot()
  if (!snapshot.managerRoot) return false
  const logPath = path.join(snapshot.managerRoot, 'logs')
  if (!existsSync(logPath)) return false
  return (await shell.openPath(logPath)) === ''
}
