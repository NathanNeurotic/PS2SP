# PS2SP — PlayStation 2 Software Plaza

PS2SP is a community-oriented, Markdown-driven index of PlayStation 2 homebrew software.

The goals are simple:

- keep project pages in plain Markdown;
- keep repository/release metadata synchronized automatically;
- discover new PS2 homebrew with conservative confidence scoring;
- deploy as a static Astro site on Cloudflare Pages;
- keep Git as the durable source of truth;
- require no application database or always-on backend.

## Architecture

```text
GitHub / GitLab / Codeberg / legacy sources
                |
                v
      automated catalog jobs
                |
                v
       content/projects/*.md
                |
                v
              Astro
                |
                v
      static site + JSON API
                |
                v
        Cloudflare Pages
```

The public catalog is generated entirely from `content/projects/*.md`. Automation may refresh machine-owned fields in those files, but the catalog remains readable, portable, reviewable, and recoverable from Git alone.

## Local development

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

The generated site is written to `dist/`.

## Cloudflare Pages

Create a Pages project connected to this repository and use:

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`

Every catalog commit then causes a new deployment automatically.

## Catalog automation

The scheduled workflow in `.github/workflows/catalog-sync.yml` runs every six hours.

It:

1. synchronizes known GitHub projects;
2. checks releases, repository state, stars, forks, and recent activity;
3. searches for possible new PS2 homebrew;
4. auto-publishes only candidates with very strong PS2-specific evidence;
5. stores lower-confidence candidates in `discovery/pending/`;
6. commits changed Markdown back to the repository.

No personal access token is required for the default workflow. It uses the repository's scoped `GITHUB_TOKEN`.

Run the same jobs locally with a GitHub token:

```bash
GITHUB_TOKEN=... npm run catalog:sync
GITHUB_TOKEN=... npm run catalog:discover
```

## Add a project manually

Copy `content/projects/_template.md.example` to a new `.md` file and fill in its frontmatter.

Human-maintained fields include the title, summary, categories, tags, features, and body copy. Machine-maintained fields live under `repository`, `latestRelease`, and `activity`.

## Static API

The build exposes:

- `/api/projects.json`
- `/api/categories.json`
- `/api/releases.json`

This makes PS2SP usable by other websites, launchers, dashboards, and future PS2-native clients without needing an API server.

## License

Site source and catalog metadata can be licensed separately from third-party project software. PS2SP does not redistribute third-party binaries by default; release buttons point to the upstream project's own release infrastructure.
