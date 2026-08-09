#!/usr/bin/env node
/**
 * Refreshes the GitHub facts table in the profile README from the GitHub API.
 *
 * Facts updated:
 *   - 💻 Public repositories   (users API → public_repos)
 *   - 👥 Followers            (users API → followers)
 *   - 🚀 PRs merged into external repos  (search API, minus vianbas/*)
 *   - 📅 GitHub member since  (users API → created_at year)
 *
 * The table is rewritten in place; when nothing changed the README is left
 * untouched so the calling workflow can detect that via `git diff` and skip
 * the commit. Always exits 0. Run locally with:
 *     GITHUB_TOKEN=... node scripts/refresh-profile-facts.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const README = join(__dirname, "..", "README.md");

const GH_API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const USER = "vianbas";

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "vianbas-profile-facts-refresh",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** GET a JSON endpoint, throwing on non-2xx. */
async function gh(path) {
  const res = await fetch(`${GH_API}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/** Count merged PRs authored by USER into repositories NOT owned by USER. */
async function countExternalMergedPRs() {
  let total = 0;
  let page = 1;
  for (;;) {
    const data = await gh(
      `/search/issues?q=author:${USER}+type:pr+is:merged&per_page=100&page=${page}`,
    );
    for (const item of data.items) {
      const repo = item.repository_url ?? "";
      if (!repo.includes(`/vianbas/`)) total++;
    }
    if (data.items.length < 100 || page >= 10) break; // search API caps at 1000
    page++;
  }
  return total;
}

const [user, externalMerged] = await Promise.all([
  gh(`/users/${USER}`),
  countExternalMergedPRs(),
]);

const facts = {
  "💻 Public repositories": String(user.public_repos),
  "👥 Followers": String(user.followers),
  "🚀 PRs merged into external repos": String(externalMerged),
  "📅 GitHub member since": String(new Date(user.created_at).getUTCFullYear()),
};

let readme = readFileSync(README, "utf8");
let changed = false;

for (const [label, value] of Object.entries(facts)) {
  // Match `| 💻 Public repositories | 40 |` and replace the number cell.
  const row = new RegExp(`(\\| ${label} \\| )\\d+( \\|)`, "u");
  if (row.test(readme)) {
    readme = readme.replace(row, `$1${value}$2`);
    changed = true;
  } else {
    console.warn(`Facts row not found (skipped): ${label}`);
  }
}

if (changed) {
  writeFileSync(README, readme);
  console.log(`README facts updated: ${JSON.stringify(facts)}`);
} else {
  console.log("No facts rows changed.");
}
