// Minimal tar.gz reader for the GitHub codeload snapshot (ustar + pax/GNU long names).
import zlib from "node:zlib";
import { io } from "./errors.js";

/**
 * Yields `{ path, type, data }` for every entry. `type` is "file" for regular
 * files. Decompression is capped at `maxBytes` to defuse gzip bombs.
 */
export function* readTarGz(buf, maxBytes) {
  let tar;
  try {
    tar = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    throw io(`gunzip corpus tarball: ${e.message}`);
  }
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= tar.length) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const field = (a, b) => {
      const s = hdr.subarray(a, b);
      const nul = s.indexOf(0);
      return s.subarray(0, nul < 0 ? s.length : nul).toString("utf8");
    };
    const name = field(0, 100);
    const size = parseInt(field(124, 136).trim() || "0", 8);
    const typeflag = String.fromCharCode(hdr[156] || 48);
    const prefix = hdr.subarray(257, 263).toString("latin1").startsWith("ustar") ? field(345, 500) : "";
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x") {
      paxPath = parsePax(data).path ?? null;
      continue;
    }
    if (typeflag === "g") continue; // global pax header (commit comment)

    const full = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    longName = null;
    const type = typeflag === "0" || typeflag === "\0" || typeflag === "7" ? "file" : typeflag === "5" ? "dir" : "other";
    yield { path: full, type, data };
  }
}

function parsePax(data) {
  // Record lengths are in bytes, so walk the Buffer, not a decoded string.
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString("latin1"), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Normal path components (drops `.`, `..`, empty and root parts). */
export const components = (p) => p.split("/").filter((c) => c && c !== "." && c !== "..");
