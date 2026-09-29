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

const forkActivityDays = Number.parseInt(process.env.FORK_ACTIVITY_DAYS ?? "180", 10);
const forkActivityCutoff = Date.now() - forkActivityDays * 24 * 60 * 60 * 1000;
const maxForkPagesPerProject = Number.parseInt(process.env.MAX_FORK_PAGES_PER_PROJECT ?? "10", 10);

async function github(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function githubForks(repository) {
  const forks = [];

  for (let page = 1; page <= maxForkPagesPerProject; page++) {
    const batch = await github(
      `/repos/${repository}/forks?sort=newest&per_page=100&page=${page}`
    );

    if (!Array.isArray(batch) || batch.length === 0) break;
    forks.push(...batch);
    if (batch.length < 100) break;
  }

  return forks;
}

const queries = [
  "topic:ps2-homebrew",
  "topic:playstation-2 homebrew",
  "ps2sdk in:readme",
  "\"PlayStation 2\" homebrew in:readme"
];

const existingFiles = (await fs.readdir(projectsDir)).filter((name) => name.endsWith(".md"));
const known = new Set();
const knownProjects = [];

for (const name of existingFiles) {
  const raw = await fs.readFile(new URL(name, projectsDir), "utf8");
  const data = matter(raw).data;

  if (data?.source?.provider === "github" && data.source.repository) {
    known.add(data.source.repository.toLowerCase());
    knownProjects.push({
      file: name,
      repository: data.source.repository,
      repositoryId: data.source.repositoryId ? String(data.source.repositoryId) : null,
      name: data.name,
      categories: Array.isArray(data.categories) ? data.categories : ["uncategorized"],
      tags: Array.isArray(data.tags) ? data.tags : [],
      features: Array.isArray(data.features) ? data.features : [],
      defaultBranch: data?.repository?.defaultBranch ?? null
    });
  }

  if (data?.source?.repositoryId) known.add(`id:${data.source.repositoryId}`);
}

const candidates = new Map();

for (const query of queries) {
  const result = await github(
    `/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=25`
  );

  for (const repo of result?.items ?? []) candidates.set(String(repo.id), repo);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isRecent(dateValue) {
  const time = Date.parse(dateValue ?? "");
  return Number.isFinite(time) && time >= forkActivityCutoff;
}

function latestAheadCommitDate(compare) {
  const dates = (compare?.commits ?? [])
    .map((commit) => commit?.commit?.committer?.date ?? commit?.commit?.author?.date)
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);

  return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
}

function latestPublishedRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases.find((release) => !release.draft && release.published_at) ?? null;
}

async function fileExists(url) {
  try {
    await fs.access(url);
    return true;
  } catch {
    return false;
  }
}

let published = 0;
let queued = 0;
let forkPublished = 0;

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

  if (topics.includes("ps2-homebrew")) {
    score += 45;
    evidence.push("ps2-homebrew topic");
  }

  if (topics.includes("playstation-2") || topics.includes("ps2")) {
    score += 35;
    evidence.push("PS2 topic");
  }

  if (/playstation\s*2/i.test(readmeText)) {
    score += 25;
    evidence.push("README explicitly mentions PlayStation 2");
  }

  if (hasAny(readmeText, [/ps2sdk/i, /\$PS2DEV/i, /ee-g(cc|\+\+)/i, /gskit/i])) {
    score += 25;
    evidence.push("README contains PS2 development/toolchain evidence");
  }

  if (rootNames.some((name) => ["makefile", "cmakelists.txt", "build.sh"].includes(name))) {
    score += 5;
    evidence.push("native build files present");
  }

  if (release?.assets?.some((asset) => /\.elf$/i.test(asset.name))) {
    score += 15;
    evidence.push("release contains an ELF");
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
    if (await fileExists(target)) continue;

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
      latestRelease: release
        ? {
            tag: release.tag_name ?? null,
            name: release.name ?? null,
            publishedAt: release.published_at ?? null,
            url: release.html_url ?? null
          }
        : { tag: null, name: null, publishedAt: null, url: null },
      activity: { lastChecked: new Date().toISOString() },
      automation: { sync: true },
      discovery: { method: "github-search", confidence: score },
      verified: false,
      featured: false
    };

    const body =
      "\nAutomatically discovered by PS2SP from strong PlayStation 2-specific repository signals. This entry can be expanded and curated without affecting automated repository metadata.\n";

    await fs.writeFile(target, matter.stringify(body, project), "utf8");
    known.add(repo.full_name.toLowerCase());
    known.add(`id:${repo.id}`);
    published++;
    console.log(`auto-published ${repo.full_name} (${score})`);
  } else {
    const target = new URL(`${slug}.json`, pendingDir);
    await fs.writeFile(target, JSON.stringify(record, null, 2) + "\n", "utf8");
    queued++;
    console.log(`queued ${repo.full_name} (${score})`);
  }
}

for (const parent of knownProjects) {
  const forks = await githubForks(parent.repository);

  for (const fork of forks) {
    if (!fork?.fork || fork.archived || fork.disabled) continue;
    if (known.has(fork.full_name.toLowerCase()) || known.has(`id:${fork.id}`)) continue;
    if (!isRecent(fork.pushed_at)) continue;

    const parentBranch = parent.defaultBranch || "master";
    const forkBranch = fork.default_branch;
    if (!forkBranch || !fork.owner?.login) continue;

    const compare = await github(
      `/repos/${parent.repository}/compare/${encodeURIComponent(parentBranch)}...${encodeURIComponent(
        `${fork.owner.login}:${forkBranch}`
      )}`
    );

    if (!compare || (compare.ahead_by ?? 0) < 1) continue;

    const aheadCommitDate = latestAheadCommitDate(compare);
    if (!aheadCommitDate || !isRecent(aheadCommitDate)) continue;

    const releases = await github(`/repos/${fork.full_name}/releases?per_page=10`);
    const release = latestPublishedRelease(releases);
    if (!release) continue;

    const repo = await github(`/repos/${fork.full_name}`);
    if (!repo || repo.archived || repo.disabled) continue;

    const slug = slugify(`${repo.name}-${repo.owner.login}`);
    const target = new URL(`${slug}.md`, projectsDir);
    if (await fileExists(target)) continue;

    const project = {
      name: repo.name,
      slug,
      summary:
        repo.description ||
        `Actively maintained fork of ${parent.name} with its own commits and published releases.`,
      categories: parent.categories,
      tags: [...new Set([...parent.tags, "maintained-fork", "auto-discovered"])],
      features: parent.features,
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
      latestRelease: {
        tag: release.tag_name ?? null,
        name: release.name ?? null,
        publishedAt: release.published_at ?? null,
        url: release.html_url ?? null
      },
      activity: { lastChecked: new Date().toISOString() },
      automation: { sync: true },
      discovery: { method: "github-maintained-fork", confidence: 100 },
      verified: false,
      featured: false
    };

    const body =
      `\nAutomatically discovered as an actively maintained fork of **${parent.name}** (${parent.repository}). PS2SP only auto-adds a fork when its default branch has commits ahead of the registered parent, one of those fork-specific commits is newer than ${forkActivityDays} days, and the fork has at least one published non-draft GitHub release.\n`;

    await fs.writeFile(target, matter.stringify(body, project), "utf8");
    known.add(repo.full_name.toLowerCase());
    known.add(`id:${repo.id}`);
    forkPublished++;

    console.log(
      `auto-published maintained fork ${repo.full_name} of ${parent.repository} (${compare.ahead_by} commits ahead; release ${release.tag_name ?? release.name ?? "published"})`
    );
  }
}

console.log(
  `Discovery complete: ${published} projects auto-published, ${forkPublished} maintained forks auto-published, ${queued} queued for review.`
);
