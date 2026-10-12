// Filesystem helpers: crash-safe atomic writes and size-capped reads.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { io } from "./errors.js";

/** Write to `<file>.tmp`, fsync, then rename over `file` (atomic on one volume). */
export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fh;
  try {
    fh = await fs.open(tmp, "w");
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    throw io(`write ${tmp}: ${e.message}`);
  } finally {
    await fh?.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw io(`rename ${tmp} -> ${file}: ${e.message}`);
  }
}

/** Read a file, erroring (never truncating) when it exceeds `max` bytes. */
export async function readCapped(file, max) {
  let st;
  try {
    st = await fs.stat(file);
  } catch (e) {
    throw io(`stat ${file}: ${e.message}`);
  }
  if (st.size > max) throw io(`${file} is ${st.size} bytes, exceeds cap of ${max}`);
  try {
    return await fs.readFile(file);
  } catch (e) {
    throw io(`read ${file}: ${e.message}`);
  }
}

export async function mkdirp(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    throw io(`create ${dir}: ${e.message}`);
  }
}

export const exists = (p) => fsSync.existsSync(p);

export function isDir(p) {
  try {
    return fsSync.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isEmptyDir(dir) {
  try {
    return fsSync.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Pretty JSON matching serde_json::to_vec_pretty (2-space indent). */
export const prettyJson = (v) => JSON.stringify(v, null, 2);

export const sep = path.sep;
