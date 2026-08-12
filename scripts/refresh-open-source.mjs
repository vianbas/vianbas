#!/usr/bin/env node
/**
 * Regenerates the "Open Source" section of the profile README from GitHub.
 *
 * Lists merged pull requests authored by the user into PUBLIC external
 * repositories (not owned by the user), newest first, via the GraphQL
 * `User.pullRequests(states: MERGED)` connection — authoritative database
 * data, not the eventually-consistent search index.
 *
 * The section is rewritten between the marker comments
 * `<!-- OPEN-SOURCE:START -->` and `<!-- OPEN-SOURCE:END -->` in README.md,
 * so the rest of the file is untouched. When nothing changed the README is
 * left alone and the calling workflow detects that via `git diff`.
 *
 * Hand-written narratives live in the NOTES map keyed by "owner/repo#pr".
 * PRs without a note get a short generic entry. Always exits 0.
 *
 * Run locally with:
 *     GITHUB_TOKEN=... node scripts/refresh-open-source.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const README = join(__dirname, "..", "README.md");

const START_MARKER = "<!-- OPEN-SOURCE:START -->";
const END_MARKER = "<!-- OPEN-SOURCE:END -->";

const USER = "vianbas";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

/** Hand-written narrative for known PRs, preserved across regenerations. */
const NOTES = {
  "aovestdipaperino/tokensave#379": {
    badge: "Docs · Security",
    summary:
      "Corrected `SECURITY.md` so it accurately describes FTS5 data retention — the `executable_body_fts` index stores full function bodies, not just metadata. Merged Aug 2026. tokensave is a code-intelligence MCP server.",
  },
  "SasanLabs/VulnerableApp#728": {
    badge: "i18n",
    summary:
      "Fixed mojibake in the Swedish and Spanish translation bundles. Merged Aug 2026. VulnerableApp is a deliberately vulnerable web app for security training.",
  },
  "SasanLabs/VulnerableApp#732": {
    badge: "i18n",
    summary:
      "Fixed words glued together by line continuations in the i18n bundles. Merged Aug 2026.",
  },
};

async function fetchExternalMergedPRs() {
  const rows = [];
  let cursor = null;
  for (let pages = 0; pages < 20; pages++) {
    const query = `query($login:String!,$cursor:String){
      user(login:$login){
        pullRequests(states: MERGED, first: 100, after: $cursor){
          totalCount
          pageInfo{ hasNextPage endCursor }
          nodes{
            number
            title
            mergedAt
            url
            repository{
              name
              stargazerCount
              isPrivate
              owner{ login }
            }
          }
        }
      }
    }`;
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "vianbas-profile-open-source-refresh",
      },
      body: JSON.stringify({
        query,
        variables: { login: USER, cursor },
      }),
    });
    if (!res.ok) throw new Error(`GraphQL → HTTP ${res.status}`);
    const json = await res.json();
    const pr = json?.data?.user?.pullRequests;
    if (!pr) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    for (const node of pr.nodes) {
      const repo = node.repository;
      if (repo.owner.login === USER || repo.isPrivate) continue;
      rows.push({
        key: `${repo.owner.login}/${repo.name}#${node.number}`,
        repo: `${repo.owner.login}/${repo.name}`,
        number: node.number,
        url: node.url,
        title: node.title,
        stars: repo.stargazerCount,
        mergedAt: node.mergedAt,
      });
    }
    if (!pr.pageInfo.hasNextPage) break;
    cursor = pr.pageInfo.endCursor;
  }
  // Newest merge first.
  rows.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
  return rows;
}

function formatEntry(pr) {
  const note = NOTES[pr.key];
  if (note) {
    return `- **[${pr.repo} #${pr.number}](${pr.url})** — ${note.summary}`;
  }
  return `- **[${pr.repo} #${pr.number}](${pr.url})** — ${pr.title}`;
}

function buildSection(prs) {
  const badgeCount = prs.length;
  const badge =
    `[![External PRs](https://img.shields.io/badge/External_PRs-${badgeCount}-6A9FB5` +
    `?style=flat-square&logo=github&logoColor=white)]` +
    `(https://github.com/search?q=author%3Avianbas+type%3Apr+-user%3Avianbas&type=pullrequests)`;

  const lines = prs.map(formatEntry).join("\n");
  return `## 🌍 Open Source\n\n${badge}\n\n${lines}\n`;
}

let readme = readFileSync(README, "utf8");
const startIdx = readme.indexOf(START_MARKER);
const endIdx = readme.indexOf(END_MARKER);

const prs = await fetchExternalMergedPRs();
const newSection = `<!-- OPEN-SOURCE:START -->\n\n${buildSection(prs)}\n<!-- OPEN-SOURCE:END -->`;

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`Markers not found in ${README} — cannot regenerate section.`);
  process.exit(1);
}

const before = readme.slice(0, startIdx);
const after = readme.slice(endIdx + END_MARKER.length);
const next = `${before}${newSection}${after}`;

if (next !== readme) {
  writeFileSync(README, next);
  console.log(`Open Source section updated with ${prs.length} external PRs.`);
} else {
  console.log("Open Source section unchanged.");
}
