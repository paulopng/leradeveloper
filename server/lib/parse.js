// Tolerant frontmatter parsing + canonical hashing for corpus agents.
// Port of the original `corpus/parse.rs`: the three hashes are SHA-256 of the
// raw byte regions of the source (never a re-serialization), so the same `.md`
// always yields the same hashes.
import crypto from "node:crypto";
import { parseFrontmatter } from "./yaml-lite.js";

export const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Split into `{ frontmatter, body }` or `null` when there's no `---` fence. */
export function splitFrontmatter(source) {
  const s = source.startsWith("﻿") ? source.slice(1) : source;
  const firstEnd = s.indexOf("\n");
  if (firstEnd < 0) return null;
  if (s.slice(0, firstEnd).trimEnd() !== "---") return null;
  const fmStart = firstEnd + 1;
  let from = fmStart;
  for (;;) {
    let lineEnd = s.indexOf("\n", from);
    if (lineEnd < 0) lineEnd = s.length;
    const line = s.slice(from, lineEnd).trimEnd();
    if (line === "---") {
      const frontmatter = s.slice(fmStart, from);
      const body = lineEnd < s.length ? s.slice(lineEnd + 1) : "";
      return { frontmatter, body };
    }
    if (lineEnd >= s.length) return null;
    from = lineEnd + 1;
  }
}

const str = (v) => (v == null ? null : String(v));

/**
 * Parse one agent `.md`. Returns `null` for non-agents (no frontmatter, or no
 * `name`); throws on frontmatter that isn't valid YAML.
 */
export function parseAgent(slug, category, source) {
  const split = splitFrontmatter(source);
  if (!split) return null;
  let fm;
  try {
    fm = parseFrontmatter(split.frontmatter);
  } catch (e) {
    throw new Error(`${slug}: frontmatter YAML parse error: ${e.message}`);
  }
  const name = str(fm.name);
  if (!name || !name.trim()) return null;
  const description = str(fm.description) ?? "";
  const emoji = str(fm.emoji);
  const color = str(fm.color);
  const vibe = str(fm.vibe);

  const agent = { slug, name, description, category, emoji, color, vibe, body: split.body };
  const entry = {
    slug,
    name,
    category,
    emoji,
    color,
    vibe,
    description,
    sourceHash: sha256Hex(source),
    frontmatterHash: sha256Hex(split.frontmatter),
    bodyHash: sha256Hex(split.body),
  };
  return { agent, entry };
}
