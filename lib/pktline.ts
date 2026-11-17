// pkt-line codec for the git smart-HTTP protocol (gitprotocol-pack / gitprotocol-v2).
// A packet is 4 lowercase hex digits (the length INCLUDING those 4 digits) + payload.
// "0000" is a flush packet, "0001" a delimiter, "0002" a response-end packet.
// A length of 0 after the 4 digits means flush; the 4 digits themselves are never 0.
import { Buffer } from 'node:buffer';

export const FLUSH = '0000';
export const DELIM = '0001';
export const RESPONSE_END = '0002';

/** Encode one payload as a pkt-line (payload + 4-byte length header). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** Encode a flush packet. */
export function pktFlush(): Buffer {
  return Buffer.from(FLUSH, 'ascii');
}

/** Encode a delimiter packet. */
export function pktDelim(): Buffer {
  return Buffer.from(DELIM, 'ascii');
}

/** Encode a response-end packet. */
export function pktResponseEnd(): Buffer {
  return Buffer.from(RESPONSE_END, 'ascii');
}

/** Encode a list of payloads, each as its own pkt-line, then a flush packet. */
export function pktLines(payloads: (Buffer | string)[]): Buffer {
  const parts = payloads.map((p) => pktLine(p));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Parse a whole buffer of pkt-lines into items. Stops at the first flush packet
 * (returns it and the byte offset just past it) so callers can resume parsing
 * a stream. Throws on a truncated or malformed packet.
 */
export function parsePktLines(buf: Buffer, start = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)} at ${off}`);
    if (len === 0) {
      items.push({ kind: 'flush' });
      return { items, next: off + 4 };
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4) throw new Error(`bad pkt-line length ${len} at ${off}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    items.push({ kind: 'data', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return { items, next: off };
}

/**
 * Parse ALL pkt-lines in a buffer (used when the whole message is in hand).
 * Returns every item; a trailing flush is included as a 'flush' item.
 */
export function parseAllPktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let off = 0;
  while (off < buf.length) {
    const { items: chunk, next } = parsePktLines(buf, off);
    items.push(...chunk);
    if (next === off) break;
    off = next;
    // parsePktLines stops at a flush; continue past it if more data follows.
    if (items.length > 0 && items[items.length - 1].kind === 'flush' && off < buf.length) continue;
    if (off >= buf.length) break;
  }
  return items;
}

/** Concatenate the data payloads of pkt items, ignoring flush/delim/response-end markers. */
export function pktDataConcat(items: PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it.kind === 'data') parts.push(it.data);
  }
  return Buffer.concat(parts);
}

/** Split a pkt-line data payload on newlines, dropping a trailing empty piece. */
export function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
