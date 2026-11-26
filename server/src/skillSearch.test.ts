import assert from "node:assert/strict";
import test from "node:test";
import { clearSkillSearchCache, searchSkillCatalog } from "./skillSearch";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("searches the catalog, sanitizes results and respects the limit", async () => {
  clearSkillSearchCache();
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return jsonResponse({
      skills: [
        {
          id: "vercel-labs/agent-skills/web-design-guidelines",
          source: "vercel-labs/agent-skills",
          skillId: "web-design-guidelines",
          name: "web-design-guidelines",
          installs: 907224,
        },
        {
          id: "uizze.sh/ios-design",
          source: "uizze.sh",
          skillId: "ios-design",
          name: "ios-design",
          installs: 420685,
        },
        { id: "", source: "", skillId: "", name: "" },
      ],
    });
  }) as unknown as typeof fetch;

  const result = await searchSkillCatalog("ui design", { fetchImpl, limit: 2 });
  assert.equal(result.query, "ui design");
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[0]?.name, "web-design-guidelines");
  assert.equal(result.skills[0]?.installs, 907224);
  assert.match(result.skills[0]?.url ?? "", /^https:\/\/skills\.sh\//);
  assert.match(calls[0] ?? "", /q=ui\+design/);
});

test("caches repeated catalog searches", async () => {
  clearSkillSearchCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({
      skills: [
        {
          id: "vercel-labs/skills/find-skills",
          source: "vercel-labs/skills",
          skillId: "find-skills",
          name: "find-skills",
          installs: 4_500_000,
        },
      ],
    });
  }) as unknown as typeof fetch;

  const first = await searchSkillCatalog("find skills", { fetchImpl, now: 1_000 });
  const second = await searchSkillCatalog("find skills", { fetchImpl, now: 2_000 });
  assert.equal(calls, 1);
  assert.deepEqual(first.skills, second.skills);
});

test("rejects a too-short query before calling the network", async () => {
  clearSkillSearchCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({ skills: [] });
  }) as unknown as typeof fetch;
  await assert.rejects(() => searchSkillCatalog("u", { fetchImpl }), /at least 2/i);
  assert.equal(calls, 0);
});
