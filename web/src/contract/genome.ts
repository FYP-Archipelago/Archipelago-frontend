/**
 * Genome decoding — the port of `archipelago_ui/logreader.py`.
 *
 * The harness writes a genome two ways in the same run: island bests go out in
 * `full` mode as a JSON array, everything else in `compact` mode as base64. Both
 * appear in one file, so both are handled here.
 *
 * This module knows the log format and nothing else. It must not import from
 * render, layout or state — that rule is what lets a live socket source reuse it
 * unchanged.
 */

/** Encodings whose compact payload is base64 little-endian float64. */
const REAL_ENCODINGS = new Set([
  "real_vector",
  "real_vector_velocity",
  "real_vector_sigma",
]);

function base64ToBytes(text: string): Uint8Array {
  // atob exists in browsers and in Node >= 16.
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Little-endian float64, base64'd — `_pack_floats` in the contract. */
function unpackFloats(text: string): Float64Array {
  const bytes = base64ToBytes(text);
  const count = Math.floor(bytes.length / 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getFloat64(i * 8, true);
  return out;
}

/** `<length>:<base64>`, 8 bits to the byte. */
function unpackBits(text: string): Float64Array {
  const separator = text.indexOf(":");
  if (separator < 0) throw new Error("bitstring payload has no length prefix");
  const length = Number.parseInt(text.slice(0, separator), 10);
  if (!Number.isFinite(length)) throw new Error("bitstring length is not a number");
  const packed = base64ToBytes(text.slice(separator + 1));
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const byte = packed[i >> 3] ?? 0;
    out[i] = (byte >> (i % 8)) & 1;
  }
  return out;
}

/** Little-endian uint32 — permutation encoding. */
function unpackInts(text: string): Float64Array {
  const bytes = base64ToBytes(text);
  const count = Math.floor(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getUint32(i * 4, true);
  return out;
}

/**
 * A genome's position as a float vector, or null if undecodable.
 *
 * Returning null rather than throwing is deliberate and matches Python: a row
 * whose genome cannot be read is dropped from the network, and one malformed row
 * must not fail the whole load.
 */
export function decodeGenome(
  encoding: string | null | undefined,
  reprMode: string | null | undefined,
  payload: string | null | undefined,
): Float64Array | null {
  if (payload === null || payload === undefined || payload === "") return null;
  if (reprMode === "hashed") return null;

  const text = String(payload);

  if (reprMode === "full") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    // Composite encodings keep position under "x".
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      value = (value as Record<string, unknown>)["x"];
    }
    if (!Array.isArray(value)) return null;
    const out = new Float64Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const n = Number(value[i]);
      if (!Number.isFinite(n) && value[i] !== null) {
        // Python's float() raises on a non-numeric entry and the row is dropped.
        if (typeof value[i] !== "number" && typeof value[i] !== "string") return null;
      }
      out[i] = n;
    }
    return out;
  }

  // compact
  try {
    if (encoding === "bitstring") return unpackBits(text);
    if (encoding === "permutation") return unpackInts(text);
    if (encoding !== null && encoding !== undefined && REAL_ENCODINGS.has(encoding)) {
      if (text.startsWith("{")) {
        // composite: {"x": ..., "v": ...}
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const inner = parsed["x"];
        if (typeof inner !== "string") return null;
        return unpackFloats(inner);
      }
      return unpackFloats(text);
    }
  } catch {
    return null;
  }
  return null;
}
