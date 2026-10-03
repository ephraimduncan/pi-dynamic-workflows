# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
pi install npm:pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory [anthropic/claude-haiku-4-5]
  ✓ Analyze 2/2
    #2 ✓ source modules [anthropic/claude-haiku-4-5]
    #3 ✓ final summary [anthropic/claude-opus-4-5]
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `budget`, `tools`, and `ALL_TOOLS` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. Resolves to `null` if the subagent fails — null-check before synthesizing. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order, with `null` in place of failed thunks. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. An item whose stage fails resolves to `null`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `tools.<name>(args)` | Call a session tool, as in pi's [codemode](https://pi.dev/docs/latest/codemode) tool: `await tools.bash({ command: 'ls' })`. The call goes through the same hooks and permission checks as a call from the model. `ALL_TOOLS` lists each tool with its declaration. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. `spent()` counts the tokens that finished subagent sessions used. `total` comes from the `tokenBudget` tool argument. When the budget is spent, new `agent()` calls fail. |
| `Date` | Deterministic subset only: `Date.parse()` and `Date.UTC()`. |

### Determinism rules

Workflow scripts run in the sandbox of pi's codemode tool (`@earendil-works/pi-codemode`): a QuickJS VM in a worker thread. The script can reach the outside world only through `agent()`, `tools`, and the other workflow globals. The following are intentionally unavailable:

- `Date.now()`, `new Date()` — the sandbox `Date` exposes only the deterministic statics `Date.parse()` and `Date.UTC()`; `now()` throws and the shim is not a constructor
- `Math.random()` — the sandbox `Math` inherits every other method but `random()` throws, even when aliased (`const f = Math.random; f()`)
- `require`, `import`, `fs`, `fetch`, timers
- spreads, computed keys, template interpolation, function calls inside `meta`

The parser rejects the direct forms up front; the runtime shims close aliasing bypasses. This keeps `meta` parseable, runs reproducible, and the surface area small.

### Limits

If the script ends before it awaits an `agent()` call, the runtime aborts that agent, as codemode cancels the tool calls of a finished script.

A workflow run can make at most 200 `agent()` calls. This limit stops a script that loops without end. To change it, use the `maxAgents` option of `createWorkflowTool()`.

To limit tokens, give the `tokenBudget` argument to the `workflow` tool. Each subagent adds the tokens of its session to `budget.spent()`. When the budget is spent, agents in the queue do not start and new `agent()` calls fail.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn. If the subagent ends without a `structured_output` call, the runtime prompts it two more times. If it still does not call the tool, the agent resolves to `null`.

### Per-agent model selection

Use `opts.model` to run a subagent on a different model. The pattern resolves like the pi `--models` flag. It accepts a fuzzy name, a `provider/id`, or a glob. A `:level` suffix sets the thinking level:

```js
await agent('Scan the repo.', { label: 'scan', model: 'haiku' })
await agent('Synthesize the findings.', { label: 'synthesis', model: 'anthropic/claude-opus-4-5:high' })
```

Only models with configured auth match. If the pattern matches no model or more than one model, the agent resolves to `null` and logs the error. If you do not set `model`, the subagent uses the session model. The live progress view shows the model of each subagent.

Subagents cannot call the `workflow` tool. Thus, a workflow cannot start a nested workflow.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses the script + runs it in the codemode sandbox
  → script calls agent(), parallel(), pipeline(), and tools.<name>()
  → each agent() spawns an in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and workflow runtime on the codemode sandbox. |
| `src/sandbox-script.ts` | The code that runs in the sandbox around the workflow body: `parallel()`, `pipeline()`, `phase()`, `budget`, and the determinism stubs. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is a prototype. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) but does not yet implement persisted or resumable runs, or a `/workflows` manager.

## License

MIT
