// Packfile codec (git pack format v2) for upload-pack generation and receive-pack parsing.
// Generation writes whole objects only (no delta encoding): self-contained packs are
// faster to build and the client accepts them. Parsing must apply REF_DELTA and
// OFS_DELTA, because real git clients send delta-compressed packs on push.
import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { makeObject, parseObject, type GitObject, type ObjType } from './gitobj.ts';

// Pack object type numbers (git pack format).
const TYPE_COMMIT = 1;
const TYPE_TREE = 2;
const TYPE_BLOB = 3;
const TYPE_TAG = 4;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackOptions {
  /** zlib compression level for generated objects (1 = fastest; the perf plan A/B-tests 0 vs 1). */
  level?: number;
}

/** Encode one object header: variable-length (type + size). */
function encodeObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (size & 0x0f) | (typeNum << 4);
  size >>>= 4;
  if (size !== 0) b |= 0x80;
  bytes.push(b);
  while (size !== 0) {
    b = size & 0x7f;
    size >>>= 7;
    if (size !== 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Decode one object header at `off`. Returns {typeNum, size, next}. */
function decodeObjectHeader(buf: Buffer, off: number): { typeNum: number; size: number; next: number } {
  let b = buf[off];
  const typeNum = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (b & 0x80) {
    b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { typeNum, size, next: i };
}

/** Decode the variable-length offset of an OFS_DELTA (stored as a negative offset). */
function decodeOfsDeltaOffset(buf: Buffer, off: number): { offset: number; next: number } {
  let b = buf[off];
  let offset = b & 0x7f;
  let i = off + 1;
  while (b & 0x80) {
    b = buf[i];
    offset = ((offset + 1) << 7) | (b & 0x7f);
    i += 1;
  }
  return { offset, next: i };
}

/** Decode a delta varint (7 bits per byte, MSB = continuation). */
function decodeDeltaVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let i = off;
  let b: number;
  do {
    b = buf[i];
    value = (value << 7) | (b & 0x7f);
    i += 1;
  } while (b & 0x80);
  return { value, next: i };
}

/** Apply delta instructions to a base object's raw content bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const srcSize = decodeDeltaVarint(delta, 0);
  const tgtSize = decodeDeltaVarint(delta, srcSize.next);
  if (srcSize.value !== base.length) {
    throw new Error(`delta base size mismatch: delta says ${srcSize.value}, base is ${base.length}`);
  }
  const out = Buffer.alloc(tgtSize.value);
  let outOff = 0;
  let i = tgtSize.next;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      // Copy from base: offset/size encoded in the following bytes.
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i]; i += 1; }
      if (op & 0x02) { offset |= delta[i] << 8; i += 1; }
      if (op & 0x04) { offset |= delta[i] << 16; i += 1; }
      if (op & 0x08) { offset |= delta[i] << 24; i += 1; }
      if (op & 0x10) { size = delta[i]; i += 1; }
      if (op & 0x20) { size |= delta[i] << 8; i += 1; }
      if (op & 0x40) { size |= delta[i] << 16; i += 1; }
      if (size === 0) size = 0x10000;
      base.copy(out, outOff, offset, offset + size);
      outOff += size;
    } else if (op !== 0) {
      // Insert literal bytes.
      delta.copy(out, outOff, i, i + op);
      outOff += op;
      i += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (outOff !== tgtSize.value) {
    throw new Error(`delta output size mismatch: wrote ${outOff}, expected ${tgtSize.value}`);
  }
  return out;
}

/**
 * Generate a packfile (v2) containing the given objects as whole objects
 * (no delta encoding). Objects are written in the order given. The trailer
 * is the SHA-1 of everything before it.
 */
export function encodePack(objects: GitObject[], opts: PackOptions = {}): Buffer {
  const level = opts.level ?? 1;
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeNum = TYPE_NUM[obj.type];
    parts.push(encodeObjectHeader(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data, { level }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Parse a packfile (v2) into objects. Applies OFS_DELTA and REF_DELTA chains
 * (deltas may reference objects earlier in the same pack). Returns objects in
 * pack order. Throws on a malformed pack, a bad checksum, or an unresolvable delta.
 */
export function parsePack(buf: Buffer): GitObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Verify the trailer checksum.
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');

  const objects: GitObject[] = [];
  // byId holds fully-resolved objects by their SHA-1 hex, for REF_DELTA lookup.
  const byId = new Map<string, GitObject>();
  // byOffset holds fully-resolved objects by their pack byte offset, for OFS_DELTA lookup.
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const objStart = off;
    const { typeNum, size, next } = decodeObjectHeader(buf, off);
    off = next;
    if (typeNum === TYPE_OFS_DELTA) {
      const { offset, next: afterOfs } = decodeOfsDeltaOffset(buf, off);
      off = afterOfs;
      const baseStart = objStart - offset;
      // The base object starts at baseStart; find it among already-parsed objects.
      const base = byOffset.get(baseStart);
      if (!base) throw new Error(`ofs-delta base not found at offset ${baseStart}`);
      const inflated = inflateSync(buf.subarray(off));
      const consumed = inflatedConsumedLength(buf, off);
      off += consumed;
      const data = applyDelta(base.data, inflated);
      const obj = makeObject(base.type, data);
      byOffset.set(objStart, obj);
      objects.push(obj);
      byId.set(obj.id, obj);
    } else if (typeNum === TYPE_REF_DELTA) {
      const baseId = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = byId.get(baseId);
      if (!base) throw new Error(`ref-delta base ${baseId} not found`);
      const inflated = inflateSync(buf.subarray(off));
      const consumed = inflatedConsumedLength(buf, off);
      off += consumed;
      const data = applyDelta(base.data, inflated);
      const obj = makeObject(base.type, data);
      byOffset.set(objStart, obj);
      objects.push(obj);
      byId.set(obj.id, obj);
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      const inflated = inflateSync(buf.subarray(off));
      const consumed = inflatedConsumedLength(buf, off);
      off += consumed;
      if (inflated.length !== size) {
        throw new Error(`object size mismatch: header ${size}, inflated ${inflated.length}`);
      }
      const obj = makeObject(type, inflated);
      byOffset.set(objStart, obj);
      objects.push(obj);
      byId.set(obj.id, obj);
    }
  }
  return objects;
}

// The zlib stream's consumed length is not exposed by inflateSync on a subarray
// (it inflates to the end of the buffer). We find the stream end by binary
// search: verified 2026-11-17 that Node's inflateSync IGNORES trailing bytes
// (succeeds) and THROWS on a truncated stream, so "prefix inflates" is a
// monotone predicate and the smallest succeeding prefix is exactly the stream
// end. Packs in this contest are small (pushes are 1 KiB changes), so the
// repeated probes are cheap.
function inflatedConsumedLength(buf: Buffer, off: number): number {
  // Find the end of the zlib stream by trying increasing prefixes.
  // zlib streams end at a byte boundary; we grow the window exponentially then
  // binary-search. In practice the stream is short.
  let lo = 1;
  let hi = Math.min(buf.length - off, 64);
  const probe = (len: number): boolean => {
    try {
      inflateSync(buf.subarray(off, off + len));
      return true;
    } catch {
      return false;
    }
  };
  if (!probe(hi)) {
    while (hi < buf.length - off && !probe(hi)) hi = Math.min(buf.length - off, hi * 2);
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (probe(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Parse a packfile's raw object list without resolving deltas (for inspection). */
export function countPackObjects(buf: Buffer): number {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  return buf.readUInt32BE(8);
}
