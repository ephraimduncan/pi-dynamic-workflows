/**
 * Builds the code that pi's codemode sandbox runs for one workflow.
 *
 * The sandbox is a QuickJS VM. Host functions reach it only as async globals, and values cross as
 * JSON, so the workflow globals that take functions (`parallel`, `pipeline`) or must be synchronous
 * (`phase`, `budget`) live in the VM. They call the host through the `__workflow` namespace:
 *
 * - `__workflow.agent(prompt, options)` resolves to `{ value, spent }`
 * - `__workflow.phase(title)` and `__workflow.log(message)` report progress
 */

export const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

export interface SandboxScriptOptions {
  args?: unknown;
  cwd: string;
  tokenBudget: number | null;
}

/**
 * Wrap a workflow body for `CodemodeSandbox.execute()`. The setup code shares the first line with
 * the body, thus line `n` of the body is line `n` in stack traces.
 */
export function buildSandboxScript(body: string, options: SandboxScriptOptions): string {
  const setup = SETUP.replace(/\n\s*/g, " ")
    .replace("__ARGS__", () => JSON.stringify(JSON.stringify(options.args ?? null)))
    .replace("__CWD__", () => JSON.stringify(options.cwd))
    .replace("__TOKEN_BUDGET__", () => JSON.stringify(options.tokenBudget))
    .replace("__NONDETERMINISM_ERROR__", () => JSON.stringify(NONDETERMINISM_ERROR));
  return `${setup}${body}\n${TEARDOWN}`;
}

// QuickJS has a real clock and random source. Replace them before the script runs, thus an alias
// such as `const f = Math.random` gets the stub too. Each statement ends with a semicolon because
// buildSandboxScript joins the lines.
const SETUP = `
const __host = __workflow;
const __nondeterministic = () => { throw new Error(__NONDETERMINISM_ERROR__); };
Object.defineProperty(Math, "random", { value: __nondeterministic, writable: false, configurable: false });
globalThis.Date = Object.freeze({ parse: Date.parse, UTC: Date.UTC, now: __nondeterministic });
return await (async () => {
  const args = JSON.parse(__ARGS__);
  const cwd = __CWD__;
  const process = Object.freeze({ cwd: () => cwd });
  const total = __TOKEN_BUDGET__;
  let spent = 0;
  const budget = Object.freeze({
    total,
    spent: () => spent,
    remaining: () => (total === null ? Infinity : Math.max(0, total - spent)),
  });
  const log = (message) => { void __host.log(String(message)); };
  const console = Object.freeze({
    log,
    info: log,
    debug: log,
    warn: (message) => log("[warn] " + String(message)),
    error: (message) => log("[error] " + String(message)),
  });
  const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
  let currentPhase;
  const phase = (title) => {
    if (typeof title !== "string") throw new TypeError("phase title must be a string");
    currentPhase = title;
    void __host.phase(title);
  };
  const agent = async (prompt, options = {}) => {
    if (typeof prompt !== "string") throw new TypeError("agent prompt must be a string");
    if (!options || typeof options !== "object") throw new TypeError("agent options must be an object");
    const reply = await __host.agent(prompt, { ...options, phase: options.phase ?? currentPhase });
    spent = reply.spent;
    return reply.value;
  };
  const parallel = async (thunks) => {
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        log("parallel[" + index + "] failed: " + errorMessage(error));
        return null;
      }
    }));
  };
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch (error) {
          log("pipeline[" + index + "] failed: " + errorMessage(error));
          return null;
        }
      }
      return value;
    }));
  };
  const findPromise = (value, path, seen) => {
    if (value === null || typeof value !== "object") return undefined;
    if (typeof value.then === "function") return path;
    if (seen.has(value)) return undefined;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const found = findPromise(value[key], path + (Array.isArray(value) ? "[" + key + "]" : "." + key), seen);
      if (found) return found;
    }
    return undefined;
  };
  const result = await (async () => {`;

// A Promise turns into {} in JSON. Thus, find one before the sandbox returns the result.
const TEARDOWN = `  })();
  const promisePath = findPromise(result, "result", new Set());
  if (promisePath) {
    throw new Error("workflow result must be JSON-serializable; did you forget to await agent(), parallel(), or pipeline()? " + promisePath + " is a Promise");
  }
  return result;
})();`;
