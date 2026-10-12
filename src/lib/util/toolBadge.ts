/**
 * Tool badges — re-exported from the single source of truth.
 *
 * Accents, brand marks, and the letter fallback all live in the tool registry
 * (`$lib/data/toolRegistry`, backed by `src-tauri/data/tools/*.json`). This file
 * stays only so the badge components keep importing from one stable path; there
 * is no per-tool data here anymore. Adding a tool is adding a JSON file.
 */
export { toolAccent, toolMark, toolIcon } from "$lib/data/toolRegistry";
