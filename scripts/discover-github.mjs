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

const discoveryActivityDays = Number.parseInt(process.env.DISCOVERY_ACTIVITY_DAYS ?? "180", 10);
const activityCutoff = Date.now() - discoveryActivityDays * 24 * 60 * 60 * 1000;
const maxForkPagesPerProject = Number.parseInt(process.env.MAX_FORK_PAGES_PER_PROJECT ?? "10", 10);
const maxOwnerExpansions = Number.parseInt(process.env.MAX_OWNER_EXPANSIONS ?? "8", 10);
const maxOwnerRepos = Number.parseInt(process.env.MAX_OWNER_REPOS ?? "100", 10);

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
  "\"PlayStation 2\" homebrew in:readme",
  "ps2 in:name,description",
  "\"PlayStation 2\" in:name,description",
  "\"ps2 port\" in:name,description,readme"
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
const processed = new Set();
const ownerSeeds = new Map();

for (const query of queries) {
  const result = await github(
    `/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=50`
  );

  for (const repo of result?.items ?? []) candidates.set(String(repo.id), repo);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function hasPs2Token(text) {
  return /(^|[^a-z0-9])ps2([^a-z0-9]|$)/i.test(text ?? "") || /playstation\s*2/i.test(text ?? "");
}

function isRecent(dateValue) {
  const time = Date.parse(dateValue ?? "");
  return Number.isFinite(time) && time >= activityCutoff;
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

function latestStableRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases.find(
    (release) => !release.draft && !release.prerelease && release.published_at
  ) ?? null;
}

function hasHardUnreadySignal(text) {
  return /\b(abandoned|deprecated|unmaintained|not\s+working|doesn['’]?t\s+work|does\s+not\s+work|currently\s+broken|unusable)\b/i.test(
    text ?? ""
  );
}

function hasSoftWipSignal(text) {
  return /\b(work\s+in\s+progress|wip|unfinished|incomplete|prototype|proof\s+of\s+concept|experimental|early\s+development|pre[- ]alpha)\b/i.test(
    text ?? ""
  );
}

function evaluateMaturity(repo, readmeText, releases) {
  const description = repo?.description ?? "";
  const readmeLead = (readmeText ?? "").slice(0, 5000);
  const hardUnready =
    hasHardUnreadySignal(description) || hasHardUnreadySignal(readmeLead);
  const softWip =
    hasSoftWipSignal(description) || hasSoftWipSignal(readmeLead);
  const stableRelease = latestStableRelease(releases);
  const publishedRelease = latestPublishedRelease(releases);
  const recent = isRecent(repo?.pushed_at);

  if (hardUnready) {
    return {
      state: "rejected",
      publishEligible: false,
      queueEligible: false,
      stableRelease,
      publishedRelease,
      reasons: ["repository explicitly describes itself as abandoned, broken, deprecated, or unusable"]
    };
  }

  if (stableRelease && !softWip) {
    return {
      state: recent ? "released-active" : "released-legacy",
      publishEligible: true,
      queueEligible: true,
      stableRelease,
      publishedRelease,
      reasons: [
        "published non-prerelease GitHub release present",
        recent ? "repository has recent activity" : "released software retained even without recent activity"
      ]
    };
  }

  if (stableRelease && softWip) {
    return {
      state: "released-wip",
      publishEligible: false,
      queueEligible: true,
      stableRelease,
      publishedRelease,
      reasons: ["stable release exists, but repository text still identifies the project as unfinished or experimental"]
    };
  }

  if (publishedRelease && recent) {
    return {
      state: "prerelease-only",
      publishEligible: false,
      queueEligible: true,
      stableRelease: null,
      publishedRelease,
      reasons: ["only prerelease/non-stable releases found", "repository has recent activity"]
    };
  }

  if (recent) {
    return {
      state: softWip ? "active-wip" : "active-unreleased",
      publishEligible: false,
      queueEligible: true,
      stableRelease: null,
      publishedRelease,
      reasons: [
        softWip ? "repository identifies itself as unfinished or experimental" : "no stable release found",
        "repository has recent activity"
      ]
    };
  }

  return {
    state: "stale-unreleased",
    publishEligible: false,
    queueEligible: false,
    stableRelease: null,
    publishedRelease,
    reasons: ["no stable release and no activity inside the configured activity window"]
  };
}

function releaseHasPs2Signal(release) {
  if (!release) return false;

  if (hasPs2Token(release.name) || hasPs2Token(release.tag_name)) return true;
  return (release.assets ?? []).some((asset) => hasPs2Token(asset.name));
}

function releaseHasElf(release) {
  return Boolean(release?.assets?.some((asset) => /\.elf$/i.test(asset.name)));
}

function branchHasPs2Signal(branches) {
  return (branches ?? []).some((branch) => hasPs2Token(branch?.name));
}

function explicitRepositorySignal(repo) {
  const topics = repo?.topics ?? [];
  return (
    hasPs2Token(repo?.name) ||
    hasPs2Token(repo?.description) ||
    topics.includes("ps2-homebrew") ||
    topics.includes("playstation-2") ||
    topics.includes("ps2")
  );
}

async function fileExists(url) {
  try {
    await fs.access(url);
    return true;
  } catch {
    return false;
  }
}

async function verifyMaintainedFork(repo, release) {
  if (!repo?.fork || !repo.parent?.full_name) return null;
  if (repo.archived || repo.disabled || !isRecent(repo.pushed_at) || !release) return null;

  const parentBranch = repo.parent.default_branch || "master";
  const forkBranch = repo.default_branch;
  if (!forkBranch || !repo.owner?.login) return null;

  const compare = await github(
    `/repos/${repo.parent.full_name}/compare/${encodeURIComponent(parentBranch)}...${encodeURIComponent(
      `${repo.owner.login}:${forkBranch}`
    )}`
  );

  if (!compare || (compare.ahead_by ?? 0) < 1) return null;

  const aheadCommitDate = latestAheadCommitDate(compare);
  if (!aheadCommitDate || !isRecent(aheadCommitDate)) return null;

  return {
    parent: repo.parent.full_name,
    aheadBy: compare.ahead_by,
    aheadCommitDate
  };
}

function scoreRepository({ repo, readmeText, release, rootNames, branches, forkStatus }) {
  const topics = repo.topics ?? [];
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

  if (hasPs2Token(repo.name)) {
    score += 55;
    evidence.push("repository name explicitly identifies PS2");
  }

  if (hasPs2Token(repo.description)) {
    score += 45;
    evidence.push("repository description explicitly identifies PS2");
  }

  if (/playstation\s*2/i.test(readmeText)) {
    score += 25;
    evidence.push("README explicitly mentions PlayStation 2");
  }

  if (hasAny(readmeText, [/ps2sdk/i, /\$PS2DEV/i, /ee-g(cc|\+\+)/i, /gskit/i, /ps2build/i])) {
    score += 25;
    evidence.push("README contains PS2 development/toolchain evidence");
  }

  if (rootNames.some((name) => ["makefile", "cmakelists.txt", "build.sh"].includes(name))) {
    score += 5;
    evidence.push("native build files present");
  }

  if (branchHasPs2Signal(branches)) {
    score += 40;
    evidence.push("repository has a PS2-specific branch");
  }

  if (release) {
    score += 10;
    evidence.push("published GitHub release present");
  }

  if (releaseHasPs2Signal(release)) {
    score += 30;
    evidence.push("release name or asset explicitly identifies PS2");
  }

  if (releaseHasElf(release)) {
    score += 15;
    evidence.push("release contains an ELF");
  }

  if (isRecent(repo.pushed_at)) {
    score += 10;
    evidence.push(`repository pushed within the last ${discoveryActivityDays} days`);
  }

  if (branchHasPs2Signal(branches) && releaseHasPs2Signal(release)) {
    score += 15;
    evidence.push("PS2 branch and PS2 release corroborate each other");
  }

  if (forkStatus) {
    score += 20;
    evidence.push("fork has recent commits ahead of its parent and a published release");
  }

  return { score: Math.min(score, 100), evidence };
}

let published = 0;
let queued = 0;
let forkPublished = 0;

async function processCandidate(candidate, origin = "github-search", prefetched = {}) {
  if (!candidate?.full_name || processed.has(String(candidate.id))) return;
  processed.add(String(candidate.id));

  if (known.has(candidate.full_name.toLowerCase()) || known.has(`id:${candidate.id}`)) return;

  const repo = prefetched.repo ?? (await github(`/repos/${candidate.full_name}`));
  if (!repo || repo.archived || repo.disabled) return;

  const [readme, releases, root, branches] = await Promise.all([
    github(`/repos/${repo.full_name}/readme`),
    prefetched.releases ?? github(`/repos/${repo.full_name}/releases?per_page=10`),
    github(`/repos/${repo.full_name}/contents`),
    prefetched.branches ?? github(`/repos/${repo.full_name}/branches?per_page=100`)
  ]);

  let readmeText = "";
  if (readme?.content) {
    readmeText = Buffer.from(readme.content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  const maturity = evaluateMaturity(repo, readmeText, releases);
  const release = maturity.stableRelease ?? maturity.publishedRelease;
  const rootNames = Array.isArray(root) ? root.map((item) => item.name.toLowerCase()) : [];
  const forkStatus = repo.fork ? await verifyMaintainedFork(repo, maturity.stableRelease) : null;

  // Forks are intentionally stricter: they must be independently maintained and have
  // a published non-prerelease release before they can enter discovery.
  if (repo.fork && !forkStatus) return;

  const { score, evidence } = scoreRepository({
    repo,
    readmeText,
    release,
    rootNames,
    branches: Array.isArray(branches) ? branches : [],
    forkStatus
  });

  if (score < 70 || (!maturity.publishEligible && !maturity.queueEligible)) return;

  if (explicitRepositorySignal(repo) && ownerSeeds.size < maxOwnerExpansions) {
    ownerSeeds.set(repo.owner.login, repo.owner.type ?? "User");
  }

  const slug = repo.fork ? slugify(`${repo.name}-${repo.owner.login}`) : slugify(repo.name);
  const record = {
    repository: repo.full_name,
    repositoryId: String(repo.id),
    url: repo.html_url,
    description: repo.description,
    score,
    evidence,
    origin,
    maturity: {
      state: maturity.state,
      publishEligible: maturity.publishEligible,
      queueEligible: maturity.queueEligible,
      reasons: maturity.reasons
    },
    fork: repo.fork
      ? {
          parent: forkStatus.parent,
          aheadBy: forkStatus.aheadBy,
          latestAheadCommit: forkStatus.aheadCommitDate
        }
      : null,
    discoveredAt: new Date().toISOString()
  };

  if (score >= 95 && maturity.publishEligible) {
    const target = new URL(`${slug}.md`, projectsDir);
    if (await fileExists(target)) return;

    const parentCatalog = repo.fork
      ? knownProjects.find((project) => project.repository.toLowerCase() === forkStatus.parent.toLowerCase())
      : null;

    const method = repo.fork ? "github-maintained-fork-search" : origin;
    const tags = repo.fork
      ? [...new Set([...(parentCatalog?.tags ?? []), "maintained-fork", "auto-discovered"])]
      : ["auto-discovered"];

    const project = {
      name: repo.name,
      slug,
      summary:
        repo.description ||
        (repo.fork
          ? `Actively maintained PS2 fork of ${forkStatus.parent} with its own commits and published releases.`
          : "PlayStation 2 homebrew project discovered by PS2SP."),
      categories: parentCatalog?.categories ?? ["uncategorized"],
      tags,
      features: parentCatalog?.features ?? [],
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
      discovery: { method, confidence: score },
      verified: false,
      featured: false
    };

    const body = repo.fork
      ? `\nAutomatically discovered as an actively maintained PS2 fork of **${forkStatus.parent}**. The fork has commits ahead of its parent, recent fork-specific activity, and at least one published GitHub release.\n`
      : "\nAutomatically discovered by PS2SP from strong PlayStation 2-specific repository signals. This entry can be expanded and curated without affecting automated repository metadata.\n";

    await fs.writeFile(target, matter.stringify(body, project), "utf8");
    known.add(repo.full_name.toLowerCase());
    known.add(`id:${repo.id}`);

    if (repo.fork) {
      forkPublished++;
      console.log(`auto-published maintained fork ${repo.full_name} (${score})`);
    } else {
      published++;
      console.log(`auto-published ${repo.full_name} (${score})`);
    }
  } else if (maturity.queueEligible) {
    const target = new URL(`${slug}.json`, pendingDir);
    await fs.writeFile(target, JSON.stringify(record, null, 2) + "\n", "utf8");
    queued++;
    console.log(`queued ${repo.full_name} (${score}; ${maturity.state})`);
  }
}

for (const candidate of candidates.values()) {
  await processCandidate(candidate);
}

// A PS2 port can live on a non-default branch while the default README remains unchanged.
// Once an owner has a strong PS2 repository, inspect that owner's other recently-pushed
// repositories for PS2 branch/release signals. This catches ports without special-casing owners.
for (const [owner, ownerType] of [...ownerSeeds.entries()].slice(0, maxOwnerExpansions)) {
  const endpoint =
    ownerType === "Organization"
      ? `/orgs/${owner}/repos?type=public&sort=pushed&per_page=${maxOwnerRepos}`
      : `/users/${owner}/repos?type=public&sort=pushed&per_page=${maxOwnerRepos}`;

  const repos = await github(endpoint);
  if (!Array.isArray(repos)) continue;

  for (const repo of repos) {
    if (!repo?.full_name || processed.has(String(repo.id))) continue;
    if (known.has(repo.full_name.toLowerCase()) || known.has(`id:${repo.id}`)) continue;
    if (repo.archived || repo.disabled || !isRecent(repo.pushed_at)) continue;

    const [branches, releases] = await Promise.all([
      github(`/repos/${repo.full_name}/branches?per_page=100`),
      github(`/repos/${repo.full_name}/releases?per_page=10`)
    ]);

    const release = latestPublishedRelease(releases);
    const relatedSignal =
      explicitRepositorySignal(repo) ||
      branchHasPs2Signal(Array.isArray(branches) ? branches : []) ||
      releaseHasPs2Signal(release);

    if (!relatedSignal) continue;

    await processCandidate(repo, "github-related-owner", {
      repo,
      branches: Array.isArray(branches) ? branches : [],
      releases: Array.isArray(releases) ? releases : []
    });
  }
}

// Also inspect forks of already-cataloged PS2 projects. These inherit the parent's categories
// and features, but only when they are demonstrably maintained and have a published release.
for (const parent of knownProjects) {
  const forks = await githubForks(parent.repository);

  for (const fork of forks) {
    if (!fork?.fork || fork.archived || fork.disabled) continue;
    if (known.has(fork.full_name.toLowerCase()) || known.has(`id:${fork.id}`)) continue;
    if (!isRecent(fork.pushed_at)) continue;

    const repo = await github(`/repos/${fork.full_name}`);
    if (!repo) continue;

    const releases = await github(`/repos/${fork.full_name}/releases?per_page=10`);
    const release = latestStableRelease(releases);
    const forkStatus = await verifyMaintainedFork(repo, release);
    if (!forkStatus) continue;

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
      `\nAutomatically discovered as an actively maintained fork of **${parent.name}** (${parent.repository}). PS2SP only auto-adds a fork when its default branch has commits ahead of the registered parent, one of those fork-specific commits is newer than ${discoveryActivityDays} days, and the fork has at least one published non-draft GitHub release.\n`;

    await fs.writeFile(target, matter.stringify(body, project), "utf8");
    known.add(repo.full_name.toLowerCase());
    known.add(`id:${repo.id}`);
    forkPublished++;

    console.log(
      `auto-published maintained fork ${repo.full_name} of ${parent.repository} (${forkStatus.aheadBy} commits ahead; release ${release.tag_name ?? release.name ?? "published"})`
    );
  }
}

console.log(
  `Discovery complete: ${published} projects auto-published, ${forkPublished} maintained forks auto-published, ${queued} queued for review.`
);
