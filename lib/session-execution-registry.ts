import { getToolSessionPath, resolveToolSessionRef } from "./tools/tool-session.ts";

function nonEmptyText(value: any): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function combinedSignal(local: AbortSignal, upstream: any): AbortSignal {
  if (!upstream || typeof upstream !== "object" || typeof upstream.aborted !== "boolean") {
    return local;
  }
  return AbortSignal.any([local, upstream]);
}

function isAbortSignalLike(value: any): value is AbortSignal {
  return !!value
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function";
}

/**
 * Owns in-flight tool cancellation by persistent Session identity.
 *
 * The Pi SDK normally aborts the active tool when AgentSession.abort() runs,
 * but the host control plane also needs a direct path that does not depend on
 * the provider/session stream settling correctly. Entries are runtime-only and
 * disappear as soon as their tool promise settles.
 */
export class SessionExecutionRegistry {
  declare _activeBySessionId: Map<string, Map<symbol, any>>;

  constructor() {
    this._activeBySessionId = new Map();
  }

  begin({ sessionId, toolName = "tool", toolCallId = null, signal = null }: any = {}) {
    const stableSessionId = nonEmptyText(sessionId);
    if (!stableSessionId) throw new Error("SessionExecutionRegistry.begin requires sessionId");

    const controller = new AbortController();
    const key = Symbol(nonEmptyText(toolCallId) || nonEmptyText(toolName) || "tool");
    const entries = this._activeBySessionId.get(stableSessionId) || new Map();
    entries.set(key, {
      controller,
      toolName: nonEmptyText(toolName) || "tool",
      toolCallId: nonEmptyText(toolCallId),
    });
    this._activeBySessionId.set(stableSessionId, entries);

    let released = false;
    return {
      signal: combinedSignal(controller.signal, signal),
      release: () => {
        if (released) return;
        released = true;
        entries.delete(key);
        if (entries.size === 0) this._activeBySessionId.delete(stableSessionId);
      },
    };
  }

  abortBySession(sessionRef: any, reason = "session aborted") {
    const sessionId = nonEmptyText(sessionRef?.sessionId);
    if (!sessionId) throw new Error("SessionExecutionRegistry.abortBySession requires sessionId");
    const entries = this._activeBySessionId.get(sessionId);
    if (!entries) return { matched: 0, aborted: 0 };

    let aborted = 0;
    for (const entry of entries.values()) {
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort(new Error(reason));
      aborted++;
    }
    return { matched: entries.size, aborted };
  }

  activeCount(sessionId: any) {
    const stableSessionId = nonEmptyText(sessionId);
    if (!stableSessionId) return 0;
    return this._activeBySessionId.get(stableSessionId)?.size || 0;
  }
}

export function wrapWithSessionExecutionCancellation(tools: any[] = [], deps: any = {}) {
  return tools.map((tool) => {
    if (!tool?.execute || tool._sessionExecutionCancellationWrapped) return tool;
    return {
      ...tool,
      _sessionExecutionCancellationWrapped: true,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const runtimeCtx = ctx || (!isAbortSignalLike(signal) ? signal : null);
        const upstreamSignal = isAbortSignalLike(signal) ? signal : null;
        // Cancellation is enforced before dispatch, including legacy/no-session
        // tools which may not inspect the signal themselves.
        upstreamSignal?.throwIfAborted();
        const sessionPath = getToolSessionPath(runtimeCtx)
          || runtimeCtx?.sessionPath
          || deps.getSessionRef?.()?.sessionPath
          || deps.getSessionPath?.()
          || null;
        const sessionRef = resolveToolSessionRef(runtimeCtx, deps);
        if (!sessionRef && !sessionPath) {
          return tool.execute(toolCallId, params, signal, onUpdate, ctx);
        }
        if (!nonEmptyText(sessionRef?.sessionId)) {
          throw new Error(`Cannot execute ${tool.name || "tool"}: sessionId is unavailable`);
        }
        const enrichedRuntimeCtx = {
          ...(runtimeCtx || {}),
          sessionId: sessionRef.sessionId,
          sessionRef,
          ...(sessionRef.sessionPath ? { sessionPath: sessionRef.sessionPath } : {}),
        };
        const execution = deps.registry.begin({
          sessionId: sessionRef.sessionId,
          toolName: tool.name,
          toolCallId,
          signal: upstreamSignal,
        });
        try {
          execution.signal.throwIfAborted();
          return await tool.execute(toolCallId, params, execution.signal, onUpdate, enrichedRuntimeCtx);
        } finally {
          execution.release();
        }
      },
    };
  });
}
