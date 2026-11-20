import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

import type { GameIdentity } from '../shared/types'

type ConstantPoolEntry =
  | { tag: 1; value: string }
  | { tag: 3; value: number }
  | { tag: 4; value: number }
  | { tag: 5; value: bigint }
  | { tag: 6; value: number }
  | { tag: 7 | 8 | 16 | 19 | 20; index: number }
  | { tag: 9 | 10 | 11 | 12 | 17 | 18; first: number; second: number }
  | { tag: 15; kind: number; index: number }
  | null

type ClassField = { name: string; descriptor: string; constant: unknown }
type ClassMethod = { name: string; descriptor: string; code: Buffer | null }
type ParsedClass = { pool: ConstantPoolEntry[]; fields: ClassField[]; methods: ClassMethod[] }
type Instruction = { offset: number; opcode: number; operand: number | null }

class ClassReader {
  private offset = 0
  private readonly data: Buffer

  constructor(data: Buffer) { this.data = data }

  u1(): number { const value = this.data.readUInt8(this.offset); this.offset += 1; return value }
  u2(): number { const value = this.data.readUInt16BE(this.offset); this.offset += 2; return value }
  u4(): number { const value = this.data.readUInt32BE(this.offset); this.offset += 4; return value }
  i4(): number { const value = this.data.readInt32BE(this.offset); this.offset += 4; return value }
  bytes(length: number): Buffer { const value = this.data.subarray(this.offset, this.offset + length); this.offset += length; return value }
  skip(length: number): void { this.offset += length }
}

const utf8 = (pool: ConstantPoolEntry[], index: number): string | null => {
  const entry = pool[index]
  return entry?.tag === 1 ? entry.value : null
}

const constantValue = (pool: ConstantPoolEntry[], index: number): unknown => {
  const entry = pool[index]
  if (!entry) return null
  if (entry.tag === 1 || entry.tag === 3 || entry.tag === 4 || entry.tag === 5 || entry.tag === 6) return entry.value
  if (entry.tag === 8) return utf8(pool, entry.index)
  return null
}

const className = (pool: ConstantPoolEntry[], index: number): string | null => {
  const entry = pool[index]
  return entry?.tag === 7 ? utf8(pool, entry.index) : null
}

const memberRef = (pool: ConstantPoolEntry[], index: number): { owner: string; name: string; descriptor: string } | null => {
  const entry = pool[index]
  if (!entry || (entry.tag !== 9 && entry.tag !== 10 && entry.tag !== 11)) return null
  const owner = className(pool, entry.first)
  const nameType = pool[entry.second]
  if (!owner || !nameType || nameType.tag !== 12) return null
  const name = utf8(pool, nameType.first)
  const descriptor = utf8(pool, nameType.second)
  return name && descriptor ? { owner, name, descriptor } : null
}

const parseClass = (data: Buffer): ParsedClass => {
  const reader = new ClassReader(data)
  if (reader.u4() !== 0xcafebabe) throw new Error('无效的 Java class 文件')
  reader.skip(4)
  const poolCount = reader.u2()
  const pool: ConstantPoolEntry[] = Array.from({ length: poolCount }, () => null)
  for (let index = 1; index < poolCount; index += 1) {
    const tag = reader.u1()
    if (tag === 1) pool[index] = { tag, value: reader.bytes(reader.u2()).toString('utf8') }
    else if (tag === 3) pool[index] = { tag, value: reader.i4() }
    else if (tag === 4) pool[index] = { tag, value: reader.bytes(4).readFloatBE(0) }
    else if (tag === 5) { pool[index] = { tag, value: reader.bytes(8).readBigInt64BE(0) }; index += 1 }
    else if (tag === 6) { pool[index] = { tag, value: reader.bytes(8).readDoubleBE(0) }; index += 1 }
    else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) pool[index] = { tag, index: reader.u2() }
    else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) pool[index] = { tag, first: reader.u2(), second: reader.u2() }
    else if (tag === 15) pool[index] = { tag, kind: reader.u1(), index: reader.u2() }
    else throw new Error(`不支持的常量池标签：${tag}`)
  }

  reader.skip(6)
  const interfaceCount = reader.u2()
  reader.skip(interfaceCount * 2)

  const readAttributes = (): Array<{ name: string; data: Buffer }> => {
    const attributes: Array<{ name: string; data: Buffer }> = []
    const count = reader.u2()
    for (let index = 0; index < count; index += 1) {
      const name = utf8(pool, reader.u2()) ?? ''
      attributes.push({ name, data: reader.bytes(reader.u4()) })
    }
    return attributes
  }

  const fields: ClassField[] = []
  const fieldCount = reader.u2()
  for (let index = 0; index < fieldCount; index += 1) {
    reader.skip(2)
    const name = utf8(pool, reader.u2()) ?? ''
    const descriptor = utf8(pool, reader.u2()) ?? ''
    const attributes = readAttributes()
    const constantAttribute = attributes.find((attribute) => attribute.name === 'ConstantValue')
    const constantIndex = constantAttribute?.data.length === 2 ? constantAttribute.data.readUInt16BE(0) : 0
    fields.push({ name, descriptor, constant: constantIndex ? constantValue(pool, constantIndex) : null })
  }

  const methods: ClassMethod[] = []
  const methodCount = reader.u2()
  for (let index = 0; index < methodCount; index += 1) {
    reader.skip(2)
    const name = utf8(pool, reader.u2()) ?? ''
    const descriptor = utf8(pool, reader.u2()) ?? ''
    const codeAttribute = readAttributes().find((attribute) => attribute.name === 'Code')
    let code: Buffer | null = null
    if (codeAttribute) {
      const codeReader = new ClassReader(codeAttribute.data)
      codeReader.skip(4)
      code = codeReader.bytes(codeReader.u4())
    }
    methods.push({ name, descriptor, code })
  }
  return { pool, fields, methods }
}

const instructionLength = (code: Buffer, offset: number): number => {
  const opcode = code[offset]
  if ([0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc].includes(opcode)) return 2
  if ([0x11, 0x13, 0x14, 0x84, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7].includes(opcode)) return 3
  if (opcode === 0xc5) return 4
  if ([0xb9, 0xba, 0xc8, 0xc9].includes(opcode)) return 5
  if (opcode === 0xaa) {
    const aligned = (offset + 4) & ~3
    const low = code.readInt32BE(aligned + 4)
    const high = code.readInt32BE(aligned + 8)
    return aligned - offset + 12 + Math.max(0, high - low + 1) * 4
  }
  if (opcode === 0xab) {
    const aligned = (offset + 4) & ~3
    const pairs = code.readInt32BE(aligned + 4)
    return aligned - offset + 8 + Math.max(0, pairs) * 8
  }
  if (opcode === 0xc4) return code[offset + 1] === 0x84 ? 6 : 4
  return 1
}

const decodeInstructions = (code: Buffer): Instruction[] => {
  const instructions: Instruction[] = []
  for (let offset = 0; offset < code.length;) {
    const opcode = code[offset]
    let operand: number | null = null
    if ([0x12, 0x10].includes(opcode)) operand = code[offset + 1]
    else if ([0x11, 0x13, 0x14, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1].includes(opcode)) operand = code.readUInt16BE(offset + 1)
    instructions.push({ offset, opcode, operand })
    const length = instructionLength(code, offset)
    if (length <= 0 || offset + length > code.length) break
    offset += length
  }
  return instructions
}

const pushedInteger = (instruction: Instruction, code: Buffer, pool: ConstantPoolEntry[]): number | null => {
  if (instruction.opcode >= 0x02 && instruction.opcode <= 0x08) return instruction.opcode - 0x03
  if (instruction.opcode === 0x10) return code.readInt8(instruction.offset + 1)
  if (instruction.opcode === 0x11) return code.readInt16BE(instruction.offset + 1)
  if ((instruction.opcode === 0x12 || instruction.opcode === 0x13) && instruction.operand !== null) {
    const value = constantValue(pool, instruction.operand)
    return typeof value === 'number' && Number.isInteger(value) ? value : null
  }
  return null
}

const readGameVersion = (parsed: ParsedClass): { major: number; minor: number; patch: number } | null => {
  const clinit = parsed.methods.find((method) => method.name === '<clinit>')?.code
  if (!clinit) return null
  const instructions = decodeInstructions(clinit)
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index]
    if (instruction.opcode !== 0xb7 || instruction.operand === null) continue
    const member = memberRef(parsed.pool, instruction.operand)
    if (!member || member.owner !== 'zombie/core/GameVersion' || member.name !== '<init>' || !member.descriptor.startsWith('(II')) continue
    const values: number[] = []
    let foundNew = false
    for (let cursor = index - 1; cursor >= Math.max(0, index - 12); cursor -= 1) {
      const previous = instructions[cursor]
      if (previous.opcode === 0xbb && previous.operand !== null && className(parsed.pool, previous.operand) === 'zombie/core/GameVersion') {
        foundNew = true
        break
      }
      const value = pushedInteger(previous, clinit, parsed.pool)
      if (value !== null) values.unshift(value)
    }
    if (foundNew && values.length >= 2) {
      const patchField = parsed.fields.find((field) => field.name === 'buildVersion')?.constant
      return { major: values[0], minor: values[1], patch: typeof patchField === 'number' ? patchField : 0 }
    }
  }
  return null
}

const extractZipEntries = (archive: Buffer, wantedNames: Set<string>): Map<string, Buffer> => {
  const result = new Map<string, Buffer>()
  const minimum = Math.max(0, archive.length - 65_557)
  let eocd = -1
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('JAR 中没有 ZIP 目录')
  const entries = archive.readUInt16LE(eocd + 10)
  let cursor = archive.readUInt32LE(eocd + 16)
  for (let index = 0; index < entries && cursor + 46 <= archive.length; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('JAR 中央目录损坏')
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const fileNameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8')
    if (wantedNames.has(name)) {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`JAR 条目损坏：${name}`)
      const localNameLength = archive.readUInt16LE(localOffset + 26)
      const localExtraLength = archive.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const compressed = archive.subarray(start, start + compressedSize)
      result.set(name, method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`不支持的 JAR 压缩方式：${method}`) })())
    }
    cursor += 46 + fileNameLength + extraLength + commentLength
  }
  return result
}

const readCacheIdentity = async (cachePath: string | null): Promise<{ version: string | null; revision: string | null; raw: string }> => {
  if (!cachePath) return { version: null, revision: null, raw: '' }
  try {
    const raw = (await fs.readFile(path.join(cachePath, 'version.txt'), 'utf8')).trim()
    return {
      version: raw.match(/^(\d+\.\d+(?:\.\d+)?)/m)?.[1] ?? null,
      revision: raw.match(/(?:^|\s)(?:revision=)?([a-f0-9]{7,40})(?:\s|$)/im)?.[1] ?? null,
      raw
    }
  } catch {
    return { version: null, revision: null, raw: '' }
  }
}

export const readGameIdentity = async (gamePath: string, buildId: string, cachePath: string | null): Promise<GameIdentity> => {
  const jarPath = path.join(gamePath, 'projectzomboid.jar')
  const cache = await readCacheIdentity(cachePath)
  const evidence: string[] = []
  let binaryVersion: string | null = null
  let binaryRevision: string | null = null
  let jarSha256: string | null = null

  if (existsSync(jarPath)) {
    try {
      const archive = await fs.readFile(jarPath)
      jarSha256 = createHash('sha256').update(archive).digest('hex').toUpperCase()
      const entries = extractZipEntries(archive, new Set(['zombie/core/Core.class', 'zombie/GitVersion.class']))
      const coreData = entries.get('zombie/core/Core.class')
      const revisionData = entries.get('zombie/GitVersion.class')
      if (!coreData) throw new Error('缺少 zombie/core/Core.class')
      const core = parseClass(coreData)
      const version = readGameVersion(core)
      if (version) binaryVersion = `${version.major}.${version.minor}.${version.patch}`
      if (revisionData) {
        const revisionClass = parseClass(revisionData)
        const revision = revisionClass.fields.find((field) => field.name === 'REVISION')?.constant
        if (typeof revision === 'string') binaryRevision = revision
      }
      evidence.push(`二进制：${jarPath}`, `JAR SHA-256：${jarSha256}`)
      if (binaryVersion) evidence.push(`Core.class：${binaryVersion}`)
      if (binaryRevision) evidence.push(`GitVersion.class：${binaryRevision}`)
    } catch (error) {
      evidence.push(`二进制身份读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    evidence.push(`缺少游戏核心文件：${jarPath}`)
  }

  if (cache.raw) evidence.push(`运行缓存：${path.join(cachePath!, 'version.txt')} → ${cache.version ?? '未知'} / ${cache.revision ?? '未知'}`)
  if (binaryVersion) {
    const cacheMismatch = Boolean((cache.version && cache.version !== binaryVersion) || (cache.revision && binaryRevision && cache.revision !== binaryRevision))
    return {
      version: binaryVersion,
      revision: binaryRevision,
      buildId,
      jarSha256,
      status: cacheMismatch ? 'stale-cache' : cache.version || cache.revision ? 'verified' : 'binary-only',
      source: 'binary',
      cachedVersion: cache.version,
      cachedRevision: cache.revision,
      evidence
    }
  }
  if (cache.version) {
    return { version: cache.version, revision: cache.revision, buildId, jarSha256, status: 'cache-only', source: 'cache', cachedVersion: cache.version, cachedRevision: cache.revision, evidence }
  }
  return { version: 'unknown', revision: null, buildId, jarSha256, status: 'unknown', source: 'unknown', cachedVersion: null, cachedRevision: null, evidence }
}
