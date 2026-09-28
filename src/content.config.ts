import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const nullableString = z.string().nullable().optional();

const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./content/projects" }),
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    summary: z.string(),
    categories: z.array(z.string()).default(["uncategorized"]),
    tags: z.array(z.string()).default([]),
    features: z.array(z.string()).default([]),
    authors: z.array(z.string()).default([]),
    license: nullableString,
    homepage: nullableString,
    source: z.object({
      provider: z.enum(["github", "gitlab", "codeberg", "sourceforge", "static"]),
      repository: nullableString,
      repositoryId: z.union([z.string(), z.number()]).nullable().optional(),
      url: nullableString
    }),
    repository: z.object({
      archived: z.boolean().default(false),
      defaultBranch: nullableString,
      stars: z.number().default(0),
      forks: z.number().default(0),
      lastCommit: nullableString
    }).default({}),
    latestRelease: z.object({
      tag: nullableString,
      name: nullableString,
      publishedAt: nullableString,
      url: nullableString
    }).default({}),
    activity: z.object({
      lastChecked: nullableString
    }).default({}),
    automation: z.object({
      sync: z.boolean().default(true)
    }).default({ sync: true }),
    discovery: z.object({
      method: z.string().default("curated"),
      confidence: z.number().min(0).max(100).default(100)
    }).default({ method: "curated", confidence: 100 }),
    verified: z.boolean().default(false),
    featured: z.boolean().default(false)
  })
});

const site = defineCollection({
  loader: glob({ pattern: "site.md", base: "./content" }),
  schema: z.object({
    title: z.string(),
    longTitle: z.string(),
    tagline: z.string(),
    description: z.string(),
    repository: z.string().url()
  })
});

export const collections = { projects, site };
