import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";

// An empty agent dir keeps the user's auth, models, and extensions out of the test.
async function createAgent(authenticatedProviders: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-agent-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  for (const provider of authenticatedProviders) await modelRuntime.setRuntimeApiKey(provider, "test-key");
  return new WorkflowAgent({ cwd: dir, session: { agentDir: dir, modelRuntime } });
}

// A pre-aborted signal stops the run after the session is created and before any model request.
function abortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

test("WorkflowAgent runs the subagent on the pinned model", async () => {
  const agent = await createAgent(["anthropic"]);
  let model: string | undefined;

  await assert.rejects(
    () => agent.run("hi", { model: "haiku:low", signal: abortedSignal(), onModel: (value) => (model = value) }),
    /aborted/,
  );

  assert.equal(model, "anthropic/claude-haiku-4-5");
});

test("WorkflowAgent rejects a pinned model without configured auth", async () => {
  const agent = await createAgent([]);

  await assert.rejects(
    () => agent.run("hi", { model: "anthropic/claude-haiku-4-5" }),
    /no model with configured auth matches "anthropic\/claude-haiku-4-5"/,
  );
});

test("WorkflowAgent rejects a model pattern that matches more than one model", async () => {
  const agent = await createAgent(["anthropic"]);

  await assert.rejects(() => agent.run("hi", { model: "claude-haiku*" }), /matches more than one model/);
});
