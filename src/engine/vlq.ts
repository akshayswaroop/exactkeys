/** Standard MIDI variable-length quantity. */

export function encodeVlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`VLQ requires a non-negative integer, got ${value}`);
  }
  if (value > 0x0fffffff) {
    throw new Error(`VLQ overflow: ${value}`);
  }
  const bytes: number[] = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

export function decodeVlq(
  data: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let value = 0;
  let i = offset;
  let count = 0;
  while (i < data.length) {
    const b = data[i++];
    value = (value << 7) | (b & 0x7f);
    count++;
    if (count > 4) throw new Error('VLQ longer than 4 bytes');
    if ((b & 0x80) === 0) {
      return { value, next: i };
    }
  }
  throw new Error('Truncated VLQ');
}

export function vlqSize(value: number): number {
  return encodeVlq(value).length;
}
