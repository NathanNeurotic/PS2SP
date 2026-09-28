import fs from "node:fs/promises";
import matter from "gray-matter";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(1);
}

const projectsDir = new URL("../content/projects/", import.meta.url);
const pendingDir = new URL("../discovery/pending/", import.meta.url);
await fs.mkdir(pendingDir, { recursive: true });

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "PS2SP-discovery"
};

async function github(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

const queries = [
  "topic:ps2-homebrew",
  "topic:playstation-2 homebrew",
  "ps2sdk in:readme",
  "\"PlayStation 2\" homebrew in:readme"
];

const existingFiles = (await fs.readdir(projectsDir)).filter((name) => name.endsWith(".md"));
const known = new Set();

for (const name of existingFiles) {
  const raw = await fs.readFile(new URL(name, projectsDir), "utf8");
  const data = matter(raw).data;
  if (data?.source?.provider === "github" && data.source.repository) {
    known.add(data.source.repository.toLowerCase());
  }
  if (data?.source?.repositoryId) known.add(`id:${data.source.repositoryId}`);
}

const candidates = new Map();

for (const query of queries) {
  const result = await github(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=25`);
  for (const repo of result?.items ?? []) candidates.set(String(repo.id), repo);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

let published = 0;
let queued = 0;

for (const candidate of candidates.values()) {
  if (candidate.fork) continue;
  if (known.has(candidate.full_name.toLowerCase()) || known.has(`id:${candidate.id}`)) continue;

  const [repo, readme, release, root] = await Promise.all([
    github(`/repos/${candidate.full_name}`),
    github(`/repos/${candidate.full_name}/readme`),
    github(`/repos/${candidate.full_name}/releases/latest`),
    github(`/repos/${candidate.full_name}/contents`)
  ]);

  if (!repo) continue;

  let readmeText = "";
  if (readme?.content) {
    readmeText = Buffer.from(readme.content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  const topics = repo.topics ?? [];
  const rootNames = Array.isArray(root) ? root.map((item) => item.name.toLowerCase()) : [];
  let score = 0;
  const evidence = [];

  if (topics.includes("ps2-homebrew")) { score += 45; evidence.push("ps2-homebrew topic"); }
  if (topics.includes("playstation-2") || topics.includes("ps2")) { score += 35; evidence.push("PS2 topic"); }
  if (/playstation\s*2/i.test(readmeText)) { score += 25; evidence.push("README explicitly mentions PlayStation 2"); }
  if (hasAny(readmeText, [/ps2sdk/i, /\$PS2DEV/i, /ee-g(cc|\+\+)/i, /gskit/i])) {
    score += 25; evidence.push("README contains PS2 development/toolchain evidence");
  }
  if (rootNames.some((name) => ["makefile", "cmakelists.txt", "build.sh"].includes(name))) {
    score += 5; evidence.push("native build files present");
  }
  if (release?.assets?.some((asset) => /\.elf$/i.test(asset.name))) {
    score += 15; evidence.push("release contains an ELF");
  }

  score = Math.min(score, 100);
  if (score < 70) continue;

  const slug = slugify(repo.name);
  const record = {
    repository: repo.full_name,
    repositoryId: String(repo.id),
    url: repo.html_url,
    description: repo.description,
    score,
    evidence,
    discoveredAt: new Date().toISOString()
  };

  if (score >= 95) {
    const target = new URL(`${slug}.md`, projectsDir);
    try {
      await fs.access(target);
      continue;
    } catch {}

    const project = {
      name: repo.name,
      slug,
      summary: repo.description || "PlayStation 2 homebrew project discovered by PS2SP.",
      categories: ["uncategorized"],
      tags: ["auto-discovered"],
      features: [],
      authors: [],
      license: repo.license?.spdx_id ?? null,
      homepage: repo.homepage || null,
      source: {
        provider: "github",
        repository: repo.full_name,
        repositoryId: String(repo.id)
      },
      repository: {
        archived: Boolean(repo.archived),
        defaultBranch: repo.default_branch ?? null,
        stars: repo.stargazers_count ?? 0,
        forks: repo.forks_count ?? 0,
        lastCommit: repo.pushed_at ?? null
      },
      latestRelease: release ? {
        tag: release.tag_name ?? null,
        name: release.name ?? null,
        publishedAt: release.published_at ?? null,
        url: release.html_url ?? null
      } : { tag: null, name: null, publishedAt: null, url: null },
      activity: { lastChecked: new Date().toISOString() },
      automation: { sync: true },
      discovery: { method: "github-search", confidence: score },
      verified: false,
      featured: false
    };

    const body = `\nAutomatically discovered by PS2SP from strong PlayStation 2-specific repository signals. This entry can be expanded and curated without affecting automated repository metadata.\n`;
    await fs.writeFile(target, matter.stringify(body, project), "utf8");
    known.add(repo.full_name.toLowerCase());
    published++;
    console.log(`auto-published ${repo.full_name} (${score})`);
  } else {
    const target = new URL(`${slug}.json`, pendingDir);
    await fs.writeFile(target, JSON.stringify(record, null, 2) + "\n", "utf8");
    queued++;
    console.log(`queued ${repo.full_name} (${score})`);
  }
}

console.log(`Discovery complete: ${published} auto-published, ${queued} queued for review.`);
