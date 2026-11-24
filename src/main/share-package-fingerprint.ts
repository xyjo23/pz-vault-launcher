import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

export type DirectoryFingerprint = { digest: string; files: number; bytes: number }
export type FingerprintOptions = { maxFiles?: number; batchSize?: number }
type FileSnapshot = { relative: string; absolute: string; bytes: number; modifiedMs: number }

const hashFileStable = async (file: FileSnapshot): Promise<string> => {
  const before = await fs.stat(file.absolute)
  if (!before.isFile() || before.size !== file.bytes || before.mtimeMs !== file.modifiedMs) {
    throw new Error(`MOD 在生成指纹期间发生变化：${file.relative}`)
  }
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file.absolute)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
  const after = await fs.stat(file.absolute)
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`MOD 在生成指纹期间发生变化：${file.relative}`)
  }
  return digest
}

const snapshotFiles = async (root: string, maxFiles: number): Promise<FileSnapshot[]> => {
  const files: FileSnapshot[] = []
  const pending = ['']
  while (pending.length) {
    const relativeDirectory = pending.pop()!
    const entries = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true })
    for (const entry of entries) {
      const relativeNative = path.join(relativeDirectory, entry.name)
      const relative = relativeNative.replace(/\\/g, '/')
      const absolute = path.join(root, relativeNative)
      if (entry.isSymbolicLink()) throw new Error(`MOD 中包含无法安全验证的符号链接：${relative}`)
      if (entry.isDirectory()) pending.push(relativeNative)
      else if (entry.isFile()) {
        const stats = await fs.stat(absolute)
        files.push({ relative, absolute, bytes: stats.size, modifiedMs: stats.mtimeMs })
        if (files.length > maxFiles) throw new Error(`单个 MOD 超过 ${maxFiles} 个文件，拒绝生成不可控的内容指纹。`)
      }
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative, 'en'))
}

const sameSnapshot = (left: FileSnapshot[], right: FileSnapshot[]): boolean => (
  left.length === right.length && left.every((file, index) => (
    file.relative === right[index].relative && file.bytes === right[index].bytes && file.modifiedMs === right[index].modifiedMs
  ))
)

export const fingerprintDirectory = async (root: string, options: FingerprintOptions = {}): Promise<DirectoryFingerprint> => {
  if (!existsSync(root)) throw new Error(`MOD 内容目录不存在：${root}`)
  const stats = await fs.stat(root)
  if (!stats.isDirectory()) throw new Error(`MOD 内容根不是目录：${root}`)
  const maxFiles = options.maxFiles ?? 250000
  const batchSize = options.batchSize ?? 8
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) {
    throw new Error('内容指纹参数无效。')
  }
  const files = await snapshotFiles(root, maxFiles)
  const rows: string[] = []
  for (let index = 0; index < files.length; index += batchSize) {
    const batch = await Promise.all(files.slice(index, index + batchSize).map(async (file) => (
      `${file.relative}\0${file.bytes}\0${await hashFileStable(file)}`
    )))
    rows.push(...batch)
  }
  const after = await snapshotFiles(root, maxFiles)
  if (!sameSnapshot(files, after)) throw new Error('MOD 在生成指纹期间发生变化；请等待 Steam 更新结束后重试。')
  return {
    digest: createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex').toUpperCase(),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0)
  }
}
