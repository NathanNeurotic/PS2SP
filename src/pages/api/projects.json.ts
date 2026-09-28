import type { APIRoute } from "astro";
import { getProjects } from "../../lib/catalog";

export const prerender = true;

export const GET: APIRoute = async () => {
  const projects = await getProjects();
  return new Response(JSON.stringify(projects.map(({ id, data }) => ({ id, ...data })), null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
};
