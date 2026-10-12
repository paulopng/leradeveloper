// Deterministic per-tool agent renderers + destination-path resolution.
// Byte-for-byte port of the original `render/mod.rs`, which itself mirrors the
// upstream agency-agents `scripts/convert.sh`. Every renderer is a pure
// function of the raw source, so `renderedHash` is reproducible — that is what
// lets reconciliation recognize an installed file as ours.
import path from "node:path";
import * as registry from "./registry.js";
import { io } from "./errors.js";
import { sha256Hex } from "./parse.js";

export { sha256Hex };

export const supportsUser = registry.supportsUser;
export const supportsProject = registry.supportsProject;
export const scopeFor = (projectRoot) => (projectRoot ? "project" : "user");
export const label = (tool) => registry.get(tool)?.label ?? tool;

/** Rust `str::lines()`: split on `\n`, drop a trailing `\r`, no final empty line. */
function lines(s) {
  const out = s.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** `lib.sh#get_field`: first `field: value` line in the frontmatter, folded + unquoted. */
export function sourceField(source, field) {
  const prefix = `${field}: `;
  let fences = 0;
  let value = null;
  for (const line of lines(source)) {
    if (line === "---") {
      fences++;
      if (fences >= 2) break;
      continue;
    }
    if (fences !== 1) continue;
    if (value === null) {
      if (line.startsWith(prefix)) value = line.slice(prefix.length);
    } else {
      const rest = line.replace(/^[ \t]+/, "");
      if (rest.length < line.length && rest !== "") value += " " + rest;
      else break;
    }
  }
  return value === null ? "" : unquoteScalar(value);
}

function unquoteScalar(raw) {
  const v = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    return v.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

/** `get_body`: everything after the two frontmatter fences, trailing newlines stripped. */
export function sourceBody(source) {
  let fences = 0;
  let body = "";
  for (const line of lines(source)) {
    if (fences < 2 && line === "---") {
      fences++;
      continue;
    }
    if (fences >= 2) body += line + "\n";
  }
  return body.replace(/\n+$/, "");
}

const yamlQuote = (v) => `'${v.replaceAll("'", "''")}'`;

const QWEN_TOOLS = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "run_shell_command",
  Grep: "grep_search",
  Glob: "glob",
  LS: "list_directory",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  TodoWrite: "todo_write",
  NotebookEdit: "notebook_edit",
  Task: "agent",
};

function qwenTools(tools) {
  const out = [];
  for (const raw of tools.split(",")) {
    const t = raw.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
    if (!t) continue;
    const q = QWEN_TOOLS[t] ?? t;
    if (!out.includes(q)) out.push(q);
  }
  return out.join(", ");
}

/** `lib.sh#slugify` (Unicode lowercase, then ASCII [a-z0-9] runs joined by `-`). */
export function slugify(value) {
  let out = "";
  let prevDash = false;
  for (const ch of value.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) {
      out += ch;
      prevDash = false;
    } else if (out !== "" && !prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  return out.replace(/-+$/, "");
}

export function outputSlug(agent, rawSource, tool) {
  const meta = registry.get(tool);
  if (meta?.slugFrom === "source") return agent.slug;
  return `${meta?.slugPrefix ?? ""}${slugify(sourceField(rawSource, "name"))}`;
}

function unsupported(tool) {
  const kebab = registry.get(tool)?.kebab ?? tool;
  return io(`tool '${kebab}' is not supported for install yet (multi-file format)`);
}

export function render(_agent, raw, tool) {
  const name = sourceField(raw, "name");
  const description = sourceField(raw, "description");
  const body = sourceBody(raw);
  const slug = slugify(name);
  const meta = registry.get(tool);
  switch (meta?.format) {
    case "identity":
      return raw;
    case "cursor-mdc":
      return `---\ndescription: ${yamlQuote(description)}\nglobs: ""\nalwaysApply: false\n---\n${body}\n`;
    case "codex-toml":
      return `name = "${tomlEscape(name)}"\ndescription = "${tomlEscape(description)}"\ndeveloper_instructions = "${tomlEscape(body)}"\n`;
    case "gemini-md":
      return `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
    case "qwen-md": {
      const tools = qwenTools(sourceField(raw, "tools"));
      return tools
        ? `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\ntools: ${yamlQuote(tools)}\n---\n${body}\n`
        : `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
    }
    case "zcode-md": {
      const tools = sourceField(raw, "tools");
      return tools
        ? `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\ntools: ${yamlQuote(tools)}\n---\n${body}\n`
        : `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
    }
    case "skill-md":
      return `---\nname: ${yamlQuote(`${meta.slugPrefix ?? ""}${slug}`)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
    case "opencode-md":
      return `---\nname: ${yamlQuote(name)}\ndescription: ${yamlQuote(description)}\nmode: subagent\ncolor: '${resolveOpencodeColor(sourceField(raw, "color"))}'\n---\n${body}\n`;
    default:
      throw unsupported(tool);
  }
}

export function renderWithHash(agent, raw, tool) {
  const bytes = render(agent, raw, tool);
  return { bytes, hash: sha256Hex(bytes) };
}

/** Absolute destination path(s) for an installed agent. */
export function dests(tool, slug, home, projectRoot) {
  const meta = registry.get(tool);
  const dest = meta?.dest;
  if (!dest) throw unsupported(tool);
  const templates = projectRoot ? dest.project ?? [] : dest.user ?? [];
  const root = projectRoot || home;
  if (!templates.length) {
    throw io(`tool '${meta.kebab ?? tool}' is project-scoped; a project path is required`);
  }
  return templates.map((t) => path.join(root, t.replaceAll("{slug}", slug)));
}

const OPENCODE_COLORS = {
  cyan: "#00FFFF",
  blue: "#3498DB",
  green: "#2ECC71",
  red: "#E74C3C",
  purple: "#9B59B6",
  orange: "#F39C12",
  teal: "#008080",
  indigo: "#6366F1",
  pink: "#E84393",
  gold: "#EAB308",
  amber: "#F59E0B",
  "neon-green": "#10B981",
  "neon-cyan": "#06B6D4",
  "metallic-blue": "#3B82F6",
  yellow: "#EAB308",
  violet: "#8B5CF6",
  rose: "#F43F5E",
  lime: "#84CC16",
  gray: "#6B7280",
  fuchsia: "#D946EF",
  slate: "#64748B",
  navy: "#000080",
};

function resolveOpencodeColor(color) {
  const c = color.trim().replace(/[A-Z]/g, (m) => m.toLowerCase());
  const mapped = OPENCODE_COLORS[c] ?? c;
  const hex = mapped.startsWith("#") ? mapped.slice(1) : mapped;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : "#6B7280";
}

function tomlEscape(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x0c) out += "\\f";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}
