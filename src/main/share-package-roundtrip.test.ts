import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { GameIdentity, SharePackageManifestV1 } from '../shared/types.ts'
import { fingerprintDirectory } from './share-package-fingerprint.ts'
import { createShareEnvelope, parseSharePackage, serializeSharePackage } from './share-package-format.ts'
import { evaluateReconstruction } from './share-package-match.ts'

const identity = (): GameIdentity => ({
  version: '42.22.2', revision: '10240', buildId: '26486631', jarSha256: 'A'.repeat(64), status: 'verified', source: 'binary', cachedVersion: null, cachedRevision: null, evidence: []
})

test('制作、传递、接收匹配和版本漂移构成完整闭环', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-vault-roundtrip-'))
  try {
    const sender = path.join(root, 'sender-mod')
    const receiver = path.join(root, 'receiver-mod')
    await fs.mkdir(path.join(sender, '42.22', 'media', 'lua'), { recursive: true })
    await fs.writeFile(path.join(sender, 'mod.info'), 'id=RoundTrip.Mod\nname=Round Trip\n')
    await fs.writeFile(path.join(sender, '42.22', 'media', 'lua', 'main.lua'), 'return "sender"\n')
    await fs.cp(sender, receiver, { recursive: true })
    const senderFingerprint = await fingerprintDirectory(sender)

    const manifest: SharePackageManifestV1 = {
      packageId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-11-24T08:30:00.000Z',
      producer: { name: 'Project Zomboid Vault', version: '0.7.1' }, title: '往返测试', source: 'Frozen',
      game: { appId: '108600', version: '42.22.2', fullVersion: '42.22.2 10240', buildId: '26486631', revision: '10240', jarSha256: 'A'.repeat(64), identityStatus: 'verified' },
      loadout: { contextKind: 'server', contextName: 'RoundTrip', modIds: ['RoundTrip.Mod'], workshopIds: ['987654321'] },
      mods: [{ name: 'Round Trip', modId: 'RoundTrip.Mod', workshopId: '987654321', source: 'Workshop', selectedVersion: '42.22', variants: ['42.22'], require: [], incompatible: [], loadAfter: [], loadBefore: [], contentFingerprint: senderFingerprint.digest, files: senderFingerprint.files, bytes: senderFingerprint.bytes, delivery: 'steam-workshop-reference', embedded: false }],
      analysis: { integrityVerdict: 'pass', compatibilityVerdict: 'pass', integritySummary: '通过', compatibilitySummary: '通过', warnings: [] },
      rights: { policy: 'reference-only-v1', embeddedFiles: 0, statement: '零嵌入引用测试。' }, exclusions: ['game-binaries', 'workshop-files']
    }
    const transported = serializeSharePackage(createShareEnvelope(manifest))
    const received = parseSharePackage(transported)
    const receiverFingerprint = await fingerprintDirectory(receiver)
    const matched = evaluateReconstruction(received.manifest, {
      managerRootReady: true, integritySummary: '通过', integrityBlocked: false, identity: identity(), workshopIds: ['987654321'],
      mods: [{ modId: 'RoundTrip.Mod', workshopId: '987654321', selectedVersion: '42.22', contentFingerprint: receiverFingerprint.digest }]
    })
    assert.equal(matched.canInstall, true)

    await fs.writeFile(path.join(receiver, '42.22', 'media', 'lua', 'main.lua'), 'return "updated by workshop"\n')
    const driftedFingerprint = await fingerprintDirectory(receiver)
    const drifted = evaluateReconstruction(received.manifest, {
      managerRootReady: true, integritySummary: '通过', integrityBlocked: false, identity: identity(), workshopIds: ['987654321'],
      mods: [{ modId: 'RoundTrip.Mod', workshopId: '987654321', selectedVersion: '42.22', contentFingerprint: driftedFingerprint.digest }]
    })
    assert.equal(drifted.canInstall, false)
    assert.ok(drifted.findings.some((finding) => finding.title.includes('版本漂移')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
