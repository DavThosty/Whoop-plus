// Prüfsummen des WHOOP-4.0-Rahmens.
// CRC8 schützt nur das Längenfeld (2 Bytes), CRC32 (zlib/IEEE) den aufgefüllten Inhalt.

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

/** CRC-8, Polynom 0x07, Init 0x00, nicht reflektiert, kein XOR-Out. */
export function crc8(data: ArrayLike<number>, start = 0, end = data.length): number {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC8_TABLE[(c ^ data[i]!) & 0xff]!;
  return c;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** Standard-CRC-32 (zlib/IEEE 802.3, reflektiert 0xEDB88320, Init/XOR-Out 0xFFFFFFFF). */
export function crc32(data: ArrayLike<number>, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
