import assert from 'node:assert/strict'
import test from 'node:test'

import type { GameIdentity, SharePackageManifestV1 } from '../shared/types.ts'
import { evaluateReconstruction, type ReconstructionEvidence } from './share-package-match.ts'

const manifestFixture = (): SharePackageManifestV1 => ({
  packageId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-11-24T08:00:00.000Z',
  producer: { name: 'Project Zomboid Vault', version: '0.7.1' }, title: '测试', source: 'Frozen',
  game: { appId: '108600', version: '42.22.2', fullVersion: '42.22.2 10240', buildId: '26486631', revision: '10240', jarSha256: 'A'.repeat(64), identityStatus: 'verified' },
  loadout: { contextKind: 'server', contextName: 'Test', modIds: ['Example.Mod'], workshopIds: ['123', '456'] },
  mods: [{ name: 'Example', modId: 'Example.Mod', workshopId: '123', source: 'Workshop', selectedVersion: '42.22', variants: ['42.22'], require: [], incompatible: [], loadAfter: [], loadBefore: [], contentFingerprint: 'B'.repeat(64), files: 1, bytes: 10, delivery: 'steam-workshop-reference', embedded: false }],
  analysis: { integrityVerdict: 'pass', compatibilityVerdict: 'pass', integritySummary: '通过', compatibilitySummary: '通过', warnings: [] },
  rights: { policy: 'reference-only-v1', embeddedFiles: 0, statement: '引用' }, exclusions: ['game-binaries']
})

const identityFixture = (): GameIdentity => ({
  version: '42.22.2', revision: '10240', buildId: '26486631', jarSha256: 'A'.repeat(64), status: 'verified', source: 'binary', cachedVersion: null, cachedRevision: null, evidence: []
})

const evidenceFixture = (): ReconstructionEvidence => ({
  managerRootReady: true,
  integritySummary: '完整性通过',
  integrityBlocked: false,
  identity: identityFixture(),
  workshopIds: ['123', '456'],
  mods: [{ modId: 'Example.Mod', workshopId: '123', selectedVersion: '42.22', contentFingerprint: 'B'.repeat(64) }]
})

test('身份、Workshop 与 MOD 指纹一致时允许安装', () => {
  const result = evaluateReconstruction(manifestFixture(), evidenceFixture())
  assert.equal(result.canInstall, true)
  assert.equal(result.findings.some((finding) => finding.severity === 'blocker'), false)
})

test('单独缺少无 Mod ID 的 Workshop 项目也会阻断', () => {
  const evidence = evidenceFixture()
  evidence.workshopIds = ['123']
  const result = evaluateReconstruction(manifestFixture(), evidence)
  assert.equal(result.canInstall, false)
  assert.match(result.findings.find((finding) => finding.title.includes('Workshop'))?.detail ?? '', /456/)
})

test('缺失 MOD 与内容漂移会分别报告', () => {
  const missing = evidenceFixture()
  missing.mods = []
  assert.match(evaluateReconstruction(manifestFixture(), missing).findings.find((finding) => finding.title.includes('共享清单 MOD'))?.detail ?? '', /Example.Mod/)

  const drifted = evidenceFixture()
  drifted.mods[0].contentFingerprint = 'C'.repeat(64)
  assert.match(evaluateReconstruction(manifestFixture(), drifted).findings.find((finding) => finding.title.includes('版本漂移'))?.detail ?? '', /Example.Mod/)
})

test('弱制作端身份和弱本机身份都会阻断', () => {
  const manifest = manifestFixture()
  manifest.game.identityStatus = 'cache-only'
  manifest.game.jarSha256 = null
  const evidence = evidenceFixture()
  evidence.identity.status = 'unknown'
  evidence.identity.jarSha256 = null
  const result = evaluateReconstruction(manifest, evidence)
  assert.equal(result.canInstall, false)
  assert.equal(result.findings.filter((finding) => finding.title.includes('身份不足')).length, 2)
})

test('管理目录与来源完整性都是独立阻断条件', () => {
  const evidence = evidenceFixture()
  evidence.managerRootReady = false
  evidence.integrityBlocked = true
  const result = evaluateReconstruction(manifestFixture(), evidence)
  assert.equal(result.canInstall, false)
  assert.ok(result.findings.some((finding) => finding.title.includes('管理目录')))
  assert.ok(result.findings.some((finding) => finding.title.includes('完整性未通过')))
})
