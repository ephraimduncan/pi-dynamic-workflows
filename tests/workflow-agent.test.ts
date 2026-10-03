import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, type SessionStats } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";

// An empty agent dir keeps the user's auth, models, and extensions out of the test.
async function createModelRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "workflow-agent-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  return { dir, modelRuntime };
}

async function createAgent(authenticatedProviders: string[]) {
  const { dir, modelRuntime } = await createModelRuntime();
  for (const provider of authenticatedProviders) await modelRuntime.setRuntimeApiKey(provider, "test-key");
  return new WorkflowAgent({ cwd: dir, session: { agentDir: dir, modelRuntime } });
}

// The faux provider answers each model request with the next scripted message.
async function createFauxAgent(responses: FauxResponseStep[]) {
  const { dir, modelRuntime } = await createModelRuntime();
  const faux = fauxProvider();
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const agent = new WorkflowAgent({ cwd: dir, session: { agentDir: dir, modelRuntime, model: faux.getModel() } });
  return { agent, faux };
}

const okSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as any;

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

test("WorkflowAgent prompts again when a structured subagent ends without structured_output", async () => {
  const { agent, faux } = await createFauxAgent([
    fauxAssistantMessage("All done, everything is ok."),
    fauxAssistantMessage(fauxToolCall("structured_output", { ok: true })),
  ]);
  let stats: SessionStats | undefined;

  const result = await agent.run("check", { schema: okSchema, onStats: (value) => (stats = value) });

  assert.deepEqual(result, { ok: true });
  assert.equal(faux.state.callCount, 2);
  assert.ok((stats?.tokens.total ?? 0) > 0);
});

test("WorkflowAgent stops after three prompts without structured_output", async () => {
  const { agent, faux } = await createFauxAgent([
    fauxAssistantMessage("one"),
    fauxAssistantMessage("two"),
    fauxAssistantMessage("three"),
    fauxAssistantMessage(fauxToolCall("structured_output", { ok: true })),
  ]);

  await assert.rejects(() => agent.run("check", { schema: okSchema }), /without calling structured_output/);
  assert.equal(faux.state.callCount, 3);
});
