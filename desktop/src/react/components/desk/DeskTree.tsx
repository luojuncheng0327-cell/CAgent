import { copyTextToClipboard } from '../../utils/clipboard';
/**
 * DeskTree — Obsidian-like single-column workspace tree.
 *
 * Tree state is keyed by explicit subdir strings in desk-slice. The component
 * never derives ownership from the current focused file or session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { useStore } from '../../stores';
import {
  deskCreateFileInSubdir,
  deskMkdirInSubdir,
  deskMoveTreeFiles,
  deskNativeRootDir,
  deskRenameTreeItem,
  deskTrashTreeItems,
  deskUploadBrowserFilesToSubdir,
  deskUploadFilesToSubdir,
  loadDeskTreeFiles,
} from '../../stores/desk-actions';
import { schedulePersistCurrentWorkspaceUiState } from '../../stores/workspace-ui-state-actions';
import { isMarkdownFileName } from '../../utils/file-kind';
import {
  canUseNativeResourcePath,
  resolveWorkbenchNativePath,
} from '../../services/resource-access';
import { resolveServerConnection } from '../../services/server-connection';
import { isWebRuntime, openWorkbenchFilePreview } from '../../utils/remote-file-preview';
import { takeMarkdownFileScreenshot } from '../../utils/screenshot';
import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
  writeAppFileDragPayload,
} from '../../utils/app-file-drag';
import type { DeskFile } from '../../types';
import type { CtxMenuState, FileTypeFilter, SortMode } from './desk-types';
import { ICONS, fileMatchesTypeFilters, getFileIcon, sortDeskFiles } from './desk-types';
import s from './Desk.module.css';

function childSubdir(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentSubdir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

function currentResourceAccessContext() {
  return { connection: resolveServerConnection(useStore.getState()) };
}

function shouldUseBrowserDeskUpload(): boolean {
  return isWebRuntime() || !canUseNativeResourcePath(currentResourceAccessContext());
}

function isDescendant(path: string, parent: string): boolean {
  return path.startsWith(`${parent}/`);
}

function treeItemSubdir(sourceSubdir: string | undefined, name: string): string {
  return sourceSubdir ? `${sourceSubdir}/${name}` : name;
}

interface VisibleTreeEntry {
  file: DeskFile;
  parent: string;
  subdir: string;
  depth: number;
}

interface TreeSelectMeta {
  multi: boolean;
  shift: boolean;
}

export type InlineCreateKind = 'markdown' | 'folder';

export type InlineTreeEdit =
  | { mode: 'rename'; targetSubdir: string }
  | {
      mode: 'create';
      parentSubdir: string;
      kind: InlineCreateKind;
      draftName: string;
      content: string;
      phase: 'editing' | 'saving';
    }
  | null;

function collectVisibleTreeEntries(
  files: DeskFile[],
  parent: string,
  depth: number,
  sortMode: SortMode,
  typeFilters: FileTypeFilter[],
  expandedPaths: string[],
  treeFilesByPath: Record<string, DeskFile[]>,
): VisibleTreeEntry[] {
  const entries: VisibleTreeEntry[] = [];
  for (const file of sortDeskFiles(files, sortMode)) {
    if (!fileMatchesTypeFilters(file, typeFilters)) continue;
    const subdir = childSubdir(parent, file.name);
    entries.push({ file, parent, subdir, depth });
    if (file.isDir && expandedPaths.includes(subdir)) {
      entries.push(...collectVisibleTreeEntries(
        treeFilesByPath[subdir] || [],
        subdir,
        depth + 1,
        sortMode,
        typeFilters,
        expandedPaths,
        treeFilesByPath,
      ));
    }
  }
  return entries;
}

function hasSelectedDirectoryAncestor(entry: VisibleTreeEntry, selectedDirs: Set<string>): boolean {
  let current = parentSubdir(entry.subdir);
  while (current) {
    if (selectedDirs.has(current)) return true;
    current = parentSubdir(current);
  }
  return false;
}

function compactDragEntries(entries: VisibleTreeEntry[]): VisibleTreeEntry[] {
  const selectedDirs = new Set(entries.filter(entry => entry.file.isDir).map(entry => entry.subdir));
  if (selectedDirs.size === 0) return entries;
  return entries.filter(entry => !hasSelectedDirectoryAncestor(entry, selectedDirs));
}

function buildMoveItemsForDest(files: Array<{
  sourceSubdir?: string;
  name: string;
  isDirectory?: boolean;
}>, destSubdir: string) {
  const normalizedDest = destSubdir.replace(/^\/+|\/+$/g, '');
  return files
    .filter(item => item.sourceSubdir !== undefined)
    .filter(item => {
      const sourceSubdir = (item.sourceSubdir || '').replace(/^\/+|\/+$/g, '');
      if (sourceSubdir === normalizedDest) return false;
      if (!item.isDirectory) return true;
      const itemSubdir = treeItemSubdir(sourceSubdir, item.name);
      return normalizedDest !== itemSubdir && !normalizedDest.startsWith(`${itemSubdir}/`);
    })
    .map(item => ({
      sourceSubdir: (item.sourceSubdir || '').replace(/^\/+|\/+$/g, ''),
      name: item.name,
      isDirectory: item.isDirectory,
    }));
}

function toggleExpanded(paths: string[], subdir: string): string[] {
  if (paths.includes(subdir)) {
    return paths.filter(path => path !== subdir && !isDescendant(path, subdir));
  }
  return [...paths, subdir];
}

const BACKGROUND_TREE_REFRESH_DELAY_MS = 120;
const backgroundTreeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function deskRootKey(basePath: string, mountId: string | null): string {
  return mountId ? `studio:${mountId}` : basePath;
}

function scheduleBackgroundTreeRefresh(subdir: string, rootKey: string): void {
  if (!rootKey) return;
  const key = `${rootKey}\n${subdir}`;
  const existing = backgroundTreeRefreshTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    backgroundTreeRefreshTimers.delete(key);
    const state = useStore.getState();
    if (deskRootKey(state.deskBasePath, state.deskWorkspaceMountId) !== rootKey) return;
    if (!state.deskExpandedPaths.includes(subdir)) return;
    void loadDeskTreeFiles(subdir, { force: true });
  }, BACKGROUND_TREE_REFRESH_DELAY_MS);
  backgroundTreeRefreshTimers.set(key, timer);
}

function TreeDisclosureIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {expanded ? <polyline points="6 9 12 15 18 9" /> : <polyline points="9 6 15 12 9 18" />}
    </svg>
  );
}

function dispatchDeskNotice(text: string): void {
  window.dispatchEvent(new CustomEvent('hana-inline-notice', {
    detail: { text, type: 'error' },
  }));
}

function RenameInput({
  initialValue,
  disabled = false,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className={s.renameInput}
      disabled={disabled}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={() => {
        if (finishedRef.current) return;
        finishedRef.current = true;
        onCommit(value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (finishedRef.current) return;
          finishedRef.current = true;
          onCommit(value);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finishedRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function PendingCreateNode({
  edit,
  depth,
  onCommit,
  onCancel,
}: {
  edit: Extract<NonNullable<InlineTreeEdit>, { mode: 'create' }>;
  depth: number;
  onCommit: (edit: Extract<NonNullable<InlineTreeEdit>, { mode: 'create' }>, value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const isFolder = edit.kind === 'folder';
  return (
    <div
      className={`${s.treeItem} ${s.treeItemSelected}`}
      role="treeitem"
      aria-label={edit.draftName}
      data-desk-item=""
      data-desk-pending-create=""
      data-selected="true"
      style={{ '--tree-depth': depth } as CSSProperties}
      tabIndex={0}
    >
      <span className={s.treeIndent} aria-hidden="true" />
      <span className={s.treeDisclosure} aria-hidden="true" />
      <span
        className={s.itemIcon}
        dangerouslySetInnerHTML={{ __html: isFolder ? ICONS.folder : getFileIcon(edit.draftName) }}
      />
      <RenameInput
        initialValue={edit.draftName}
        disabled={edit.phase === 'saving'}
        onCommit={(value) => void onCommit(edit, value)}
        onCancel={onCancel}
      />
    </div>
  );
}

function TreeNode({
  file,
  parent,
  depth,
  sortMode,
  typeFilters,
  onShowMenu,
  selectedPaths,
  onSelect,
  getDragEntries,
  inlineEdit,
  onInlineEditChange,
  onStartCreate,
  onBeginRename,
  onCommitRename,
  onCommitCreate,
  onCancelRename,
}: {
  file: DeskFile;
  parent: string;
  depth: number;
  sortMode: SortMode;
  typeFilters: FileTypeFilter[];
  onShowMenu: (state: CtxMenuState) => void;
  selectedPaths: Set<string>;
  onSelect: (subdir: string, meta: TreeSelectMeta) => void;
  getDragEntries: (subdir: string) => VisibleTreeEntry[];
  inlineEdit: InlineTreeEdit;
  onInlineEditChange: Dispatch<SetStateAction<InlineTreeEdit>>;
  onStartCreate: (parentSubdir: string, kind: InlineCreateKind) => Promise<void>;
  onBeginRename: (subdir: string) => void;
  onCommitRename: (entry: VisibleTreeEntry, newName: string) => Promise<void>;
  onCommitCreate: (edit: Extract<NonNullable<InlineTreeEdit>, { mode: 'create' }>, newName: string) => Promise<void>;
  onCancelRename: () => void;
}) {
  const deskBasePath = useStore(st => st.deskBasePath);
  const deskWorkspaceMountId = useStore(st => st.deskWorkspaceMountId);
  // 工作台根的 native 路径：普通文件夹即 deskBasePath；local_fs mount 用服务端
  // 披露的 native root（#1622）。远端/虚拟 mount 为 null，相关本地能力保持隐藏。
  const nativeRootDir = useStore(deskNativeRootDir);
  const treeFilesByPath = useStore(st => st.deskTreeFilesByPath);
  const expandedPaths = useStore(st => st.deskExpandedPaths);
  const setDeskExpandedPaths = useStore(st => st.setDeskExpandedPaths);
  const subdir = childSubdir(parent, file.name);
  const expanded = file.isDir && expandedPaths.includes(subdir);
  const selected = selectedPaths.has(subdir);
  const children = treeFilesByPath[subdir] || [];
  const [dropTarget, setDropTarget] = useState(false);
  const isRenaming = inlineEdit?.mode === 'rename' && inlineEdit.targetSubdir === subdir;
  const pendingChild = inlineEdit?.mode === 'create' && inlineEdit.parentSubdir === subdir ? inlineEdit : null;

  useEffect(() => {
    if (!dropTarget) return undefined;
    const clear = () => setDropTarget(false);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
      window.removeEventListener('blur', clear);
    };
  }, [dropTarget]);

  const toggleFolder = useCallback(() => {
    if (!file.isDir) return;
    const hasCachedChildren = Object.prototype.hasOwnProperty.call(treeFilesByPath, subdir);
    const rootKey = deskRootKey(deskBasePath, deskWorkspaceMountId);
    setDeskExpandedPaths(toggleExpanded(expandedPaths, subdir));
    schedulePersistCurrentWorkspaceUiState();
    if (!expanded) {
      if (hasCachedChildren) scheduleBackgroundTreeRefresh(subdir, rootKey);
      else void loadDeskTreeFiles(subdir);
    }
  }, [deskBasePath, deskWorkspaceMountId, expanded, expandedPaths, file.isDir, setDeskExpandedPaths, subdir, treeFilesByPath]);

  const previewFile = useCallback(() => {
    if (file.isDir) return;
    void openWorkbenchFilePreview({
      file,
      subdir: parent,
      mountId: deskWorkspaceMountId || null,
      localRootPath: deskBasePath,
      nativeRootPath: nativeRootDir,
    });
  }, [deskBasePath, deskWorkspaceMountId, file, nativeRootDir, parent]);

  const handleClick = useCallback((event: React.MouseEvent) => {
    const multi = event.metaKey || event.ctrlKey;
    onSelect(subdir, { multi, shift: event.shiftKey });
    if (file.isDir && !multi && !event.shiftKey) toggleFolder();
    const shouldPreviewOnClick = !file.isDir
      && !multi
      && !event.shiftKey
      && (isWebRuntime() || !!deskWorkspaceMountId || !canUseNativeResourcePath(currentResourceAccessContext()));
    if (shouldPreviewOnClick) previewFile();
  }, [deskWorkspaceMountId, file.isDir, onSelect, previewFile, subdir, toggleFolder]);

  const openFile = useCallback(() => {
    onSelect(subdir, { multi: false, shift: false });
    if (file.isDir) {
      if (!expanded) toggleFolder();
      return;
    }
    previewFile();
  }, [expanded, file.isDir, onSelect, previewFile, subdir, toggleFolder]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const t = window.t ?? ((p: string, _vars?: Record<string, string | number>) => p);
    if (!selectedPaths.has(subdir)) onSelect(subdir, { multi: false, shift: false });
    const resourceContext = currentResourceAccessContext();
    const canUseNativePath = canUseNativeResourcePath(resourceContext);
    const nativePath = resolveWorkbenchNativePath({
      file,
      subdir: parent,
      mountId: deskWorkspaceMountId || null,
      localRootPath: deskBasePath,
      nativeRootPath: nativeRootDir,
    }, resourceContext);
    const screenshotSaveDir = nativePath ? (nativeRootDir || (!deskWorkspaceMountId ? deskBasePath : null)) : null;
    const actionEntries = getDragEntries(subdir);
    const deleteLabel = actionEntries.length > 1
      ? t('desk.ctx.deleteSelected', { count: actionEntries.length })
      : t('desk.ctx.delete');
    onShowMenu({
      position: { x: e.clientX, y: e.clientY },
      items: [
        {
          label: t(file.isDir ? 'desk.ctx.open' : 'desk.openWithDefault'),
          action: () => {
            if (file.isDir) {
              const hasCachedChildren = Object.prototype.hasOwnProperty.call(treeFilesByPath, subdir);
              const rootKey = deskRootKey(deskBasePath, deskWorkspaceMountId);
              const alreadyExpanded = expandedPaths.includes(subdir);
              setDeskExpandedPaths(alreadyExpanded ? expandedPaths : [...expandedPaths, subdir]);
              schedulePersistCurrentWorkspaceUiState();
              if (hasCachedChildren) scheduleBackgroundTreeRefresh(subdir, rootKey);
              else void loadDeskTreeFiles(subdir);
            } else {
              if (nativePath && !isWebRuntime()) window.platform?.openFile?.(nativePath);
              else previewFile();
            }
          },
        },
        ...(file.isDir ? [
          { label: t('desk.ctx.newMdFile'), action: () => { void onStartCreate(subdir, 'markdown'); } },
          { label: t('desk.ctx.newFolder'), action: () => { void onStartCreate(subdir, 'folder'); } },
        ] : []),
        ...(!isWebRuntime() && nativePath ? [
          { label: t('desk.ctx.openInFinder'), action: () => window.platform?.showInFinder?.(nativePath) },
        ] : []),
        ...(nativePath ? [
          { label: t('desk.ctx.copyPath'), action: () => copyTextToClipboard(nativePath).catch(() => {}) },
        ] : []),
        ...(!file.isDir && nativePath && screenshotSaveDir && isMarkdownFileName(file.name) && !isWebRuntime() ? [
          {
            label: t('common.screenshotShare'),
            action: () => {
              void takeMarkdownFileScreenshot(nativePath, { saveDir: screenshotSaveDir, fileName: file.name });
            },
          },
        ] : []),
        ...(!file.isDir && nativePath ? [
          { label: t('desk.ctx.history'), action: () => { useStore.getState().openFileHistoryForAbsolutePath(nativePath); } },
        ] : []),
        { divider: true },
        {
          label: t('desk.ctx.rename'),
          disabled: actionEntries.length !== 1,
          action: () => onBeginRename(subdir),
        },
        {
          label: deleteLabel,
          danger: true,
          disabled: actionEntries.length === 0 || (canUseNativePath && !isWebRuntime() && !deskWorkspaceMountId && !window.platform?.trashItem),
          action: async () => {
            const confirmed = window.confirm?.(
              actionEntries.length > 1
                ? t('desk.deleteSelectedConfirm', { count: actionEntries.length })
                : t('desk.deleteConfirm', { name: file.name }),
            ) ?? false;
            if (!confirmed) return;
            const ok = await deskTrashTreeItems(actionEntries.map(entry => ({
              sourceSubdir: entry.parent,
              name: entry.file.name,
              isDirectory: entry.file.isDir,
            })));
            if (!ok) dispatchDeskNotice(t('desk.trashFailed'));
          },
        },
      ],
    });
  }, [deskBasePath, deskWorkspaceMountId, expandedPaths, file, getDragEntries, nativeRootDir, onBeginRename, onSelect, onShowMenu, onStartCreate, parent, previewFile, selectedPaths, setDeskExpandedPaths, subdir, treeFilesByPath]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || isRenaming || inlineEdit) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(subdir, { multi: false, shift: false });
    onBeginRename(subdir);
  }, [inlineEdit, isRenaming, onBeginRename, onSelect, subdir]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    if (!selectedPaths.has(subdir)) onSelect(subdir, { multi: false, shift: false });
    const dragEntries = getDragEntries(subdir);
    // native root 可用时（普通文件夹 / 披露了 native root 的 local_fs mount）
    // 携带真实绝对路径并发起原生拖拽；只有拿不到 native 路径的 mount 才退回
    // workbench 引用（#1622）。
    const resourceContext = currentResourceAccessContext();
    const dragRows = dragEntries.map(entry => {
      const nativePath = resolveWorkbenchNativePath({
        file: entry.file,
        subdir: entry.parent,
        mountId: deskWorkspaceMountId || null,
        localRootPath: deskBasePath,
        nativeRootPath: nativeRootDir,
      }, resourceContext);
      return {
        nativePath,
        payload: {
          id: `workspace:${entry.subdir}`,
          name: entry.file.name,
          path: nativePath || `workbench:${deskWorkspaceMountId || 'default'}:${entry.subdir}`,
          sourceSubdir: entry.parent,
          isDirectory: entry.file.isDir,
        },
      };
    });
    if (dragRows.length === 0) return;
    const draggedFiles = dragRows.map(row => row.payload);
    const payload = writeAppFileDragPayload(e.dataTransfer, {
      source: 'workspace',
      files: draggedFiles,
    });
    e.currentTarget.addEventListener('dragend', () => clearAppFileDragPayload(payload.dragId), { once: true });
    e.preventDefault();
    const nativePaths = dragRows.map(row => row.nativePath).filter((path): path is string => !!path);
    if (nativePaths.length === dragRows.length && nativePaths.length > 0) {
      window.platform?.startDrag?.(nativePaths.length === 1 ? nativePaths[0] : nativePaths);
    }
  }, [deskBasePath, deskWorkspaceMountId, getDragEntries, nativeRootDir, onSelect, selectedPaths, subdir]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!file.isDir) return;
    const payload = readAppFileDragPayload(e.dataTransfer);
    const canMove = payload?.source !== 'workspace'
      || buildMoveItemsForDest(payload.files, subdir).length > 0;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = payload?.source === 'workspace'
      ? (canMove ? 'move' : 'none')
      : 'copy';
    setDropTarget(canMove);
  }, [file.isDir, subdir]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!file.isDir) return;
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(false);
  }, [file.isDir]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!file.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);

    const payload = readAppFileDragPayload(e.dataTransfer);
    if (payload?.source === 'workspace') {
      clearAppFileDragPayload(payload.dragId);
      const items = buildMoveItemsForDest(payload.files, subdir);
      if (items.length > 0) await deskMoveTreeFiles(items, subdir);
      return;
    }

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      if (shouldUseBrowserDeskUpload() || deskWorkspaceMountId) {
        await deskUploadBrowserFilesToSubdir(Array.from(files), subdir);
        setDropTarget(false);
        return;
      }
      const paths: string[] = [];
      for (const f of Array.from(files)) {
        const p = window.platform?.getFilePath?.(f);
        if (p) paths.push(p);
      }
      if (paths.length > 0) await deskUploadFilesToSubdir(paths, subdir);
    }
  }, [deskWorkspaceMountId, file.isDir, subdir]);

  return (
    <>
      <div
        className={`${s.treeItem}${selected ? ` ${s.treeItemSelected}` : ''}${dropTarget ? ` ${s.treeItemDropTarget}` : ''}`}
        role="treeitem"
        aria-label={file.name}
        title={file.name}
        aria-expanded={file.isDir ? expanded : undefined}
        data-desk-item=""
        data-desk-path={subdir}
        data-selected={selected ? 'true' : 'false'}
        style={{ '--tree-depth': depth } as CSSProperties}
        onClick={handleClick}
        onDoubleClick={openFile}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        tabIndex={selected ? 0 : -1}
        draggable
        onDragStart={handleDragStart}
        onDragOver={file.isDir ? handleDragOver : undefined}
        onDragLeave={file.isDir ? handleDragLeave : undefined}
        onDrop={file.isDir ? handleDrop : undefined}
      >
        <span className={s.treeIndent} aria-hidden="true" />
        <span className={s.treeDisclosure} aria-hidden="true">
          {file.isDir ? <TreeDisclosureIcon expanded={expanded} /> : null}
        </span>
        <span
          className={s.itemIcon}
          dangerouslySetInnerHTML={{
            __html: file.isDir
              ? (expanded ? ICONS.folderOpen : ICONS.folder)
              : getFileIcon(file.name),
          }}
        />
        {isRenaming ? (
          <RenameInput
            initialValue={file.name}
            onCommit={(newName) => void onCommitRename({ file, parent, subdir, depth }, newName)}
            onCancel={onCancelRename}
          />
        ) : (
          <span className={s.itemName} title={file.name}>{file.name}</span>
        )}
      </div>
      {expanded && (children.length > 0 || pendingChild) && (
        <div role="group" className={s.treeGroup}>
          {pendingChild && (
            <PendingCreateNode
              edit={pendingChild}
              depth={depth + 1}
              onCommit={onCommitCreate}
              onCancel={onCancelRename}
            />
          )}
          {sortDeskFiles(children, sortMode).filter(child => fileMatchesTypeFilters(child, typeFilters)).map(child => (
            <TreeNode
              key={childSubdir(subdir, child.name)}
              file={child}
              parent={subdir}
              depth={depth + 1}
              sortMode={sortMode}
              typeFilters={typeFilters}
              onShowMenu={onShowMenu}
              selectedPaths={selectedPaths}
              onSelect={onSelect}
              getDragEntries={getDragEntries}
              inlineEdit={inlineEdit}
              onInlineEditChange={onInlineEditChange}
              onStartCreate={onStartCreate}
              onBeginRename={onBeginRename}
              onCommitRename={onCommitRename}
              onCommitCreate={onCommitCreate}
              onCancelRename={onCancelRename}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function DeskTree({
  sortMode,
  typeFilters = [],
  onShowMenu,
  inlineEdit,
  onInlineEditChange,
  onStartCreate,
}: {
  sortMode: SortMode;
  typeFilters?: FileTypeFilter[];
  onShowMenu: (state: CtxMenuState) => void;
  inlineEdit: InlineTreeEdit;
  onInlineEditChange: Dispatch<SetStateAction<InlineTreeEdit>>;
  onStartCreate: (parentSubdir: string, kind: InlineCreateKind) => Promise<void>;
}) {
  const deskBasePath = useStore(s => s.deskBasePath);
  const rootFiles = useStore(s => s.deskTreeFilesByPath[''] || s.deskFiles);
  const treeFilesByPath = useStore(s => s.deskTreeFilesByPath);
  const expandedPaths = useStore(s => s.deskExpandedPaths);
  const deskSelectedPath = useStore(s => s.deskSelectedPath);
  const setDeskSelectedPath = useStore(s => s.setDeskSelectedPath);
  const activeTypeFilters = typeFilters;
  const treeRef = useRef<HTMLDivElement | null>(null);
  const localSelectionRef = useRef(false);
  const sortedRootFiles = useMemo(
    () => sortDeskFiles(rootFiles, sortMode).filter(file => fileMatchesTypeFilters(file, activeTypeFilters)),
    [rootFiles, sortMode, activeTypeFilters],
  );
  const visibleEntries = useMemo(
    () => collectVisibleTreeEntries(rootFiles, '', 0, sortMode, activeTypeFilters, expandedPaths, treeFilesByPath),
    [activeTypeFilters, expandedPaths, rootFiles, sortMode, treeFilesByPath],
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (!deskBasePath) return;
    void loadDeskTreeFiles('');
  }, [deskBasePath]);

  useEffect(() => {
    const visible = new Set(visibleEntries.map(entry => entry.subdir));
    setSelectedPaths(prev => {
      const next = new Set([...prev].filter(path => visible.has(path)));
      return next.size === prev.size ? prev : next;
    });
    setSelectionAnchor(prev => (prev && visible.has(prev) ? prev : null));
  }, [visibleEntries]);

  useEffect(() => {
    if (!deskSelectedPath) return;
    if (localSelectionRef.current) {
      localSelectionRef.current = false;
      return;
    }
    if (!visibleEntries.some(entry => entry.subdir === deskSelectedPath)) return;
    setSelectedPaths(new Set([deskSelectedPath]));
    setSelectionAnchor(deskSelectedPath);
  }, [deskSelectedPath, visibleEntries]);

  useEffect(() => {
    if (!deskSelectedPath) return;
    const root = treeRef.current;
    if (!root) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-desk-path]'))
      .find(el => el.getAttribute('data-desk-path') === deskSelectedPath);
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [deskSelectedPath, selectedPaths]);

  const selectTreePath = useCallback((subdir: string, meta: TreeSelectMeta) => {
    localSelectionRef.current = true;
    setDeskSelectedPath(subdir);
    if (meta.shift && selectionAnchor) {
      const anchorIndex = visibleEntries.findIndex(entry => entry.subdir === selectionAnchor);
      const currentIndex = visibleEntries.findIndex(entry => entry.subdir === subdir);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        setSelectedPaths(prev => {
          const next = meta.multi ? new Set(prev) : new Set<string>();
          for (let i = start; i <= end; i++) next.add(visibleEntries[i].subdir);
          return next;
        });
        return;
      }
    }

    if (meta.multi) {
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(subdir)) next.delete(subdir);
        else next.add(subdir);
        return next;
      });
      setSelectionAnchor(subdir);
      return;
    }

    setSelectedPaths(new Set([subdir]));
    setSelectionAnchor(subdir);
  }, [selectionAnchor, setDeskSelectedPath, visibleEntries]);

  const getDragEntries = useCallback((subdir: string): VisibleTreeEntry[] => {
    const entries = selectedPaths.has(subdir)
      ? visibleEntries.filter(entry => selectedPaths.has(entry.subdir))
      : visibleEntries.filter(entry => entry.subdir === subdir);
    return compactDragEntries(entries);
  }, [selectedPaths, visibleEntries]);

  const beginRename = useCallback((subdir: string) => {
    localSelectionRef.current = true;
    setSelectedPaths(new Set([subdir]));
    setSelectionAnchor(subdir);
    setDeskSelectedPath(subdir);
    onInlineEditChange({ mode: 'rename', targetSubdir: subdir });
  }, [onInlineEditChange, setDeskSelectedPath]);

  const cancelRename = useCallback(() => {
    onInlineEditChange(null);
  }, [onInlineEditChange]);

  const commitRename = useCallback(async (entry: VisibleTreeEntry, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === entry.file.name) {
      onInlineEditChange(null);
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      dispatchDeskNotice(window.t?.('desk.renameInvalid') || 'desk.renameInvalid');
      onInlineEditChange(null);
      return;
    }
    const ok = await deskRenameTreeItem(entry.parent, entry.file.name, trimmed, entry.file.isDir);
    if (!ok) {
      dispatchDeskNotice(window.t?.('desk.renameFailed') || 'desk.renameFailed');
      onInlineEditChange(null);
      return;
    }
    const nextSubdir = childSubdir(entry.parent, trimmed);
    localSelectionRef.current = true;
    setSelectedPaths(new Set([nextSubdir]));
    setSelectionAnchor(nextSubdir);
    setDeskSelectedPath(nextSubdir);
    onInlineEditChange(null);
  }, [onInlineEditChange, setDeskSelectedPath]);

  const commitCreate = useCallback(async (
    edit: Extract<NonNullable<InlineTreeEdit>, { mode: 'create' }>,
    nextName: string,
  ) => {
    const trimmed = nextName.trim();
    if (!trimmed) {
      onInlineEditChange(null);
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      dispatchDeskNotice(window.t?.('desk.renameInvalid') || 'desk.renameInvalid');
      onInlineEditChange(null);
      return;
    }
    onInlineEditChange(current => current === edit ? { ...edit, phase: 'saving' } : current);
    const ok = edit.kind === 'folder'
      ? await deskMkdirInSubdir(edit.parentSubdir, trimmed)
      : await deskCreateFileInSubdir(edit.parentSubdir, trimmed, edit.content);
    if (!ok) {
      dispatchDeskNotice(window.t?.('desk.createFailed') || 'desk.createFailed');
      onInlineEditChange(null);
      return;
    }
    const nextSubdir = childSubdir(edit.parentSubdir, trimmed);
    localSelectionRef.current = true;
    setSelectedPaths(new Set([nextSubdir]));
    setSelectionAnchor(nextSubdir);
    setDeskSelectedPath(nextSubdir);
    onInlineEditChange(null);
  }, [onInlineEditChange, setDeskSelectedPath]);

  const clearSelectionFromBlankSpace = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-desk-item]')) return;
    localSelectionRef.current = true;
    setSelectedPaths(new Set());
    setSelectionAnchor(null);
    onInlineEditChange(null);
    setDeskSelectedPath('');
  }, [onInlineEditChange, setDeskSelectedPath]);

  return (
    <div
      ref={treeRef}
      className={s.tree}
      role="tree"
      data-desk-tree=""
      data-empty-text={window.t?.('common.noFiles') || ''}
      onClick={clearSelectionFromBlankSpace}
    >
      {inlineEdit?.mode === 'create' && inlineEdit.parentSubdir === '' && (
        <PendingCreateNode
          edit={inlineEdit}
          depth={0}
          onCommit={commitCreate}
          onCancel={cancelRename}
        />
      )}
      {sortedRootFiles.map(file => (
        <TreeNode
          key={file.name}
          file={file}
          parent=""
          depth={0}
          sortMode={sortMode}
          typeFilters={activeTypeFilters}
          onShowMenu={onShowMenu}
          selectedPaths={selectedPaths}
          onSelect={selectTreePath}
          getDragEntries={getDragEntries}
          inlineEdit={inlineEdit}
          onInlineEditChange={onInlineEditChange}
          onStartCreate={onStartCreate}
          onBeginRename={beginRename}
          onCommitRename={commitRename}
          onCommitCreate={commitCreate}
          onCancelRename={cancelRename}
        />
      ))}
    </div>
  );
}
