import { copyTextToClipboard } from '../utils/clipboard';
import {
  PLUGIN_UI_CAPABILITY,
  type PluginResourceOpenInput,
  type PluginResourcePickInput,
  type PluginResourceRequestAccessInput,
} from '@hana/plugin-protocol';
import { useStore } from '../stores';
import { selectSessionFiles } from '../stores/selectors/file-refs';
import type { Toast } from '../stores/toast-slice';
import type { FileRef } from '../types/file-ref';
import { fileRefDownloadUrl, openFileRefPreview } from '../utils/remote-file-preview';
import type {
  PluginUiCapability,
  PluginUiPayloadValidationResult,
  PluginUiRequestContext,
} from './plugin-ui-host-controller';

const TOAST_TYPES = new Set<Toast['type']>(['success', 'error', 'info', 'warning']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateToastPayload(payload: unknown): PluginUiPayloadValidationResult {
  if (!isObject(payload) || typeof payload.message !== 'string' || payload.message.trim() === '') {
    return { ok: false, error: 'toast.show requires a non-empty message.' };
  }
  const type = typeof payload.type === 'string' && TOAST_TYPES.has(payload.type as Toast['type'])
    ? payload.type as Toast['type']
    : 'info';
  const duration = typeof payload.duration === 'number' && Number.isFinite(payload.duration) && payload.duration >= 0
    ? payload.duration
    : 5000;
  return {
    ok: true,
    value: {
      message: payload.message,
      type,
      duration,
    },
  };
}

function validateExternalOpenPayload(payload: unknown): PluginUiPayloadValidationResult {
  if (!isObject(payload) || typeof payload.url !== 'string') {
    return { ok: false, error: 'external.open requires a URL string.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(payload.url);
  } catch {
    return { ok: false, error: 'external.open requires a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'external.open requires an http or https URL.' };
  }
  return { ok: true, value: { url: parsed.toString() } };
}

function validateClipboardWriteTextPayload(payload: unknown): PluginUiPayloadValidationResult {
  if (!isObject(payload) || typeof payload.text !== 'string') {
    return { ok: false, error: 'clipboard.writeText requires a text string.' };
  }
  return { ok: true, value: { text: payload.text } };
}

function validateResourceOpenPayload(payload: unknown): PluginUiPayloadValidationResult {
  if (!isObject(payload) || !isObject(payload.resource)) {
    return { ok: false, error: 'resource.open requires a resource object.' };
  }
  const mode = typeof payload.mode === 'string' && payload.mode.trim()
    ? payload.mode.trim()
    : 'preview';
  return {
    ok: true,
    value: {
      resource: payload.resource,
      mode,
    },
  };
}

function validateResourcePickPayload(payload: unknown): PluginUiPayloadValidationResult {
  if (payload == null) {
    return { ok: true, value: { mode: 'file', multiple: false } };
  }
  if (!isObject(payload)) {
    return { ok: false, error: 'resource.pick requires an object payload.' };
  }
  const mode = typeof payload.mode === 'string' && payload.mode.trim()
    ? payload.mode.trim()
    : 'file';
  return {
    ok: true,
    value: {
      mode,
      multiple: payload.multiple === true,
      ...(typeof payload.capability === 'string' ? { capability: payload.capability } : {}),
    },
  };
}

function validateResourceRequestAccessPayload(payload: unknown): PluginUiPayloadValidationResult {
  if (!isObject(payload) || typeof payload.capability !== 'string' || payload.capability.trim() === '') {
    return { ok: false, error: 'resource.requestAccess requires a capability string.' };
  }
  return {
    ok: true,
    value: {
      capability: payload.capability.trim(),
      ...(isObject(payload.resource) ? { resource: payload.resource } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    },
  };
}

async function showToast(_ctx: PluginUiRequestContext, payload: unknown): Promise<unknown> {
  const { message, type, duration } = payload as {
    message: string;
    type: Toast['type'];
    duration: number;
  };
  useStore.getState().addToast(message, type, duration);
  return { shown: true };
}

async function openExternal(_ctx: PluginUiRequestContext, payload: unknown): Promise<unknown> {
  const { url } = payload as { url: string };
  window.platform?.openExternal?.(url);
  return { opened: true };
}

async function writeClipboardText(_ctx: PluginUiRequestContext, payload: unknown): Promise<unknown> {
  const { text } = payload as { text: string };
  await copyTextToClipboard(text);
  return { written: true };
}

function pathName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function findSessionFileRef(resource: Record<string, unknown>): { file: FileRef; sessionPath: string } | null {
  const state = useStore.getState();
  const preferredPath = typeof resource.sessionPath === 'string' && resource.sessionPath.trim()
    ? resource.sessionPath.trim()
    : null;
  const fileId = typeof resource.fileId === 'string' && resource.fileId.trim()
    ? resource.fileId.trim()
    : null;
  const resourceId = typeof resource.resourceId === 'string' && resource.resourceId.trim()
    ? resource.resourceId.trim()
    : null;
  const filePath = firstNonEmptyString(resource.filePath, resource.path);
  const paths = preferredPath
    ? [preferredPath, ...Object.keys(state.sessionRegistryFilesByPath || {}).filter(path => path !== preferredPath)]
    : Object.keys(state.sessionRegistryFilesByPath || {});

  for (const sessionPath of paths) {
    const files = selectSessionFiles(state, sessionPath, { includeUnlisted: true });
    // fork 出来的 session 里，插件手上的 fileId / 路径可能还是父 session 那一份，
    // 账本条目把它们记成了别名，所以别名也要认。
    const file = files.find(candidate => (
      (fileId && (candidate.fileId === fileId || (candidate.legacyFileIds || []).includes(fileId)))
      || (resourceId && candidate.resource?.resourceId === resourceId)
      || (filePath && (candidate.path === filePath || (candidate.legacyFilePaths || []).includes(filePath)))
    ));
    if (file) return { file, sessionPath };
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function requirePlatformMethod<K extends keyof Window['platform']>(name: K): NonNullable<Window['platform'][K]> {
  const method = window.platform?.[name];
  if (typeof method !== 'function') {
    throw new Error(`resource host capability requires platform.${String(name)}.`);
  }
  return method as NonNullable<Window['platform'][K]>;
}

async function openLocalPath(filePath: string, mode: string): Promise<void> {
  if (mode === 'reveal') {
    requirePlatformMethod('showInFinder')(filePath);
    return;
  }
  requirePlatformMethod('openFile')(filePath);
}

async function openSessionFile(resource: Record<string, unknown>, mode: string): Promise<void> {
  const found = findSessionFileRef(resource);
  if (!found) {
    throw new Error('resource.open could not find the requested session resource in the loaded session registry.');
  }
  const { file, sessionPath } = found;
  if (mode === 'reveal') {
    if (!file.path) throw new Error('resource.open cannot reveal a session resource without a local path.');
    requirePlatformMethod('showInFinder')(file.path);
    return;
  }
  if (mode === 'download') {
    const downloadUrl = fileRefDownloadUrl(file);
    if (downloadUrl) {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!file.path) throw new Error('resource.open cannot download a session resource without a local path or content link.');
    requirePlatformMethod('openFile')(file.path);
    return;
  }
  await openFileRefPreview(file, { origin: 'session', sessionPath });
}

async function openResource(_ctx: PluginUiRequestContext, payload: unknown): Promise<unknown> {
  const { resource, mode } = payload as PluginResourceOpenInput;
  if (!isObject(resource)) {
    throw new Error('resource.open requires a resource object.');
  }
  const resourceRecord = resource as Record<string, unknown>;
  const kind = typeof resourceRecord.kind === 'string' ? resourceRecord.kind : null;
  if (kind === 'url') {
    const url = typeof resourceRecord.url === 'string' ? resourceRecord.url : '';
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('resource.open only supports http or https URL resources.');
    }
    window.platform?.openExternal?.(parsed.toString());
    return { opened: true };
  }
  if (kind === 'local-file') {
    const filePath = typeof resourceRecord.path === 'string' ? resourceRecord.path : '';
    if (!filePath) throw new Error('resource.open local-file requires path.');
    await openLocalPath(filePath, mode || 'preview');
    return { opened: true };
  }
  if (kind === 'session-file' || kind === 'resource') {
    await openSessionFile(resourceRecord, mode || 'preview');
    return { opened: true };
  }
  throw new Error(`resource.open does not support resource kind: ${kind || 'unknown'}.`);
}

async function pickResource(_ctx: PluginUiRequestContext, payload: unknown): Promise<unknown> {
  const { mode, multiple } = payload as PluginResourcePickInput;
  if (mode === 'directory') {
    const folder = await requirePlatformMethod('selectFolder')();
    return {
      resources: folder ? [{ kind: 'local-file', path: folder, name: pathName(folder), isDirectory: true }] : [],
    };
  }
  const files = await requirePlatformMethod('selectFiles')({ multiple });
  return {
    resources: files.map(filePath => ({
      kind: 'local-file',
      path: filePath,
      name: pathName(filePath),
    })),
  };
}

async function requestResourceAccess(_ctx: PluginUiRequestContext, payload: unknown): Promise<unknown> {
  const { capability } = payload as PluginResourceRequestAccessInput;
  return { granted: false, capability };
}

export const DEFAULT_PLUGIN_UI_CAPABILITIES: readonly PluginUiCapability[] = [
  {
    name: PLUGIN_UI_CAPABILITY.TOAST_SHOW,
    allowedSlots: ['page', 'widget', 'card', 'settings'],
    requiresGrant: false,
    validatePayload: validateToastPayload,
    handle: showToast,
  },
  {
    name: PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN,
    allowedSlots: ['page', 'widget', 'settings'],
    requiresGrant: true,
    validatePayload: validateExternalOpenPayload,
    handle: openExternal,
  },
  {
    name: PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
    allowedSlots: ['page', 'widget', 'settings'],
    requiresGrant: true,
    validatePayload: validateClipboardWriteTextPayload,
    handle: writeClipboardText,
  },
  {
    name: PLUGIN_UI_CAPABILITY.RESOURCE_OPEN,
    allowedSlots: ['page', 'widget', 'card', 'settings'],
    requiresGrant: true,
    validatePayload: validateResourceOpenPayload,
    handle: openResource,
  },
  {
    name: PLUGIN_UI_CAPABILITY.RESOURCE_PICK,
    allowedSlots: ['page', 'widget', 'card', 'settings'],
    requiresGrant: true,
    validatePayload: validateResourcePickPayload,
    handle: pickResource,
  },
  {
    name: PLUGIN_UI_CAPABILITY.RESOURCE_REQUEST_ACCESS,
    allowedSlots: ['page', 'widget', 'card', 'settings'],
    requiresGrant: true,
    validatePayload: validateResourceRequestAccessPayload,
    handle: requestResourceAccess,
  },
];
