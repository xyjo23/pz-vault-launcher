import assert from 'node:assert/strict'
import test from 'node:test'

import type { SharePackageEnvelopeV1, SharePackageManifestV1 } from '../shared/types.ts'
import {
  canonicalizeShareValue,
  createShareEnvelope,
  digestShareManifest,
  parseSharePackage,
  serializeSharePackage,
  SHARE_PACKAGE_MAX_BYTES,
  validateShareEnvelope
} from './share-package-format.ts'

const manifestFixture = (): SharePackageManifestV1 => ({
  packageId: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-11-24T08:00:00.000Z',
  producer: { name: 'Project Zomboid Vault', version: '0.7.1' },
  title: '测试共享清单',
  source: 'Frozen',
  game: {
    appId: '108600',
    version: '42.22.2',
    fullVersion: '42.22.2 10240',
    buildId: '26486631',
    revision: '10240',
    jarSha256: 'A'.repeat(64),
    identityStatus: 'verified'
  },
  loadout: {
    contextKind: 'server',
    contextName: 'PZVaultTest',
    modIds: ['Example.Mod'],
    workshopIds: ['1234567890']
  },
  mods: [{
    name: 'Example Mod',
    modId: 'Example.Mod',
    workshopId: '1234567890',
    source: 'Workshop',
    selectedVersion: '42.22',
    variants: ['common', '42.22'],
    require: [],
    incompatible: [],
    loadAfter: [],
    loadBefore: [],
    contentFingerprint: 'B'.repeat(64),
    files: 2,
    bytes: 128,
    delivery: 'steam-workshop-reference',
    embedded: false
  }],
  analysis: {
    integrityVerdict: 'pass',
    compatibilityVerdict: 'warning',
    integritySummary: '基线内容全部一致。',
    compatibilitySummary: '没有阻断项，存在一项待核对警告。',
    warnings: ['示例警告']
  },
  rights: {
    policy: 'reference-only-v1',
    embeddedFiles: 0,
    statement: '只包含引用与指纹。'
  },
  exclusions: ['game-binaries', 'workshop-files']
})

const envelopeFixture = (): SharePackageEnvelopeV1 => createShareEnvelope(manifestFixture())

test('规范化不受对象键顺序影响', () => {
  assert.equal(canonicalizeShareValue({ b: 2, a: 1 }), canonicalizeShareValue({ a: 1, b: 2 }))
})

test('有效 v1 可以序列化并重新解析', () => {
  const envelope = envelopeFixture()
  const parsed = parseSharePackage(serializeSharePackage(envelope))
  assert.equal(parsed.manifest.packageId, envelope.manifest.packageId)
  assert.equal(parsed.integrity.digest, digestShareManifest(envelope.manifest))
})

test('修改 manifest 后摘要验证失败', () => {
  const envelope = envelopeFixture()
  envelope.manifest.title = '被篡改的标题'
  assert.throws(() => parseSharePackage(JSON.stringify(envelope)), /摘要不匹配/)
})

test('拒绝伪造 AppID', () => {
  const envelope = envelopeFixture() as unknown as { manifest: { game: { appId: string } } }
  envelope.manifest.game.appId = '999999'
  assert.throws(() => validateShareEnvelope(envelope), /AppID 108600/)
})

test('拒绝嵌入式 MOD 内容声明', () => {
  const envelope = envelopeFixture() as unknown as { manifest: { mods: Array<{ embedded: boolean }> } }
  envelope.manifest.mods[0].embedded = true
  assert.throws(() => validateShareEnvelope(envelope), /不接受嵌入式内容/)
})

test('拒绝 v1 未定义的隐藏字段', () => {
  const envelope = envelopeFixture() as SharePackageEnvelopeV1 & { hiddenPayload?: string }
  envelope.hiddenPayload = 'C:\\Users\\example\\secret.txt'
  assert.throws(() => validateShareEnvelope(envelope), /未知 hiddenPayload/)
})

test('拒绝重复加载项和清单顺序不一致', () => {
  const duplicate = envelopeFixture()
  duplicate.manifest.loadout.modIds.push('Example.Mod')
  assert.throws(() => validateShareEnvelope(duplicate), /包含重复项/)

  const mismatch = envelopeFixture()
  mismatch.manifest.loadout.modIds[0] = 'Different.Mod'
  assert.throws(() => validateShareEnvelope(mismatch), /一一对应/)
})

test('拒绝 Workshop 来源与交付方式矛盾', () => {
  const envelope = envelopeFixture()
  envelope.manifest.mods[0].delivery = 'local-reference'
  assert.throws(() => validateShareEnvelope(envelope), /交付类型与来源不一致/)
})

test('拒绝超过大小上限的输入', () => {
  assert.throws(() => parseSharePackage(' '.repeat(SHARE_PACKAGE_MAX_BYTES + 1)), /超过 8 MiB/)
})
