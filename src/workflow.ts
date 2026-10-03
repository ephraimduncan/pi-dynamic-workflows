import { type CodemodeResult, CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import { buildSandboxScript, NONDETERMINISM_ERROR } from "./sandbox-script.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** Tools the script calls as `tools.<name>(args)`, as in pi's codemode tool. */
  scriptTools?: CodemodeTool[];
  concurrency?: number;
  /** Token ceiling for all subagent sessions. When spent, agent() calls fail. */
  tokenBudget?: number | null;
  /** Most agent() calls one run can make. Stops a script that loops without end. Default: 200. */
  maxAgents?: number;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string }) => void;
  onAgentModel?: (event: { label: string; phase?: string; model: string }) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
}

interface RuntimeState {
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const DEFAULT_MAX_AGENTS = 200;

/** Same heap limit as pi's codemode tool. The VM shares pi's process. */
const SANDBOX_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Run a workflow script in pi's codemode sandbox. The script calls `agent()`, `parallel()`,
 * `pipeline()`, `phase()`, `log()`, and `tools.<name>()` for each tool in `scriptTools`.
 */
export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0 };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
  const tokenBudget = options.tokenBudget ?? null;
  let requestedAgents = 0;

  const log = (message: string) => {
    state.logs.push(message);
    options.onLog?.(message);
  };

  const phase = (title: string) => {
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title);
  };

  const throwIfBudgetSpent = () => {
    if (tokenBudget !== null && state.spent >= tokenBudget) throw new Error("workflow token budget exhausted");
  };

  const agent = async (prompt: unknown, agentOptions: unknown, scriptSignal: AbortSignal) => {
    throwIfBudgetSpent();
    if (++requestedAgents > maxAgents) throw new Error(`workflow agent limit reached: at most ${maxAgents} agents`);
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const assignedPhase = normalizedOptions.phase;
    const requestedLabel = normalizedOptions.label?.trim();
    // The sandbox aborts scriptSignal when the script ends before it awaits this agent.
    const signal = options.signal ? AbortSignal.any([options.signal, scriptSignal]) : scriptSignal;
    const run = limiter(async () => {
      // The budget can run out while this agent waits in the queue.
      throwIfBudgetSpent();
      state.agentCount++;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt });
      try {
        if (signal.aborted) throw new Error("Subagent was aborted");
        const result = await agentRunner.run(taskPrompt, {
          label,
          schema: normalizedOptions.schema,
          signal,
          model: normalizedOptions.model,
          onModel: (model: string) => options.onAgentModel?.({ label, phase: assignedPhase, model }),
          onStats: (stats: SessionStats) => {
            state.spent += stats.tokens.total;
          },
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
        } as any);
        if (signal.aborted) throw new Error("Subagent was aborted");
        options.onAgentEnd?.({ label, phase: assignedPhase, result });
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(
          scriptSignal.aborted
            ? `agent ${label} cancelled: the script ended before it awaited the agent`
            : `agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
        return null;
      }
    });
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    );
    return { value: await run, spent: state.spent };
  };

  const sandbox = new CodemodeSandbox({
    tools: options.scriptTools,
    globals: [
      {
        name: "__workflow.agent",
        spread: true,
        execute: ([prompt, opts]: any, { signal }) => agent(prompt, opts, signal),
      },
      { name: "__workflow.phase", execute: (title) => phase(String(title)) },
      { name: "__workflow.log", execute: (message) => log(String(message)) },
    ],
    // Workflows run for as long as their agents run. The caller's signal stops them.
    timeoutMs: Number.POSITIVE_INFINITY,
    memoryLimitBytes: SANDBOX_MEMORY_LIMIT_BYTES,
  });
  const code = buildSandboxScript(body, { args: options.args, cwd: options.cwd ?? process.cwd(), tokenBudget });
  let outcome: CodemodeResult;
  try {
    outcome = await sandbox.execute(code, { signal: options.signal });
  } finally {
    await sandbox.close();
    // The sandbox aborts the agents that the script did not await. Wait until their sessions stop.
    await Promise.allSettled([...pendingAgentRuns]);
  }
  if (!outcome.ok) {
    const { kind, message, stack } = outcome.error;
    if (kind === "aborted") throw new Error("workflow aborted");
    // Keep the stack frames: they give the script line to the model that wrote it.
    const frames = kind === "script" ? stack?.split("\n").slice(1).join("\n") : undefined;
    throw new Error(frames ? `${message}\n${frames}` : message);
  }
  return {
    meta,
    result: outcome.value as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    // Blank lines keep the line numbers of the script in stack traces.
    body:
      script.slice(0, first.start) +
      "\n".repeat(lineCount(script.slice(first.start, first.end)) - 1) +
      script.slice(first.end),
  };
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }

  for (const child of astChildren(node)) assertDeterministicAst(child);
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode));
    else if (isAstNode(value)) children.push(value);
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
    return false;
  }
  return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left);
    const right = staticStringOf(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    value.phases = value.phases.map(toMetaPhase);
  }
}

// Models often write `phases: ['Scan', 'Review']`. A bare string carries the same data as `{ title }`.
function toMetaPhase(phase: unknown): WorkflowMetaPhase {
  if (typeof phase === "string") return { title: phase };
  if (phase && typeof phase === "object" && typeof (phase as WorkflowMetaPhase).title === "string") {
    return phase as WorkflowMetaPhase;
  }
  throw new Error(`each meta.phases entry must be a string or { title: string }; got ${JSON.stringify(phase)}`);
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  return {
    ...options,
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    model: optionalString(options.model, "agent model"),
    isolation: options.isolation,
    agentType: optionalString(options.agentType, "agent type"),
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  return lines.length ? lines.join("\n") : undefined;
}
