const fs = require('fs');
const path = require('path');

// Minimal NBT reader/writer for servers.dat (uncompressed Java NBT).
// Reading supports the full tag set; writing covers what we emit:
// a root compound with a "servers" list of { name, ip } compounds.

const T = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
};

class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.off = 0;
  }
  u8() {
    return this.buf.readUInt8(this.off++);
  }
  u16() {
    const v = this.buf.readUInt16BE(this.off);
    this.off += 2;
    return v;
  }
  i16() {
    const v = this.buf.readInt16BE(this.off);
    this.off += 2;
    return v;
  }
  i32() {
    const v = this.buf.readInt32BE(this.off);
    this.off += 4;
    return v;
  }
  i64() {
    const v = this.buf.readBigInt64BE(this.off);
    this.off += 8;
    return v;
  }
  f32() {
    const v = this.buf.readFloatBE(this.off);
    this.off += 4;
    return v;
  }
  f64() {
    const v = this.buf.readDoubleBE(this.off);
    this.off += 8;
    return v;
  }
  bytes(n) {
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }
  string() {
    return this.bytes(this.u16()).toString('utf8');
  }
  payload(type) {
    switch (type) {
      case T.BYTE:
        return this.u8();
      case T.SHORT:
        return this.i16();
      case T.INT:
        return this.i32();
      case T.LONG:
        return this.i64();
      case T.FLOAT:
        return this.f32();
      case T.DOUBLE:
        return this.f64();
      case T.BYTE_ARRAY: {
        const n = this.i32();
        return this.bytes(n);
      }
      case T.STRING:
        return this.string();
      case T.LIST: {
        const itemType = this.u8();
        const n = this.i32();
        const items = [];
        for (let i = 0; i < n; i++) items.push(this.payload(itemType));
        return items;
      }
      case T.COMPOUND: {
        const obj = {};
        for (;;) {
          const type = this.u8();
          if (type === T.END) break;
          obj[this.string()] = this.payload(type);
        }
        return obj;
      }
      case T.INT_ARRAY: {
        const n = this.i32();
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(this.i32());
        return arr;
      }
      case T.LONG_ARRAY: {
        const n = this.i32();
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(this.i64());
        return arr;
      }
      default:
        throw new Error(`Неизвестный NBT-тег ${type}`);
    }
  }
}

function readRoot(buffer) {
  const r = new Reader(buffer);
  const type = r.u8();
  if (type !== T.COMPOUND) throw new Error('servers.dat: корень не compound');
  r.string(); // root name, usually ""
  return r.payload(T.COMPOUND);
}

class Writer {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.parts.push(b);
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    this.parts.push(b);
  }
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    this.parts.push(b);
  }
  i64(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(v));
    this.parts.push(b);
  }
  raw(buf) {
    this.parts.push(Buffer.from(buf));
  }
  string(v) {
    const b = Buffer.from(String(v), 'utf8');
    this.u16(b.length);
    this.raw(b);
  }
  buffer() {
    return Buffer.concat(this.parts);
  }
}

// Vanilla boolean flags stored as bytes.
const BYTE_KEYS = new Set(['hidden', 'preventsChatReports']);

function writeEntryTag(w, name, value) {
  if (typeof value === 'string') {
    w.u8(T.STRING);
    w.string(name);
    w.string(value);
  } else if (typeof value === 'bigint') {
    w.u8(T.LONG);
    w.string(name);
    w.i64(value);
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    if (BYTE_KEYS.has(name)) {
      w.u8(T.BYTE);
      w.string(name);
      w.u8(value);
    } else {
      w.u8(T.INT);
      w.string(name);
      w.i32(value);
    }
  }
  // Other shapes (nested compounds, arrays) never occur in server entries
  // and are skipped rather than corrupt the file.
}

function writeServers(servers) {
  const w = new Writer();
  w.u8(T.COMPOUND);
  w.string('');
  w.u8(T.LIST);
  w.string('servers');
  w.u8(T.COMPOUND);
  const entries = servers.filter((s) => s && typeof s.ip === 'string');
  w.i32(entries.length);
  for (const s of entries) {
    // ip first is cosmetic; every key survives the round-trip (icons,
    // hidden flags, chat-report settings of other servers).
    const ordered = { ip: s.ip, name: s.name };
    for (const [k, v] of Object.entries(s)) {
      if (!(k in ordered)) ordered[k] = v;
    }
    for (const [k, v] of Object.entries(ordered)) writeEntryTag(w, k, v);
    w.u8(T.END);
  }
  w.u8(T.END);
  return w.buffer();
}

function readServerList(gameDir) {
  const file = path.join(gameDir, 'servers.dat');
  try {
    const root = readRoot(fs.readFileSync(file));
    if (Array.isArray(root.servers)) return root.servers;
  } catch {
    // missing or corrupt — start fresh
  }
  return [];
}

/**
 * Adds our server to the multiplayer list (or refreshes its name).
 * Never auto-joins: the player picks it from the list themselves.
 * Other entries are left untouched.
 */
function ensureServerEntry(gameDir, ip, name) {
  if (!ip) return;
  const servers = readServerList(gameDir);
  const existing = servers.find((s) => s && s.ip === ip);
  if (existing) {
    existing.name = name;
  } else {
    servers.push({ name, ip });
  }
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'servers.dat'), writeServers(servers));
}

module.exports = { ensureServerEntry, readServerList };
