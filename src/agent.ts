import { join } from "node:path";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Model pattern, resolved like pi's `--models` flag: "haiku", "sonnet:low",
   * or "anthropic/claude-sonnet-4-5". Only models with configured auth match.
   * When omitted, the subagent uses the session model.
   */
  model?: string;
  /** Called with the "provider/id" of the model the subagent runs on. */
  onModel?: (model: string) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private modelRuntime?: Promise<ModelRuntime>;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
    const modelRuntime = await this.getModelRuntime(agentDir);
    const pinned = options.model === undefined ? undefined : await resolveModel(options.model, modelRuntime);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      modelRuntime,
      // Subagents load the same extensions as the parent. Without this, a subagent could start a nested workflow.
      excludeTools: [...(this.sessionOptions.excludeTools ?? []), "workflow"],
      ...(pinned?.model ? { model: pinned.model } : {}),
      ...(pinned?.thinkingLevel ? { thinkingLevel: pinned.thinkingLevel } : {}),
    });

    let removeAbortListener: (() => void) | undefined;
    try {
      if (session.model) options.onModel?.(`${session.model.provider}/${session.model.id}`);
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      session.dispose();
    }
  }

  private getModelRuntime(agentDir: string): Promise<ModelRuntime> {
    if (this.sessionOptions.modelRuntime) return Promise.resolve(this.sessionOptions.modelRuntime);
    this.modelRuntime ??= ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    return this.modelRuntime;
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}

async function resolveModel(pattern: string, modelRuntime: ModelRuntime) {
  const { scopedModels } = await resolveModelScopeWithDiagnostics([pattern], modelRuntime);
  if (scopedModels.length === 1) return scopedModels[0];
  if (scopedModels.length === 0) throw new Error(`no model with configured auth matches "${pattern}"`);
  const names = scopedModels.map(({ model }) => `${model.provider}/${model.id}`).join(", ");
  throw new Error(`model "${pattern}" matches more than one model: ${names}`);
}
