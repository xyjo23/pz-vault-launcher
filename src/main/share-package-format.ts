import { createHash } from 'node:crypto'

import type { SharePackageEnvelopeV1, SharePackageManifestV1 } from '../shared/types'

export const SHARE_PACKAGE_MAX_BYTES = 8 * 1024 * 1024
const MAX_MODS = 5000
const MAX_TEXT = 4096
const SHA256 = /^[a-f0-9]{64}$/i
const IDENTITY_STATUSES = new Set(['verified', 'stale-cache', 'binary-only', 'cache-only', 'unknown'])
const VERDICTS = new Set(['blocker', 'warning', 'unknown', 'pass'])

const exactKeys = (value: object, expected: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, 'en'))
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const unexpected = actual.filter((key) => !wanted.includes(key))
    const missing = wanted.filter((key) => !actual.includes(key))
    throw new Error(`${label} 字段不符合 v1：${[unexpected.length ? `未知 ${unexpected.join(', ')}` : '', missing.length ? `缺少 ${missing.join(', ')}` : ''].filter(Boolean).join('；')}`)
  }
}

const stringValue = (value: unknown, label: string, max = MAX_TEXT): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 无效。`)
  return value
}

const optionalString = (value: unknown, label: string, max = MAX_TEXT): string | null => {
  if (value === null) return null
  return stringValue(value, label, max)
}

const stringArray = (value: unknown, label: string, max = MAX_MODS, requireUnique = false): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 512)) {
    throw new Error(`${label} 无效或超过 v1 限制。`)
  }
  if (requireUnique && new Set(value).size !== value.length) throw new Error(`${label} 包含重复项。`)
  return value as string[]
}

export const canonicalizeShareValue = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('共享包不能包含非有限数值。')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeShareValue).join(',')}]`
  if (typeof value !== 'object') throw new Error('共享包包含无法规范化的值。')
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeShareValue(entry)}`)
    .join(',')}}`
}

export const digestShareManifest = (manifest: SharePackageManifestV1): string => (
  createHash('sha256').update(canonicalizeShareValue(manifest), 'utf8').digest('hex').toUpperCase()
)

export const validateShareEnvelope = (value: unknown): SharePackageEnvelopeV1 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件不是共享包对象。')
  const envelope = value as Partial<SharePackageEnvelopeV1>
  exactKeys(envelope, ['format', 'schemaVersion', 'manifest', 'integrity', 'signature'], '共享包')
  if (envelope.format !== 'pz-vault-share' || envelope.schemaVersion !== 1) throw new Error('不支持的共享包格式或版本。')
  if (!envelope.manifest || typeof envelope.manifest !== 'object' || Array.isArray(envelope.manifest)) throw new Error('共享包缺少 manifest。')
  const manifest = envelope.manifest as SharePackageManifestV1
  exactKeys(manifest, ['packageId', 'createdAt', 'producer', 'title', 'source', 'game', 'loadout', 'mods', 'analysis', 'rights', 'exclusions'], 'manifest')
  stringValue(manifest.packageId, 'packageId', 80)
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(manifest.packageId)) throw new Error('packageId 不是有效 UUID。')
  stringValue(manifest.createdAt, 'createdAt', 80)
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('createdAt 不是有效时间。')
  stringValue(manifest.title, 'title', 160)
  if (manifest.source !== 'Steam' && manifest.source !== 'Frozen') throw new Error('共享包来源类型无效。')

  if (!manifest.producer || typeof manifest.producer !== 'object') throw new Error('共享包缺少 producer。')
  exactKeys(manifest.producer, ['name', 'version'], 'producer')
  if (manifest.producer.name !== 'Project Zomboid Vault') throw new Error('producer.name 无效。')
  stringValue(manifest.producer.version, 'producer.version', 80)

  if (!manifest.game || typeof manifest.game !== 'object') throw new Error('共享包缺少游戏身份。')
  exactKeys(manifest.game, ['appId', 'version', 'fullVersion', 'buildId', 'revision', 'jarSha256', 'identityStatus'], 'game')
  if (manifest.game.appId !== '108600') throw new Error('共享包不是 Project Zomboid AppID 108600。')
  stringValue(manifest.game.version, 'game.version', 80)
  stringValue(manifest.game.fullVersion, 'game.fullVersion', 160)
  stringValue(manifest.game.buildId, 'game.buildId', 80)
  optionalString(manifest.game.revision, 'game.revision', 160)
  if (manifest.game.jarSha256 !== null && !SHA256.test(manifest.game.jarSha256)) throw new Error('game.jarSha256 无效。')
  if (!IDENTITY_STATUSES.has(manifest.game.identityStatus)) throw new Error('game.identityStatus 无效。')

  if (!manifest.loadout || typeof manifest.loadout !== 'object') throw new Error('共享包缺少明确的启用上下文。')
  exactKeys(manifest.loadout, ['contextKind', 'contextName', 'modIds', 'workshopIds'], 'loadout')
  if (manifest.loadout.contextKind !== 'save' && manifest.loadout.contextKind !== 'server') throw new Error('loadout.contextKind 无效。')
  stringValue(manifest.loadout.contextName, 'loadout.contextName', 512)
  const loadoutModIds = stringArray(manifest.loadout.modIds, 'loadout.modIds', MAX_MODS, true)
  stringArray(manifest.loadout.workshopIds, 'loadout.workshopIds', MAX_MODS, true)

  if (!Array.isArray(manifest.mods) || manifest.mods.length > MAX_MODS) throw new Error('MOD 清单无效或超过 v1 限制。')
  for (const mod of manifest.mods) {
    if (!mod || typeof mod !== 'object') throw new Error('MOD 条目无效。')
    exactKeys(mod, ['name', 'modId', 'workshopId', 'source', 'selectedVersion', 'variants', 'require', 'incompatible', 'loadAfter', 'loadBefore', 'contentFingerprint', 'files', 'bytes', 'delivery', 'embedded'], `mod:${String(mod.modId ?? 'unknown')}`)
    stringValue(mod.name, 'mod.name', 512)
    stringValue(mod.modId, 'mod.modId', 512)
    if (mod.workshopId !== null && !/^\d{1,20}$/.test(mod.workshopId)) throw new Error(`Workshop ID 无效：${mod.workshopId}`)
    if (mod.source !== 'Workshop' && mod.source !== 'Local') throw new Error(`MOD 来源无效：${mod.modId}`)
    optionalString(mod.selectedVersion, `mod.selectedVersion:${mod.modId}`, 160)
    if (!SHA256.test(mod.contentFingerprint)) throw new Error(`MOD 内容指纹无效：${mod.modId}`)
    if (!Number.isSafeInteger(mod.files) || mod.files < 0 || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0) throw new Error(`MOD 文件统计无效：${mod.modId}`)
    if (mod.embedded !== false || !['steam-workshop-reference', 'local-reference'].includes(mod.delivery)) throw new Error(`v1 不接受嵌入式内容：${mod.modId}`)
    if ((mod.source === 'Workshop') !== (mod.delivery === 'steam-workshop-reference')) throw new Error(`MOD 交付类型与来源不一致：${mod.modId}`)
    if (mod.source === 'Workshop' && !mod.workshopId) throw new Error(`Workshop MOD 缺少 Workshop ID：${mod.modId}`)
    stringArray(mod.variants, `mod.variants:${mod.modId}`, 100, true)
    stringArray(mod.require, `mod.require:${mod.modId}`, MAX_MODS, true)
    stringArray(mod.incompatible, `mod.incompatible:${mod.modId}`, MAX_MODS, true)
    stringArray(mod.loadAfter, `mod.loadAfter:${mod.modId}`, MAX_MODS, true)
    stringArray(mod.loadBefore, `mod.loadBefore:${mod.modId}`, MAX_MODS, true)
  }
  const manifestModIds = manifest.mods.map((mod) => mod.modId)
  if (new Set(manifestModIds).size !== manifestModIds.length) throw new Error('MOD 清单包含重复 Mod ID。')
  if (manifestModIds.length !== loadoutModIds.length || manifestModIds.some((id, index) => id !== loadoutModIds[index])) {
    throw new Error('MOD 清单必须与 loadout.modIds 按加载顺序一一对应。')
  }

  if (!manifest.analysis || typeof manifest.analysis !== 'object') throw new Error('共享包缺少分析摘要。')
  exactKeys(manifest.analysis, ['integrityVerdict', 'compatibilityVerdict', 'integritySummary', 'compatibilitySummary', 'warnings'], 'analysis')
  if (!VERDICTS.has(manifest.analysis.integrityVerdict) || !VERDICTS.has(manifest.analysis.compatibilityVerdict)) throw new Error('分析结论枚举无效。')
  stringValue(manifest.analysis.integritySummary, 'analysis.integritySummary')
  stringValue(manifest.analysis.compatibilitySummary, 'analysis.compatibilitySummary')
  stringArray(manifest.analysis.warnings, 'analysis.warnings', 1000)

  if (!manifest.rights || typeof manifest.rights !== 'object') throw new Error('共享包缺少权利策略。')
  exactKeys(manifest.rights, ['policy', 'embeddedFiles', 'statement'], 'rights')
  if (manifest.rights.policy !== 'reference-only-v1' || manifest.rights.embeddedFiles !== 0) throw new Error('v1 共享包只能使用零嵌入的引用策略。')
  stringValue(manifest.rights.statement, 'rights.statement')
  stringArray(manifest.exclusions, 'exclusions', 100, true)

  if (!envelope.integrity || typeof envelope.integrity !== 'object') throw new Error('共享包缺少摘要。')
  exactKeys(envelope.integrity, ['algorithm', 'digest'], 'integrity')
  if (envelope.integrity.algorithm !== 'SHA-256' || !SHA256.test(envelope.integrity.digest)) throw new Error('共享包摘要字段无效。')
  if (!envelope.signature || typeof envelope.signature !== 'object') throw new Error('共享包缺少签名状态。')
  exactKeys(envelope.signature, ['status', 'reason'], 'signature')
  if (envelope.signature.status !== 'unsigned') throw new Error('v1 不支持此签名类型。')
  stringValue(envelope.signature.reason, 'signature.reason')
  return envelope as SharePackageEnvelopeV1
}

export const createShareEnvelope = (manifest: SharePackageManifestV1): SharePackageEnvelopeV1 => ({
  format: 'pz-vault-share',
  schemaVersion: 1,
  manifest,
  integrity: { algorithm: 'SHA-256', digest: digestShareManifest(manifest) },
  signature: { status: 'unsigned', reason: 'v1 仅验证内容摘要；制作者身份签名将在后续格式加入。' }
})

export const parseSharePackage = (raw: string | Buffer): SharePackageEnvelopeV1 => {
  const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw, 'utf8')
  if (bytes <= 0 || bytes > SHARE_PACKAGE_MAX_BYTES) throw new Error('共享包为空或超过 8 MiB 的 v1 上限。')
  let parsed: unknown
  try {
    parsed = JSON.parse((Buffer.isBuffer(raw) ? raw.toString('utf8') : raw).replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('共享包不是有效的 UTF-8 JSON。')
  }
  const envelope = validateShareEnvelope(parsed)
  if (digestShareManifest(envelope.manifest) !== envelope.integrity.digest.toUpperCase()) throw new Error('共享包内容摘要不匹配，文件已经变化或损坏。')
  return envelope
}

export const serializeSharePackage = (envelope: SharePackageEnvelopeV1): string => {
  const validated = validateShareEnvelope(envelope)
  if (digestShareManifest(validated.manifest) !== validated.integrity.digest.toUpperCase()) throw new Error('共享包内容摘要不匹配，拒绝写入。')
  return `${JSON.stringify(validated, null, 2)}\n`
}
