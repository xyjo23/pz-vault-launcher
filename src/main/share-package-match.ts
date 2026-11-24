import type { GameIdentity, SharePackageFinding, SharePackageManifestV1 } from '../shared/types'

export type LocalShareModEvidence = {
  modId: string
  workshopId: string | null
  selectedVersion: string | null
  contentFingerprint: string
}

export type ReconstructionEvidence = {
  managerRootReady: boolean
  integritySummary: string
  integrityBlocked: boolean
  identity: GameIdentity
  mods: LocalShareModEvidence[]
  workshopIds: string[]
}

export const isTrustedShareIdentity = (identity: { status: GameIdentity['status']; buildId: string; jarSha256: string | null }): boolean => (
  ['verified', 'stale-cache', 'binary-only'].includes(identity.status) && identity.buildId !== 'unknown' && Boolean(identity.jarSha256)
)

export const evaluateReconstruction = (
  manifest: SharePackageManifestV1,
  evidence: ReconstructionEvidence
): { canInstall: boolean; findings: SharePackageFinding[] } => {
  const findings: SharePackageFinding[] = []
  if (!evidence.managerRootReady) findings.push({ severity: 'blocker', title: '尚未设置版本管理目录', detail: '先在维护工具右上角选择管理目录，再安装为新版本。' })
  if (evidence.integrityBlocked) findings.push({ severity: 'blocker', title: '本机来源完整性未通过', detail: evidence.integritySummary })
  else findings.push({ severity: 'pass', title: '本机来源完整性可用', detail: evidence.integritySummary })

  if (!isTrustedShareIdentity({ status: manifest.game.identityStatus, buildId: manifest.game.buildId, jarSha256: manifest.game.jarSha256 })) {
    findings.push({ severity: 'blocker', title: '制作端游戏身份不足以精确复现', detail: '共享清单必须包含可靠二进制身份、Build ID 和 projectzomboid.jar SHA-256。' })
  }
  if (!isTrustedShareIdentity(evidence.identity)) {
    findings.push({ severity: 'blocker', title: '本机游戏身份不足以精确匹配', detail: '请恢复可读取的 projectzomboid.jar 和 Steam Build 信息后重试。' })
  }

  const identityMismatches: string[] = []
  if (evidence.identity.version !== manifest.game.version) identityMismatches.push(`版本 ${evidence.identity.version} ≠ ${manifest.game.version}`)
  if (manifest.game.buildId !== 'unknown' && evidence.identity.buildId !== manifest.game.buildId) identityMismatches.push(`Build ${evidence.identity.buildId} ≠ ${manifest.game.buildId}`)
  if (manifest.game.revision && evidence.identity.revision !== manifest.game.revision) identityMismatches.push(`revision ${evidence.identity.revision ?? '未知'} ≠ ${manifest.game.revision}`)
  if (manifest.game.jarSha256 && evidence.identity.jarSha256 !== manifest.game.jarSha256) identityMismatches.push('projectzomboid.jar SHA-256 不一致')
  if (identityMismatches.length) findings.push({ severity: 'blocker', title: '游戏版本身份不匹配', detail: identityMismatches.join('；') })
  else if (isTrustedShareIdentity(evidence.identity) && isTrustedShareIdentity({ status: manifest.game.identityStatus, buildId: manifest.game.buildId, jarSha256: manifest.game.jarSha256 })) {
    findings.push({ severity: 'pass', title: '游戏版本身份精确匹配', detail: `${evidence.identity.version} · Build ${evidence.identity.buildId} · revision ${evidence.identity.revision ?? '未知'}` })
  }

  const installedWorkshopIds = new Set(evidence.workshopIds)
  const missingWorkshopIds = manifest.loadout.workshopIds.filter((id) => !installedWorkshopIds.has(id))
  if (missingWorkshopIds.length) findings.push({ severity: 'blocker', title: `缺少 ${missingWorkshopIds.length} 个 Workshop 项目`, detail: missingWorkshopIds.slice(0, 20).join('、') })
  else findings.push({ severity: 'pass', title: 'Workshop 项目引用完整', detail: `${manifest.loadout.workshopIds.length} 个 Workshop ID 均能在本机内容中解析。` })

  const missing: string[] = []
  const drifted: string[] = []
  for (const expected of manifest.mods) {
    const candidates = evidence.mods.filter((candidate) => (
      candidate.modId === expected.modId &&
      candidate.workshopId === expected.workshopId &&
      candidate.selectedVersion === expected.selectedVersion
    ))
    if (!candidates.length) missing.push(expected.modId)
    else if (!candidates.some((candidate) => candidate.contentFingerprint === expected.contentFingerprint)) drifted.push(expected.modId)
  }
  if (missing.length) findings.push({ severity: 'blocker', title: `缺少 ${missing.length} 个共享清单 MOD`, detail: missing.slice(0, 20).join('、') })
  if (drifted.length) findings.push({ severity: 'blocker', title: `${drifted.length} 个 MOD 已发生版本漂移`, detail: `${drifted.slice(0, 20).join('、')} 的实际文件指纹与制作端不一致。` })
  if (!missing.length && !drifted.length) findings.push({ severity: 'pass', title: 'MOD 内容指纹全部匹配', detail: `${manifest.mods.length} 个启用 MOD 均能在本机找到相同字节内容。` })
  return { canInstall: !findings.some((finding) => finding.severity === 'blocker'), findings }
}
