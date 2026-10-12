// Persisted user settings (`settings.json`) with the original three-state load:
// first launch (defaults), loaded, or corrupt (fail closed for network calls).
import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "./paths.js";
import { atomicWrite, mkdirp } from "./fsutil.js";
import { internal, invalidArgument, paranoidBlocked } from "./errors.js";

const MAX_SETTINGS_BYTES = 1024 * 1024;

export const defaults = () => ({
  paranoidMode: false,
  catalogStaleBannerDays: 14,
  caskIconMode: "all",
  trendingTtlMinutes: 60,
  githubEnabled: false,
  aiFeaturesEnabled: true,
  updateAutoCheck: false,
  skippedUpdateVersions: [],
  enhancedTrendingEnabled: false,
  vulnerabilityScanningEnabled: false,
  liveEnrichmentEnabled: false,
  toolPaths: {},
});

const clampNum = (v, lo, hi, d) => {
  const n = Number.isFinite(v) ? Math.trunc(v) : d;
  return Math.min(hi, Math.max(lo, n));
};

/** Fill missing fields with defaults and clamp numerics (mirrors `Settings::clamp`). */
export function normalize(input) {
  const d = defaults();
  const s = { ...d, ...(input && typeof input === "object" ? input : {}) };
  s.catalogStaleBannerDays = clampNum(s.catalogStaleBannerDays, 1, 365, d.catalogStaleBannerDays);
  s.trendingTtlMinutes = clampNum(s.trendingTtlMinutes, 5, 1440, d.trendingTtlMinutes);
  if (!Array.isArray(s.skippedUpdateVersions)) s.skippedUpdateVersions = [];
  s.skippedUpdateVersions = s.skippedUpdateVersions.slice(-10);
  if (!s.toolPaths || typeof s.toolPaths !== "object") s.toolPaths = {};
  if (!["off", "installed-only", "all"].includes(s.caskIconMode)) s.caskIconMode = "all";
  for (const k of [
    "paranoidMode",
    "githubEnabled",
    "aiFeaturesEnabled",
    "updateAutoCheck",
    "enhancedTrendingEnabled",
    "vulnerabilityScanningEnabled",
    "liveEnrichmentEnabled",
  ])
    s[k] = !!s[k];
  return s;
}

const settingsPath = () => path.join(appDataDir(), "settings.json");

/** { kind: "firstLaunch" } | { kind: "loaded", settings } | { kind: "corrupt", message } */
let state = load();

function load() {
  const p = settingsPath();
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    if (e.code === "ENOENT") return { kind: "firstLaunch" };
    return { kind: "corrupt", message: `stat ${p}: ${e.message}` };
  }
  if (st.size > MAX_SETTINGS_BYTES)
    return { kind: "corrupt", message: `settings.json is ${st.size} bytes, exceeds ${MAX_SETTINGS_BYTES}-byte cap` };
  try {
    return { kind: "loaded", settings: normalize(JSON.parse(fs.readFileSync(p, "utf8"))) };
  } catch (e) {
    return { kind: "corrupt", message: `parse ${p}: ${e.message}` };
  }
}

/** Settings in force, or null when the file is corrupt. */
export function effective() {
  if (state.kind === "loaded") return state.settings;
  if (state.kind === "firstLaunch") return defaults();
  return null;
}

/** Gate every outbound call: paranoid mode on, or corrupt settings, blocks it. */
export function requireNetwork(feature) {
  if (state.kind === "firstLaunch") return;
  if (state.kind === "loaded" && !state.settings.paranoidMode) return;
  throw paranoidBlocked(feature);
}

async function persist(s) {
  const clamped = normalize(s);
  const bytes = JSON.stringify(clamped, null, 2);
  if (bytes.length > MAX_SETTINGS_BYTES) throw invalidArgument("serialized settings exceed the size cap");
  await mkdirp(appDataDir());
  await atomicWrite(settingsPath(), bytes);
  state = { kind: "loaded", settings: clamped };
  return clamped;
}

export const commands = {
  settings_get() {
    if (state.kind === "corrupt") throw internal(`settings file is unreadable: ${state.message}`);
    return effective();
  },
  settings_set({ settings }) {
    return persist(settings);
  },
  settings_reset() {
    return persist(defaults());
  },
};
