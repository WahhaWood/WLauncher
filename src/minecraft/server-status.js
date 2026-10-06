const net = require('net');

/**
 * Minecraft Server List Ping (modern, 1.7+).
 * Returns { online, players: {online, max}, version, motd, latency } or { online: false, error }.
 */
function pingServer(address, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let host = address;
    let port = 25565;
    const match = address.match(/^(.+):(\d+)$/);
    if (match) {
      host = match[1];
      port = Number(match[2]);
    }

    const started = Date.now();
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ online: false, error: 'таймаут' }), timeoutMs);

    socket.on('error', (err) => finish({ online: false, error: err.message }));

    socket.on('connect', () => {
      const handshake = Buffer.concat([
        writeVarInt(0), // packet id
        writeVarInt(0x7f), // protocol version (any works for status)
        writeString(host),
        writeUShort(port),
        writeVarInt(1), // next state: status
      ]);
      const request = writeVarInt(0); // empty status request
      socket.write(Buffer.concat([writeVarInt(handshake.length), handshake, writeVarInt(request.length), request]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const frame = readFrame(buffer);
        if (!frame) return; // wait for more data
        const { packet } = frame;
        let offset = 0;
        // packet id, then the length-prefixed JSON payload
        offset += readVarInt(packet, offset).size;
        const jsonLen = readVarInt(packet, offset);
        offset += jsonLen.size;
        const json = JSON.parse(packet.slice(offset, offset + jsonLen.value).toString('utf8'));
        finish({
          online: true,
          latency: Date.now() - started,
          players: {
            online: json.players?.online ?? 0,
            max: json.players?.max ?? 0,
          },
          version: json.version?.name ?? '',
          motd: cleanMotd(json.description),
        });
      } catch (err) {
        finish({ online: false, error: err.message });
      }
    });
  });
}

function readFrame(buffer) {
  try {
    const len = readVarInt(buffer, 0);
    if (buffer.length < len.size + len.value) return null;
    return {
      consumed: len.size + len.value,
      packet: buffer.slice(len.size, len.size + len.value),
    };
  } catch {
    return null;
  }
}

function cleanMotd(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  const parts = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.text) parts.push(node.text);
      if (node.extra) walk(node.extra);
    }
  };
  walk(description);
  return parts.join('').trim().slice(0, 80);
}

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let value = 0;
  let size = 0;
  let byte;
  do {
    if (offset + size >= buffer.length) throw new Error('короткий VarInt');
    byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) throw new Error('слишком длинный VarInt');
  } while (byte & 0x80);
  return { value, size };
}

function writeString(str) {
  const data = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function writeUShort(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
}

module.exports = { pingServer };
