import type { APIRoute } from "astro";
import { getProjects } from "../../lib/catalog";

export const prerender = true;

export const GET: APIRoute = async () => {
  const projects = await getProjects();
  const releases = projects
    .filter((project) => project.data.latestRelease.tag)
    .map((project) => ({
      project: project.data.name,
      slug: project.data.slug,
      ...project.data.latestRelease
    }))
    .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime());

  return new Response(JSON.stringify(releases, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
};
