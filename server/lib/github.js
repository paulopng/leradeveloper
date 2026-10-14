// GitHub integration. Public repo stats work (unauthenticated, cached 1h,
// opt-in via Settings → GitHub). Sign-in, starring, watching and issue filing
// need an OAuth app of your own; until one is configured they report
// "sign-in required" and the UI shows its signed-out state.
import fsp from "node:fs/promises";
import path from "node:path";
import { appDataDir } from "./paths.js";
import { atomicWrite, mkdirp } from "./fsutil.js";
import { authRequired, httpStatus, network, AppError } from "./errors.js";
import { effective, requireNetwork } from "./settings.js";
import { githubSlug } from "./git.js";

const TTL_MS = 60 * 60 * 1000;
const UA = { "User-Agent": "leradev", Accept: "application/vnd.github+json" };

async function getJson(url) {
  let r;
  try {
    r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw network(url, e.message);
  }
  if (r.status === 404) return null;
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") {
    throw new AppError("github_rate_limited", { resetAt: Number(r.headers.get("x-ratelimit-reset")) || 0 });
  }
  if (!r.ok) throw httpStatus(url, r.status);
  return r.json();
}

async function repoStats(homepage) {
  if (!effective()?.githubEnabled) return null;
  requireNetwork("github_repo_stats");
  const repo = githubSlug(homepage);
  if (!repo) return null;
  const cache = path.join(appDataDir(), "github-cache", `${repo.owner}__${repo.repo}.json`.toLowerCase());
  try {
    const c = JSON.parse(await fsp.readFile(cache, "utf8"));
    if (Date.now() - c.at < TTL_MS) return c.stats;
  } catch {
    /* miss */
  }
  const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const r = await getJson(base);
  if (!r) return null;
  let tag = null;
  let date = null;
  const rel = await getJson(`${base}/releases/latest`).catch(() => null);
  if (rel) {
    tag = rel.tag_name ?? null;
    date = rel.published_at ?? null;
  } else {
    const tags = await getJson(`${base}/tags?per_page=1`).catch(() => null);
    tag = tags?.[0]?.name ?? null;
  }
  const stats = {
    owner: repo.owner,
    repo: repo.repo,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    lastReleaseTag: tag,
    lastReleaseDate: date,
    archived: !!r.archived,
    archivedAt: r.archived_at ?? null,
    licenseSpdx: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
    defaultBranch: r.default_branch ?? "main",
    primaryLanguage: r.language ?? null,
  };
  await mkdirp(path.dirname(cache));
  await atomicWrite(cache, JSON.stringify({ at: Date.now(), stats }));
  return stats;
}

const needsAuth = () => {
  throw authRequired();
};

export const commands = {
  github_repo_stats: ({ homepage }) => repoStats(homepage),
  github_status: () => ({ signedIn: false, username: null, scopes: [] }),
  github_signin_start: needsAuth,
  github_signin_poll: needsAuth,
  github_signout: () => null,
  github_star: needsAuth,
  github_unstar: needsAuth,
  github_is_starred: () => false,
  github_watch: needsAuth,
  github_unwatch: needsAuth,
  github_create_issue: needsAuth,
};
