import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { fingerprintDirectory } from './share-package-fingerprint.ts'

const withDirectory = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-vault-fingerprint-'))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('相同目录重复计算得到相同内容指纹', async () => withDirectory(async (root) => {
  await fs.mkdir(path.join(root, 'media', 'lua'), { recursive: true })
  await fs.writeFile(path.join(root, 'mod.info'), 'id=Example.Mod\nname=Example\n')
  await fs.writeFile(path.join(root, 'media', 'lua', 'main.lua'), 'return true\n')
  const first = await fingerprintDirectory(root)
  const second = await fingerprintDirectory(root)
  assert.deepEqual(first, second)
  assert.equal(first.files, 2)
}))

test('修改内容或逻辑路径都会改变指纹', async () => withDirectory(async (root) => {
  const originalPath = path.join(root, 'a.txt')
  await fs.writeFile(originalPath, 'alpha')
  const original = await fingerprintDirectory(root)
  await fs.writeFile(originalPath, 'bravo')
  const contentChanged = await fingerprintDirectory(root)
  assert.notEqual(contentChanged.digest, original.digest)
  await fs.rename(originalPath, path.join(root, 'b.txt'))
  const pathChanged = await fingerprintDirectory(root)
  assert.notEqual(pathChanged.digest, contentChanged.digest)
}))

test('空目录也有稳定指纹', async () => withDirectory(async (root) => {
  const result = await fingerprintDirectory(root)
  assert.equal(result.files, 0)
  assert.equal(result.bytes, 0)
  assert.match(result.digest, /^[A-F0-9]{64}$/)
}))

test('文件数量超过限制时阻断', async () => withDirectory(async (root) => {
  await Promise.all(['a', 'b', 'c'].map((name) => fs.writeFile(path.join(root, name), name)))
  await assert.rejects(() => fingerprintDirectory(root, { maxFiles: 2 }), /超过 2 个文件/)
}))

test('符号链接不会被跟随', async (context) => withDirectory(async (root) => {
  const target = path.join(root, 'target.txt')
  await fs.writeFile(target, 'target')
  try {
    await fs.symlink(target, path.join(root, 'link.txt'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('当前 Windows 环境未授予创建符号链接权限')
      return
    }
    throw error
  }
  await assert.rejects(() => fingerprintDirectory(root), /符号链接/)
}))
