// Minimal YAML reader for agent frontmatter.
//
// Agent frontmatter is a flat mapping of scalar fields (name, description,
// emoji, color, vibe, tools, ...). This reader understands exactly that subset:
// plain, single- and double-quoted scalars (including multi-line folding),
// block scalars (`|`, `>` with chomping indicators), and comments. Nested
// values (lists, maps, flow collections) are skipped and read back as `null`,
// since the app never surfaces them.
//
// It throws on input a real YAML parser would reject in ways that matter here
// (a non-key line at column 0, `: ` inside a plain scalar, unterminated
// quotes), so files the original app skipped as invalid are skipped here too.

export class YamlError extends Error {}

const KNOWN = new Set(["name", "description", "emoji", "color", "vibe"]);
const KEY_RE =/^([A-Za-z0-9_][A-Za-z0-9_\-. ]*?)\s*:(?:\s+(.*)|\s*)$/;

const indentOf = (line) => line.length - line.replace(/^[ \t]+/, "").length;
const isBlankOrComment = (line) => /^\s*(#.*)?$/.test(line);

export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    if (indentOf(line) > 0) throw new YamlError(`unexpected indentation at line ${i + 1}`);
    if (line === "---" || line === "...") {
      i++;
      continue;
    }
    const m = KEY_RE.exec(line);
    if (!m) throw new YamlError(`expected a key at line ${i + 1}`);
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    i++;

    // Gather the continuation block: following lines that are indented or blank.
    const block = [];
    while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 0)) {
      block.push(lines[i]);
      i++;
    }
    // Trailing blank lines belong to nobody.
    while (block.length && block[block.length - 1].trim() === "") block.pop();

    // serde rejects a repeated struct field; repeats of other keys are ignored.
    if (Object.prototype.hasOwnProperty.call(out, key) && KNOWN.has(key)) throw new YamlError(`duplicate field ${key}`);
    out[key] = readValue(rest, block, key);
  }
  return out;
}

function readValue(rest, block, key) {
  if (rest === "" || rest.startsWith("#")) {
    // Nested collection or an empty (null) value.
    const firstReal = block.find((l) => !isBlankOrComment(l));
    if (!firstReal) return null;
    const t = firstReal.trim();
    if (t.startsWith("- ") || t === "-" || KEY_RE.test(t)) return null; // nested list/map
    // A plain scalar that starts on the next line.
    return foldPlain([], block, key);
  }

  const c = rest[0];
  if (c === "|" || c === ">") return blockScalar(rest, block);
  if (c === '"') return doubleQuoted([rest, ...block].join("\n"), key);
  if (c === "'") return singleQuoted([rest, ...block].join("\n"), key);
  if (c === "[" || c === "{") return null; // flow collection
  if (c === "&" || c === "*" || c === "!") return null; // anchors/aliases/tags — not used by agents
  if (c === "@" || c === "`") throw new YamlError(`${key}: plain scalar cannot start with ${c}`);
  return foldPlain([rest], block, key);
}

function stripComment(s) {
  const idx = s.search(/\s#/);
  return (idx >= 0 ? s.slice(0, idx) : s).trimEnd();
}

function foldPlain(first, block, key) {
  const parts = [];
  for (const raw of [...first, ...block]) {
    const t = raw.trim();
    if (t.startsWith("#")) break;
    parts.push(t);
  }
  // Fold: single line breaks become spaces, blank lines become newlines.
  let s = "";
  let pendingBreaks = 0;
  for (const p of parts) {
    if (p === "") {
      pendingBreaks++;
      continue;
    }
    const v = stripComment(p);
    if (/:\s/.test(v) || v.endsWith(":")) throw new YamlError(`${key}: mapping values are not allowed here`);
    if (s === "") s = v;
    else s += pendingBreaks ? "\n".repeat(pendingBreaks) + v : " " + v;
    pendingBreaks = 0;
  }
  return coercePlain(s);
}

// YAML 1.2 core schema: null-like plain scalars read as null; everything else
// as its string text (the app only consumes strings).
function coercePlain(s) {
  if (s === "" || s === "~" || /^(null|Null|NULL)$/.test(s)) return null;
  return s;
}

function blockScalar(header, block) {
  const m = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(header);
  if (!m) throw new YamlError(`bad block scalar header ${header}`);
  const style = m[1];
  const chomp = m[2] || m[4];
  const nonBlank = block.filter((l) => l.trim() !== "");
  if (!nonBlank.length) return "";
  const ind = m[3] ? Number(m[3]) : Math.min(...nonBlank.map(indentOf));
  const lines = block.map((l) => (l.trim() === "" ? "" : l.slice(ind)));
  let body;
  if (style === "|") {
    body = lines.join("\n");
  } else {
    // Folding: a break between two plain lines becomes a space; each blank
    // line in between becomes one newline; more-indented lines keep breaks.
    body = lines[0];
    let blanks = 0;
    let prev = lines[0];
    for (let j = 1; j < lines.length; j++) {
      const l = lines[j];
      if (l === "") {
        blanks++;
        continue;
      }
      const literal = /^\s/.test(l) || /^\s/.test(prev);
      if (blanks) body += "\n".repeat(literal ? blanks + 1 : blanks) + l;
      else body += (literal ? "\n" : " ") + l;
      blanks = 0;
      prev = l;
    }
  }
  if (chomp === "-") return body.replace(/\n+$/, "");
  if (chomp === "+") return body + "\n";
  return body.replace(/\n+$/, "") + "\n";
}

function foldQuotedLines(text) {
  // Line folding inside flow scalars: a single break → space, n+1 breaks → n newlines.
  const segs = text.split("\n");
  let s = segs[0].replace(/[ \t]+$/, "");
  let empties = 0;
  for (let j = 1; j < segs.length; j++) {
    const t = segs[j].trim();
    const isLast = j === segs.length - 1;
    if (t === "" && !isLast) {
      empties++;
      continue;
    }
    const piece = isLast ? segs[j].replace(/^[ \t]+/, "") : t;
    s += empties ? "\n".repeat(empties) + piece : " " + piece;
    empties = 0;
  }
  return s;
}

function doubleQuoted(text, key) {
  let end = -1;
  for (let j = 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === '"') {
      end = j;
      break;
    }
  }
  if (end < 0) throw new YamlError(`${key}: unterminated double-quoted scalar`);
  const tail = text.slice(end + 1).trim();
  if (tail && !tail.startsWith("#")) throw new YamlError(`${key}: trailing content after quoted scalar`);
  const inner = foldQuotedLines(text.slice(1, end));
  return inner.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gs, (_, e) => {
    switch (e[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "b": return "\b";
      case "f": return "\f";
      case "e": return "\x1b";
      case "/": return "/";
      case " ": return " ";
      case '"': return '"';
      case "\\": return "\\";
      case "x": case "u": case "U": return String.fromCodePoint(parseInt(e.slice(1), 16));
      case "\n": return "";
      default: throw new YamlError(`${key}: unknown escape \\${e}`);
    }
  });
}

function singleQuoted(text, key) {
  let end = -1;
  for (let j = 1; j < text.length; j++) {
    if (text[j] === "'") {
      if (text[j + 1] === "'") {
        j++;
        continue;
      }
      end = j;
      break;
    }
  }
  if (end < 0) throw new YamlError(`${key}: unterminated single-quoted scalar`);
  const tail = text.slice(end + 1).trim();
  if (tail && !tail.startsWith("#")) throw new YamlError(`${key}: trailing content after quoted scalar`);
  return foldQuotedLines(text.slice(1, end)).replace(/''/g, "'");
}
