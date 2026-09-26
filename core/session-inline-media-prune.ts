/**
 * Session inline media pruning
 *
 * Provider requests may need base64/image blocks for the current turn, but
 * SessionFile/path markers are the durable identity inside Hana. This module
 * removes inline media from Pi SDK session history after the turn has finished
 * so future context replay cannot resend large base64 payloads.
 */

import { stripAllInlineMediaForHistory } from "./message-sanitizer.ts";
import {
  flushSessionManagerSnapshot,
  readSessionEntriesFile,
  writeSessionEntriesFile,
} from "./session-jsonl-file.ts";

function emptyResult() {
  return { stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 };
}

function addCounts(target, source) {
  target.stripped += source.stripped || 0;
  target.strippedImages += source.strippedImages || 0;
  target.strippedVideos += source.strippedVideos || 0;
  target.strippedAudios += source.strippedAudios || 0;
}

function pruneSessionManagerEntries(sessionManager) {
  const result = emptyResult();
  const entries = Array.isArray(sessionManager?.fileEntries) ? sessionManager.fileEntries : [];
  let changed = false;

  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.message) continue;
    const stripped = stripAllInlineMediaForHistory([entry.message]);
    if (stripped.stripped === 0) continue;
    entry.message = stripped.messages[0];
    addCounts(result, stripped);
    changed = true;
  }

  if (changed && typeof sessionManager?._rewriteFile === "function") {
    flushSessionManagerSnapshot(sessionManager);
  }

  return result;
}

function stripMessageEntryInlineMedia(entry) {
  const result = emptyResult();
  if (entry?.type !== "message" || !entry.message) {
    return { entry, result, changed: false };
  }

  const stripped = stripAllInlineMediaForHistory([entry.message]);
  if (stripped.stripped === 0) {
    return { entry, result, changed: false };
  }

  addCounts(result, stripped);
  return {
    entry: { ...entry, message: stripped.messages[0] },
    result,
    changed: true,
  };
}

export function repairSessionInlineMediaEntries(entries) {
  const result = emptyResult();
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries, ...result };
  }

  let changed = false;
  const repaired = entries.map((entry) => {
    const stripped = stripMessageEntryInlineMedia(entry);
    if (!stripped.changed) return entry;
    changed = true;
    addCounts(result, stripped.result);
    return stripped.entry;
  });

  return {
    entries: changed ? repaired : entries,
    ...result,
  };
}

export function repairSessionInlineMediaEntriesInFile(sessionPath) {
  const empty = () => ({ repaired: false, ...emptyResult() });
  const loaded = readSessionEntriesFile(sessionPath);
  if (!loaded) return empty();

  const { entries, stripped, strippedImages, strippedVideos, strippedAudios } =
    repairSessionInlineMediaEntries(loaded.entries);
  if (stripped === 0) return empty();

  try {
    writeSessionEntriesFile(sessionPath, entries, { expectedRaw: loaded.raw });
  } catch {
    return empty();
  }

  return {
    repaired: true,
    stripped,
    strippedImages,
    strippedVideos,
    strippedAudios,
  };
}

function pruneAgentStateMessages(agent) {
  const result = emptyResult();
  const messages = agent?.state?.messages;
  if (!Array.isArray(messages)) return result;

  const stripped = stripAllInlineMediaForHistory(messages);
  if (stripped.stripped === 0) return result;
  agent.state.messages = stripped.messages;
  addCounts(result, stripped);
  return result;
}

export function pruneSessionInlineMediaHistory(session) {
  const result = emptyResult();
  addCounts(result, pruneSessionManagerEntries(session?.sessionManager));
  addCounts(result, pruneAgentStateMessages(session?.agent));
  return result;
}
