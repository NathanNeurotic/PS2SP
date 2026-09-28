import type { APIRoute } from "astro";
import categories from "../../../config/categories.json";
import { getProjects } from "../../lib/catalog";

export const prerender = true;

export const GET: APIRoute = async () => {
  const projects = await getProjects();
  const result = categories.map((category) => ({
    ...category,
    count: projects.filter((project) => project.data.categories.includes(category.id)).length
  }));
  return new Response(JSON.stringify(result, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
};
