/**
 * Ambient globals available inside pi-dynamic-workflows workflow scripts.
 *
 * Add this to a JavaScript or TypeScript workflow file for editor IntelliSense:
 *
 *   /// <reference types="pi-dynamic-workflows/workflow" />
 */

export {};

declare global {
  /** Literal workflow metadata. Must be the first statement: `export const meta = { ... }`. */
  interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    /** Optional documentation for an expected outline. Live progress is driven by `phase(...)`. */
    phases?: Array<string | WorkflowMetaPhase>;
  }

  interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
  }

  interface WorkflowAgentOptions<TSchema = JsonSchema> {
    /** Short label shown in the live progress UI. */
    label?: string;
    /** Override the current runtime phase for this agent. */
    phase?: string;
    /** JSON Schema for structured output. When present, the returned value is typed as unknown unless you provide a generic. */
    schema?: TSchema;
    /**
     * Model for this subagent, resolved like the pi `--models` flag: 'haiku', 'sonnet:low',
     * or 'anthropic/claude-opus-4-5'. Only models with configured auth match. Default: the session model.
     */
    model?: string;
    /** Requested isolation mode. */
    isolation?: "worktree";
    /** Requested subagent role/type. */
    agentType?: string;
  }

  type JsonPrimitive = string | number | boolean | null;
  type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
  interface JsonObject {
    [key: string]: JsonValue;
  }

  interface JsonSchema {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: JsonValue[];
    const?: JsonValue;
    description?: string;
    [key: string]: unknown;
  }

  interface WorkflowBudget {
    total: number | null;
    spent(): number;
    remaining(): number;
  }

  /** Spawn a subagent. Returns final text unless a structured-output schema is used with an explicit generic.
   * Resolves to null if the subagent fails; check for null before using the result. */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T | null>;

  /** Run independent async tasks concurrently. Pass functions, not already-created promises.
   * Failed thunks resolve to null in their input position; the array order always matches the input order. */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;

  /** Run each item through sequential async stages while different items may run concurrently.
   * An item whose stage fails resolves to null in its input position. */
  function pipeline<TItem, TResult = unknown>(
    items: TItem[],
    ...stages: Array<(previous: unknown, original: TItem, index: number) => TResult | Promise<TResult>>
  ): Promise<Array<TResult | null>>;

  /** Mark the current workflow phase for progress grouping. */
  function phase(title: string): void;

  /** Append a workflow-level log line. */
  function log(message: unknown): void;

  /** Optional JSON args passed to the workflow tool. Narrow with a local type assertion when needed. */
  const args: unknown;

  /** Current working directory for the workflow/subagents. */
  const cwd: string;

  /**
   * Session tools, as in pi's codemode tool: `await tools.bash({ command: 'ls' })`. Tools with an
   * output schema resolve to structured values. Other tools resolve to their text output.
   */
  const tools: Record<string, (args: Record<string, unknown>) => Promise<any>>;

  /** Every tool in `tools`, with its description and TypeScript declaration. */
  const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;

  /** Deterministic process shim exposing only cwd(). */
  const process: { cwd(): string };

  /**
   * Token budget of the run. spent() counts the tokens that finished subagent sessions used.
   * total is null when the workflow call has no tokenBudget.
   */
  const budget: WorkflowBudget;
}
