/**
 * stop-task-tool.js — 终止后台任务
 *
 * 通过 TaskRegistry 终止任何类型的后台任务（子代理、生图、生视频等）。
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { getToolSessionPath } from "./tool-session.ts";

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stopTaskError(text, errorCode, details = {}) {
  return {
    isError: true,
    content: [{ type: "text", text }],
    details: { errorCode, ...details },
  };
}

function resolveSessionId(deps, sessionPath) {
  if (!sessionPath) return null;
  return textOrNull(deps.getSessionIdForPath?.(sessionPath));
}

export function createStopTaskTool(deps) {
  return {
    name: "stop_task",
    label: "Stop background task",
    description: "Stop a running background task. Pass the task_id to terminate it. Supported task types include sub-agent tasks, image/video generation tasks, etc.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to stop" }),
    }),
    sessionPermission: {
      resolveInvocation: (params) => {
        const taskId = textOrNull(params?.task_id);
        return {
          action: "stop",
          kind: "routine",
          capability: "stop_task.stop",
          ...(taskId ? {
            target: {
              type: "background_task",
              id: taskId,
            },
          } : {}),
        };
      },
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const taskId = params.task_id?.trim();
      if (!taskId) {
        return stopTaskError("task_id is required", "STOP_TASK_ID_REQUIRED");
      }

      const registry = deps.getTaskRegistry?.();
      if (!registry) {
        return stopTaskError("task registry unavailable", "STOP_TASK_REGISTRY_UNAVAILABLE");
      }

      const callerSessionPath = getToolSessionPath(ctx);
      const callerSessionId = resolveSessionId(deps, callerSessionPath);
      if (!callerSessionId) {
        return stopTaskError(
          "stop_task requires an active session with a stable session identity",
          "STOP_TASK_SESSION_ID_REQUIRED",
        );
      }

      const task = registry.query?.(taskId) || null;
      if (!task) {
        return { content: [{ type: "text", text: t("error.stopTaskNotFound", { taskId }) }] };
      }
      const taskParentSessionId = textOrNull(task.parentSessionId)
        || resolveSessionId(deps, textOrNull(task.parentSessionPath));
      if (!taskParentSessionId) {
        return stopTaskError(
          `Background task has no stable parent session identity: ${taskId}`,
          "STOP_TASK_PARENT_SESSION_ID_REQUIRED",
          { taskId },
        );
      }
      if (taskParentSessionId !== callerSessionId) {
        return stopTaskError(
          `Background task does not belong to this session: ${taskId}`,
          "STOP_TASK_SESSION_MISMATCH",
          { taskId },
        );
      }

      const result = registry.abort(taskId);

      if (result === "not_found") {
        return { content: [{ type: "text", text: t("error.stopTaskNotFound", { taskId }) }] };
      }
      if (result === "already_aborted" || result === "already_finished") {
        return { content: [{ type: "text", text: t("error.stopTaskAlready", { taskId }) }] };
      }
      if (result === "no_handler") {
        return { content: [{ type: "text", text: t("error.stopTaskNoHandler", { taskId }) }] };
      }

      return { content: [{ type: "text", text: t("error.stopTaskDone", { taskId }) }] };
    },
  };
}
