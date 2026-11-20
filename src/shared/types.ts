export type LauncherAction = 'Launch' | 'Verify' | 'BackupSave' | 'MigrateSafe' | 'MigrateFast'

export type SteamInstallation = {
  detected: boolean
  issue: string | null
  steamPath: string | null
  libraryPath: string | null
  manifestPath: string | null
  gamePath: string | null
  executablePath: string | null
  workshopPath: string | null
  cachePath: string | null
  version: string
  fullVersion: string
  revision: string | null
  gameJarSha256: string | null
  identityStatus: GameIdentityStatus
  cachedVersion: string | null
  cachedRevision: string | null
  buildId: string
  installedAt: string | null
  workshopProjectCount: number
}

export type GameIdentityStatus = 'verified' | 'stale-cache' | 'binary-only' | 'cache-only' | 'unknown'

export type GameIdentity = {
  version: string
  revision: string | null
  buildId: string
  jarSha256: string | null
  status: GameIdentityStatus
  source: 'binary' | 'cache' | 'metadata' | 'unknown'
  cachedVersion: string | null
  cachedRevision: string | null
  evidence: string[]
}

export type MigrationMode = 'SafeCopy' | 'FastLink'
export type MigrationSourceType = 'Steam' | 'Frozen'
export type FreezeStorageMode = 'FullCopy' | 'ThinReference'

export type ReferencedModRoot = {
  name: string
  sourcePath: string
  targetPath: string
  modIds: string[]
  workshopId: string | null
  files: number
  bytes: number
  linkMode?: 'junction' | 'hardlink'
  linkedFiles?: number
  copiedFiles?: number
}

export type MigrationStorageAnalysis = {
  strategy: FreezeStorageMode
  sourceGameFiles: number
  sourceGameBytes: number
  sourceCacheFiles: number
  sourceCacheBytes: number
  copiedMutableFiles: number
  copiedMutableBytes: number
  referencedModRoots: number
  referencedModFiles: number
  referencedModBytes: number
  omittedFiles: number
  omittedBytes: number
  estimatedWriteBytes: number
  estimatedSavedBytes: number
  activeModIds: string[]
  missingModIds: string[]
  contextPath: string | null
  fallbackToAllMods: boolean
}

export type MigrationRequest = {
  sourceType: MigrationSourceType
  sourceId?: string
  mode: MigrationMode
  label?: string
  protectSaves: boolean
}

export type MigrationPreview = {
  canRun: boolean
  sourceLabel: string
  sourcePath: string | null
  targetPath: string | null
  mode: MigrationMode
  warnings: string[]
  steps: string[]
  analysis?: MigrationStorageAnalysis
}

export type FreezeConfig = {
  ManagerRoot: string
  FreezeRoot: string
  GamePath: string
  CachePath: string
  ReportPath: string
  BackupPath: string
  ManifestPath?: string
  LaunchArguments?: string[]
  Version?: string
  FullVersion?: string
  BuildID?: string
  Revision?: string
  GameJarSHA256?: string
  IdentityStatus?: GameIdentityStatus
  Created?: string
  DisplayName?: string
  WorkshopProjectCount?: number
  EffectiveModCount?: number
  LatestSaveActiveModCount?: number
  StorageMode?: FreezeStorageMode
  BaseFreezeRoot?: string
  BaseGamePath?: string
  BaseRevision?: string
  BaseGameJarSHA256?: string
  SourceFreezeRoot?: string
  MigrationMode?: MigrationMode
  MutableCachePolicyVersion?: number
  ReferencedMods?: ReferencedModRoot[]
}

export type FreezeVersionSummary = {
  id: string
  name: string
  freezeRoot: string
  version: string
  fullVersion?: string
  buildId?: string
  created?: string
  workshopProjectCount?: number
  effectiveModCount?: number
  storageMode?: FreezeStorageMode
  isActive: boolean
  isHealthy: boolean
}

export type LauncherSnapshot = {
  activeSource: 'Steam' | 'Frozen'
  isConfigured: boolean
  isHealthy: boolean
  managerRoot: string | null
  enginePath: string | null
  config: FreezeConfig | null
  lastBackup: { name: string; createdAt: string; size: number } | null
  issue: string | null
}

export type ActionResult = {
  ok: boolean
  action: LauncherAction
  message: string
  output: string
  finishedAt: string
}

export type ModSummary = {
  key: string
  name: string
  modId: string | null
  workshopId: string | null
  source: 'Workshop' | 'Local'
}

export type CompatibilitySeverity = 'blocker' | 'warning' | 'unknown' | 'pass'

export type CompatibilityIssue = {
  id: string
  severity: CompatibilitySeverity
  category: 'identity' | 'version' | 'dependency' | 'load-order' | 'conflict' | 'files' | 'save' | 'server' | 'security'
  title: string
  summary: string
  evidence: string[]
  modIds: string[]
}

export type CompatibilityModRecord = {
  key: string
  name: string
  modId: string | null
  workshopId: string | null
  source: 'Workshop' | 'Local'
  rootPath: string
  selectedVersion: string | null
  variants: string[]
  versionMin: string | null
  versionMax: string | null
  require: string[]
  incompatible: string[]
  loadAfter: string[]
  loadBefore: string[]
  active: boolean
}

export type CompatibilityContext = {
  kind: 'save' | 'server'
  name: string
  path: string
  modIds: string[]
  workshopIds: string[]
  missingModIds: string[]
  missingWorkshopIds: string[]
}

export type FileOverlapClassification = 'lua' | 'scripts' | 'map' | 'tile-definition' | 'translation' | 'binary' | 'asset' | 'metadata' | 'other'

export type FileOverlap = {
  relativePath: string
  classification: FileOverlapClassification
  severity: CompatibilitySeverity
  modIds: string[]
  overridesBaseGame: boolean
}

export type CompatibilityReport = {
  schemaVersion: 1
  generatedAt: string
  source: 'Steam' | 'Frozen'
  sourceLabel: string
  reportPath: string | null
  identity: GameIdentity
  verdict: CompatibilitySeverity
  summary: {
    installedMods: number
    activeMods: number
    workshopProjects: number
    blockers: number
    warnings: number
    unknowns: number
    passes: number
    overlapPaths: number
    baseGameOverrides: number
  }
  activeContext: CompatibilityContext | null
  serverContexts: CompatibilityContext[]
  issues: CompatibilityIssue[]
  overlaps: FileOverlap[]
  mods: CompatibilityModRecord[]
}

export type VaultApi = {
  getSnapshot: () => Promise<LauncherSnapshot>
  detectSteam: () => Promise<SteamInstallation>
  launchSteam: () => Promise<boolean>
  validateSteam: () => Promise<boolean>
  openPath: (targetPath: string) => Promise<boolean>
  listCurrentMods: () => Promise<ModSummary[]>
  analyzeCompatibility: () => Promise<CompatibilityReport>
  listVersions: () => Promise<FreezeVersionSummary[]>
  activateVersion: (versionId: string) => Promise<LauncherSnapshot>
  activateSteam: () => Promise<LauncherSnapshot>
  previewMigration: (request: MigrationRequest) => Promise<MigrationPreview>
  executeMigration: (request: MigrationRequest) => Promise<ActionResult>
  chooseManagerRoot: () => Promise<LauncherSnapshot>
  runAction: (action: LauncherAction) => Promise<ActionResult>
  openLogs: () => Promise<boolean>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
}
