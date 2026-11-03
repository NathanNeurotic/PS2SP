import fs from "node:fs/promises";
import { loadResourceGroups } from "../src/lib/resource-pages.mjs";

const base = (process.env.BASE_PATH || "/PS2SP").replace(/\/$/, "");
let pages = 0;
const { groups } = await loadResourceGroups(async (url) => {
  if (!url.startsWith(`${base}/api/`)) throw new Error(`API escaped mirror base: ${url}`);
  const body = await fs.readFile(`dist${url.slice(base.length)}`, "utf8");
  pages++;
  return new Response(body);
}, base);
await fs.access("dist/.nojekyll");
console.log(`Mirror API audit passed: ${pages} page(s), ${groups.reduce((n, g) => n + g.links.length, 0)} links under ${base}.`);
