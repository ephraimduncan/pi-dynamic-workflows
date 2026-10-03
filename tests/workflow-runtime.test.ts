import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /did you forget to await agent\(\), parallel\(\), or pipeline\(\)\? result\.scan is a Promise/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow passes opts.model to the subagent runner", async () => {
  const calls: Array<{ model?: string; instructions?: string }> = [];
  const models: string[] = [];

  await runWorkflow(
    `export const meta = { name: 'model_pin', description: 'Pin a model' }
await agent('scan', { label: 'scan', model: 'haiku' })
`,
    {
      agent: {
        async run(_prompt: string, options: { model?: string; instructions?: string; onModel?: (m: string) => void }) {
          calls.push({ model: options.model, instructions: options.instructions });
          options.onModel?.("anthropic/claude-haiku-4-5");
          return "ok";
        },
      },
      onAgentModel: ({ model }) => models.push(model),
    },
  );

  assert.deepEqual(calls, [{ model: "haiku", instructions: undefined }]);
  assert.deepEqual(models, ["anthropic/claude-haiku-4-5"]);
});

test("runWorkflow stops queued agents when the token budget is spent", async () => {
  const prompts: string[] = [];

  const result = await runWorkflow(
    `export const meta = { name: 'budget', description: 'Spend the budget' }
return await parallel(['a', 'b', 'c'].map((name) => () => agent(name, { label: name })))
`,
    {
      concurrency: 1,
      tokenBudget: 100,
      agent: {
        async run(prompt: string, options: { onStats?: (stats: { tokens: { total: number } }) => void }) {
          prompts.push(prompt);
          options.onStats?.({ tokens: { total: 60 } });
          return prompt;
        },
      },
    },
  );

  assert.deepEqual(prompts, ["a", "b"]);
  assert.deepEqual(result.result, ["a", "b", null]);
  assert.ok(result.logs.some((line) => line.includes("token budget exhausted")));
});

test("runWorkflow stops a script that starts more agents than maxAgents", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'loop', description: 'Loop without end' }
for (let i = 0; i < 3; i++) await agent('scan ' + i)
`,
        { agent: fakeAgent, maxAgents: 2 },
      ),
    /agent limit reached: at most 2 agents/,
  );
});

test("runWorkflow reports script errors with the line of the script", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_line',
  description: 'Fail on line 6'
}
const value = null
value.missing
`,
        { agent: fakeAgent },
      ),
    /cannot read property 'missing' of null\n\s+at .*:6:/,
  );
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});

test("runWorkflow blocks aliased Math.random at runtime", async () => {
  for (const expression of ["const f = Math.random; f()", "const r = Math['ra' + 'ndom']; r()"]) {
    await assert.rejects(
      () =>
        runWorkflow(`export const meta = { name: 'math_alias', description: 'Alias Math.random' }\n${expression}`, {
          agent: fakeAgent,
        }),
      /must be deterministic/,
      expression,
    );
  }
});

test("runWorkflow blocks aliased Date at runtime", async () => {
  for (const expression of ["const D = Date; D.now()", "const D = Date; new D()"]) {
    await assert.rejects(
      () =>
        runWorkflow(`export const meta = { name: 'date_alias', description: 'Alias Date' }\n${expression}`, {
          agent: fakeAgent,
        }),
      /must be deterministic|not a constructor/,
      expression,
    );
  }
});

test("runWorkflow keeps deterministic Math methods working", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'math_ok', description: 'Use deterministic Math' }
return Math.max(1, 2) + Math.floor(1.5)
`,
    { agent: fakeAgent },
  );

  assert.equal(result.result, 3);
});

test("runWorkflow supports deterministic Date.parse and Date.UTC", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'date_ok', description: 'Use deterministic Date statics' }
return { parsed: Date.parse('2020-01-01T00:00:00Z'), utc: Date.UTC(2020, 0, 1) }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.result, { parsed: 1577836800000, utc: 1577836800000 });
});

// Resolves when the signal aborts, then rejects like WorkflowAgent does.
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error("Subagent was aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

// A regression leaves the agent running, thus the timeout turns a hang into a failure.
test("runWorkflow aborts the agents that a throwing script did not await", { timeout: 5000 }, async () => {
  const signals: AbortSignal[] = [];
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'throwing_script', description: 'Start an agent then throw' }
agent('scan', { label: 'scan' })
throw new Error('boom')
`,
        {
          agent: {
            run(_prompt: string, options: { signal: AbortSignal }) {
              signals.push(options.signal);
              return untilAborted(options.signal);
            },
          },
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /boom/,
  );

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(ended, 1);
});

// A regression leaves the agent running, thus the timeout turns a hang into a failure.
test("runWorkflow stops the script and its agents when the caller aborts", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'abort', description: 'Abort a running agent' }
await agent('scan', { label: 'scan' })
`,
        {
          signal: controller.signal,
          agent: {
            run(_prompt: string, options: { signal: AbortSignal }) {
              signals.push(options.signal);
              controller.abort();
              return untilAborted(options.signal);
            },
          },
        },
      ),
    /workflow aborted/,
  );

  assert.equal(signals[0].aborted, true);
});

test("runWorkflow lets the script call scriptTools as tools.<name>()", async () => {
  const calls: unknown[] = [];

  const result = await runWorkflow(
    `export const meta = { name: 'tools', description: 'Call a tool' }
const files = await tools.list_files({ dir: 'src' })
await agent('summarize ' + files.join(','), { label: 'summary' })
return files
`,
    {
      agent: fakeAgent,
      scriptTools: [
        {
          name: "list_files",
          execute(args) {
            calls.push(args);
            return ["a.ts", "b.ts"];
          },
        },
      ],
    },
  );

  assert.deepEqual(calls, [{ dir: "src" }]);
  assert.deepEqual(result.result, ["a.ts", "b.ts"]);
});

test("runWorkflow parallel preserves input order and maps failures to null", async () => {
  // Gate, not a timer: "slow" is released exactly when "fast" starts, so
  // completion order differs from input order deterministically.
  const gate = Promise.withResolvers<void>();
  const result = await runWorkflow(
    `export const meta = { name: 'parallel_demo', description: 'Check parallel ordering' }
const results = await parallel([
  () => agent('slow', { label: 'slow' }),
  () => agent('fail', { label: 'fail' }),
  () => agent('fast', { label: 'fast' }),
])
return { results }
`,
    {
      concurrency: 3,
      agent: {
        async run(prompt: string): Promise<string> {
          if (prompt === "fail") throw new Error("subagent exploded");
          if (prompt === "slow") await gate.promise;
          if (prompt === "fast") gate.resolve();
          return `result:${prompt}`;
        },
      },
    },
  );

  assert.deepEqual((result.result as { results: unknown[] }).results, ["result:slow", null, "result:fast"]);
  assert.ok(result.logs.some((line) => line.includes("agent fail failed: subagent exploded")));
});

test("runWorkflow pipeline passes (previous, original, index) and maps failures to null", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'pipeline_demo', description: 'Check pipeline semantics' }
const seen = []
const results = await pipeline(
  ['a', 'b', 'c'],
  (item, original, index) => {
    seen.push([item, original, index])
    return item + '1'
  },
  (prev, original, index) => agent(prev + '|' + original + '|' + index, { label: 'stage2 ' + original }),
)
return { results, seen }
`,
    {
      agent: {
        async run(prompt: string): Promise<string> {
          if (prompt.startsWith("b1|")) throw new Error("stage exploded");
          return `result:${prompt}`;
        },
      },
    },
  );

  assert.deepEqual(result.result, {
    results: ["result:a1|a|0", null, "result:c1|c|2"],
    seen: [
      ["a", "a", 0],
      ["b", "b", 1],
      ["c", "c", 2],
    ],
  });
  // stage 2 delegates to agent(), which catches its own failure and yields
  // the null the pipeline item resolves to
  assert.ok(result.logs.some((line) => line.includes("agent stage2 b failed: stage exploded")));
});
