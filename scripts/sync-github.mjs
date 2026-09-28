import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const projectsDir = new URL("../content/projects/", import.meta.url);
const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "PS2SP-catalog-sync"
};

async function github(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const names = (await fs.readdir(projectsDir)).filter((name) => name.endsWith(".md"));
let changed = 0;

for (const name of names) {
  const file = new URL(name, projectsDir);
  const input = await fs.readFile(file, "utf8");
  const parsed = matter(input);
  const data = parsed.data;

  if (data?.automation?.sync === false) continue;
  if (data?.source?.provider !== "github" || !data.source.repository) continue;

  const [repo, releases, commits] = await Promise.all([
    github(`/repos/${data.source.repository}`),
    github(`/repos/${data.source.repository}/releases?per_page=5`),
    github(`/repos/${data.source.repository}/commits?per_page=1`)
  ]);

  if (!repo) {
    console.warn(`${data.name}: upstream repository unavailable`);
    continue;
  }

  const previous = structuredClone(data);
  data.source.repositoryId = String(repo.id);
  data.source.repository = repo.full_name;
  data.repository = {
    archived: Boolean(repo.archived),
    defaultBranch: repo.default_branch ?? null,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    lastCommit: commits?.[0]?.commit?.committer?.date ?? commits?.[0]?.commit?.author?.date ?? null
  };

  const release = Array.isArray(releases) ? releases.find((item) => !item.draft && !item.prerelease) ?? releases.find((item) => !item.draft) : null;
  data.latestRelease = release ? {
    tag: release.tag_name ?? null,
    name: release.name ?? null,
    publishedAt: release.published_at ?? release.created_at ?? null,
    url: release.html_url ?? null
  } : {
    tag: null,
    name: null,
    publishedAt: null,
    url: null
  };

  data.activity = { lastChecked: new Date().toISOString() };

  if (!same(previous, data)) {
    await fs.writeFile(file, matter.stringify(parsed.content.trimStart(), data), "utf8");
    changed++;
    console.log(`updated ${path.basename(name)}`);
  }
}

console.log(`Catalog sync complete: ${changed} project file(s) changed.`);
