import assert from "node:assert/strict";
import test from "node:test";
import { chatCapabilityBrief, isCapabilityQuestion } from "./chatCapabilities";

test("capability questions stay local and are not treated as web searches", () => {
  assert.equal(isCapabilityQuestion("neler yapıyorsun?"), true);
  assert.equal(isCapabilityQuestion("what can you do"), true);
  assert.equal(isCapabilityQuestion("bugün en güncel haberler"), false);
  const brief = chatCapabilityBrief();
  assert.match(brief, /Research/);
  assert.match(brief, /Code Studio/);
  assert.doesNotMatch(brief, /Yapamadıklarım/i);
});
