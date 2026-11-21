import assert from "node:assert/strict";
import test from "node:test";
import {
  isToolCallLeak,
  parseAgentReply,
  parseDsmlActions,
  parseMultipleJsonActions,
  stripToolCallMarkup,
} from "./ai/service";

const DSML = `<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="read_file"> <｜｜DSML｜｜ parameter name="args" string="false">{"path": "src/services/order.service.ts", "startLine": 1, "endLine": 120}</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> <｜｜DSML｜｜ invoke name="read_file"> <｜｜DSML｜｜ parameter name="args" string="false">{"path": "src/controllers/order.controller.ts", "startLine": 1, "endLine": 120}</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>`;

test("DSML native tool calls are parsed instead of leaking into the answer", () => {
  const actions = parseDsmlActions(DSML);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].action, "read_file");
  assert.deepEqual(actions[0].args, {
    path: "src/services/order.service.ts",
    startLine: 1,
    endLine: 120,
  });
  assert.equal(actions[1].args.path, "src/controllers/order.controller.ts");

  const parsed = parseAgentReply(DSML);
  assert.equal(parsed.action, "read_file");
  assert.equal(parsed.__actionCount, 2);
  assert.equal((parsed.args as Record<string, unknown>).path, "src/services/order.service.ts");
  assert.equal(Array.isArray(parsed.__actions), true);
  assert.equal((parsed.__actions as { args: { path: string } }[])[1].args.path, "src/controllers/order.controller.ts");

  assert.equal(isToolCallLeak(DSML), true);
  assert.equal(isToolCallLeak("The order service validates items and charges payment."), false);
  assert.equal(stripToolCallMarkup(DSML), "");
  assert.equal(
    stripToolCallMarkup(`Here is the answer.\n\n${DSML}\n\nUse the service.`),
    "Here is the answer.\n\n\n\nUse the service.",
  );
});

test("normal JSON and tool_call dialects still parse", () => {
  const json = parseAgentReply('{"action":"read_file","args":{"path":"src/index.ts"}}');
  assert.equal(json.action, "read_file");
  assert.equal((json.args as Record<string, unknown>).path, "src/index.ts");

  const toolCall = parseAgentReply(`
    <tool_call>
      <tool_name>count_matches</tool_name>
      <arg_key>path</arg_key><arg_value>src</arg_value>
      <arg_key>query</arg_key><arg_value>TODO</arg_value>
    </tool_call>
  `);
  assert.equal(toolCall.action, "count_matches");
  assert.deepEqual(toolCall.args, { path: "src", query: "TODO" });
});


test("prose and fenced multiple JSON actions are parsed and queued", () => {
  const text = `I'll start by reading the key files I need to edit.
\`\`\`json
{"action":"read_file","args":{"path":"src/services/user.service.ts","startLine":1,"endLine":120}}
{"action":"read_file","args":{"path":"src/routes/order.routes.ts","startLine":1,"endLine":120}}
{"action":"read_file","args":{"path":"src/controllers/user.controller.ts","startLine":1,"endLine":120}}
\`\`\``;
  const actions = parseMultipleJsonActions(text);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((action) => action.args.path), [
    "src/services/user.service.ts",
    "src/routes/order.routes.ts",
    "src/controllers/user.controller.ts",
  ]);
  const parsed = parseAgentReply(text);
  assert.equal(parsed.action, "read_file");
  assert.equal(parsed.__actionCount, 3);
  assert.equal(Array.isArray(parsed.__actions), true);
  assert.equal((parsed.__actions as { args: { path: string } }[])[2].args.path, "src/controllers/user.controller.ts");
});

test("actions arrays and stringified args are normalized", () => {
  const array = '{"actions":[{"action":"read_file","args":{"path":"src/a.ts"}},{"action":"finish","args":{"summary":"done"}}]}';
  const parsedArray = parseAgentReply(array);
  assert.equal(parsedArray.__actionCount, 2);
  assert.equal((parsedArray.__actions as { action: string }[])[1].action, "finish");

  const stringArgs = parseAgentReply('{"action":"read_file","args":"{\\"path\\":\\"src/b.ts\\"}"}');
  assert.deepEqual(stringArgs.args, { path: "src/b.ts" });
});
