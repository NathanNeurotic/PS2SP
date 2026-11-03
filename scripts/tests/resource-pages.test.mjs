import test from "node:test";
import assert from "node:assert/strict";
import { splitResourceGroups, loadResourceGroups } from "../../src/lib/resource-pages.mjs";

test("Unicode catalogs split within byte limits and reconstruct without loss", async () => {
  const groups = [{ category: "Empty", description: "preserved", links: [] },
    ...Array.from({ length: 4 }, (_, category) => ({ category: `Group ${category}`, description: "PS2 resources",
      links: Array.from({ length: 100 }, (_, i) => ({ name: `日本語 🎮 ${i}`, url: `https://example.com/${category}/${i}` })) }))];
  const original = JSON.stringify(groups);
  const pages = splitResourceGroups(groups, 1024);
  assert.ok(pages.length > 4);
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024);
  let calls = 0;
  const reconstructed = await loadResourceGroups(async (url) => {
    assert.equal(url, calls ? `/api/resources/${calls}.json` : "/api/resources.json");
    return Response.json(pages[calls++]);
  });
  assert.deepEqual(reconstructed.groups, groups);
  assert.equal(calls, pages.length);
  assert.equal(JSON.stringify(groups), original);
});
test("empty and legacy catalogs remain readable", async () => {
  assert.deepEqual(splitResourceGroups([]), [{ groups: [] }]);
  assert.deepEqual(await loadResourceGroups(async () => Response.json({ groups: [] })), { groups: [] });
});

test("mirror pagination stays under the configured base and rejects external next URLs", async () => {
  const urls = [];
  const result = await loadResourceGroups(async (url) => {
    urls.push(url);
    return Response.json(url.endsWith("resources.json")
      ? { groups: [{ category: "PS2", links: [{ name: "one" }] }], next: "/api/resources/1.json" }
      : { groups: [{ category: "PS2", links: [{ name: "two" }] }] });
  }, "/PS2SP/");
  assert.deepEqual(urls, ["/PS2SP/api/resources.json", "/PS2SP/api/resources/1.json"]);
  assert.equal(result.groups[0].links.length, 2);
  await assert.rejects(loadResourceGroups(async () => Response.json({ groups: [], next: "//other.example/api/resources/1.json" }), "/PS2SP"), /pagination URL/);
});
test("oversized individual resources fail explicitly", () => {
  assert.throws(() => splitResourceGroups([{ category: "Huge", links: [{ name: "x".repeat(2048) }] }], 1024), /exceeds page size/);
});
test("failed pages and invalid pagination never return partial results", async () => {
  for (const next of ["https://untrusted.example/", "/api/resources/1.json"]) {
    await assert.rejects(loadResourceGroups(async () => Response.json({ groups: [], next })), /pagination/);
  }
  await assert.rejects(loadResourceGroups(async (url) => url.endsWith("resources.json")
    ? Response.json({ groups: [], next: "/api/resources/1.json" })
    : new Response(null, { status: 503 })), /503/);
});
