import { copyTextToClipboard } from '../../utils/clipboard';
/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { Component, memo, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { StreamingMarkdownContent } from './StreamingMarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { PluginCardBlock } from './PluginCardBlock';
import { SubagentCard } from './SubagentCard';
import { WorkflowInlineCard } from './WorkflowInlineCard';
import { InterludeBlock } from './InterludeBlock';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { SettingsUpdateCard } from './SettingsUpdateCard';
import { InteractiveCard } from './InteractiveCard';
import { SessionCollabDraftCard } from './SessionCollabDraftCard';
import { useMessageFooterActions } from './MessageActions';
import { MessageFooterActions, formatMessageTime } from './MessageFooterActions';
import { ChatResourceCard } from './ChatResourceCard';
import { FileResourceIcon, SkillResourceIcon } from './ChatResourceIcons';
import { BLOCK_RENDERERS } from './block-renderers';
import { FileOutputActions } from './FileOutputActions';
const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { selectSessionFiles } from '../../stores/selectors/file-refs';
import { sessionIdForPathFromLocatorState } from '../../stores/session-slice';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { writeAppFileDragPayload, clearAppFileDragPayload } from '../../utils/app-file-drag';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { buildFileRefId, inferKindByExt, isImageOrSvgExt } from '../../utils/file-kind';
import { resolveServerConnection } from '../../services/server-connection';
import { resolveFileRefUrl } from '../../services/resource-url';
import type { FileRef } from '../../types/file-ref';
import { openPreview } from '../../stores/preview-actions';
import type { ForkedSessionHandler, SessionNodeTarget } from '../../stores/message-turn-actions';
import { selectSelectedIdsBySession } from '../../stores/session-selectors';
import { normalizeSessionRouteError } from '../../../../../shared/error-user-messages.ts';
import { extractSelectedTexts, extractTextBlockPlainText } from '../../utils/message-text';
import { AgentAvatar, resolveAgentDisplayInfo, type AgentDisplayInfo } from '../../utils/agent-display';
import { ScheduleEditor } from '../automation/ScheduleEditor';
import { SelectWidget, type SelectOption } from '@/ui';
import { useSessionNodeActions } from './SessionNodeActions';
import {
  scheduleDraftFromStored,
  schedulePreviewFromDraft,
  storedScheduleFromDraft,
  type ScheduleDraft,
} from '../automation/schedule-draft';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  agentDisplay: AgentDisplayInfo & { yuan: string };
  isStreaming: boolean;
  isSelected: boolean;
  isLatestAssistantMessage?: boolean;
  showTurnCompletionTime?: boolean;
  assistantTurnSelectionIds?: readonly string[];
  turnTarget?: SessionNodeTarget | null;
  retrySourceMessage?: ChatMessage | null;
  onForkCreated?: ForkedSessionHandler;
  messageRef?: (element: HTMLDivElement | null) => void;
}

function isContentBlockCandidate(block: unknown): block is ContentBlock {
  return !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string';
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  showAvatar,
  sessionPath,
  agentId,
  readOnly = false,
  agentDisplay,
  isStreaming,
  isSelected,
  isLatestAssistantMessage = false,
  showTurnCompletionTime = false,
  assistantTurnSelectionIds,
  turnTarget = null,
  retrySourceMessage = null,
  onForkCreated,
  messageRef,
}: Props) {
  const displayInfo = agentDisplay;
  const displayName = agentDisplay.displayName;
  const displayYuan = agentDisplay.yuan;

  const blocks = useMemo(
    () => (message.blocks || [])
      .filter(isContentBlockCandidate)
      .filter(block => block.type !== 'session_confirmation' || block.surface !== 'input'),
    [message.blocks],
  );
  const isInterludeOnly = blocks.length > 0 && blocks.every(block => block.type === 'interlude');
  const hasWideBlock = blocks.some(b => b.type === 'interactive_card');

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const ids = selectSelectedIdsBySession(useStore.getState(), sessionPath);
    let text: string;
    if (ids.length > 0) {
      text = extractSelectedTexts(sessionPath, ids);
    } else {
      const textBlocks = blocks.filter(
        (b): b is ContentBlock & { type: 'text' } => b.type === 'text'
      );
      if (textBlocks.length === 0) return;
      text = extractTextBlockPlainText(textBlocks);
    }
    if (!text) return;
    copyTextToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [blocks, sessionPath]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id, sessionPath);
  }, [message.id, sessionPath]);

  const { actions: nodeActions, busy: nodeActionBusy } = useSessionNodeActions({
    sessionPath,
    target: readOnly || !showTurnCompletionTime ? null : turnTarget,
    retryMessage: retrySourceMessage || undefined,
    onForkCreated,
    disabled: isStreaming,
  });
  const canShowNodeActions = !readOnly && showTurnCompletionTime && !!turnTarget && !isStreaming;
  const shouldPersistCompletionTime = showTurnCompletionTime && isLatestAssistantMessage && !isStreaming;
  const timeText = showTurnCompletionTime && !isStreaming ? formatMessageTime(message.timestamp) : null;
  const standardMessageActions = useMessageFooterActions({
    messageId: message.id,
    selectionIds: assistantTurnSelectionIds,
    sessionPath,
    onCopy: handleCopy,
    onScreenshot: () => { void handleScreenshot(); },
    copied,
    isStreaming: isStreaming || nodeActionBusy,
  });
  const messageActions = readOnly || !showTurnCompletionTime || isStreaming ? [] : standardMessageActions;
  const footerActions = canShowNodeActions ? nodeActions : [];

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}${isInterludeOnly ? ` ${styles.messageGroupInterludeOnly}` : ''}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
         ref={messageRef}
         data-message-id={message.id}>
      {showAvatar && !isInterludeOnly && (
        <div className={styles.avatarRow}>
          <AgentAvatar
            info={displayInfo}
            className={`${styles.avatar} ${styles.hanaAvatar}`}
            alt={displayName}
          />
          <span className={styles.avatarName}>{displayName}</span>
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}${hasWideBlock ? ` ${styles.messageHasWideBlock}` : ''}${isInterludeOnly ? ` ${styles.messageAssistantInterludeOnly}` : ''}`}>
        {blocks.map((block, i) => (
          <ContentBlockErrorBoundary
            key={`block-${i}`}
            messageId={message.id}
            blockType={block.type}
            blockIdx={i}
          >
            <ContentBlockView
              block={block}
              agentName={displayName}
              agentId={agentId}
              yuan={displayYuan}
              sessionPath={sessionPath}
              messageId={message.id}
              blockIdx={i}
              isStreaming={isStreaming}
              readOnly={readOnly}
            />
          </ContentBlockErrorBoundary>
        ))}
      </div>
      {!isInterludeOnly && (timeText || footerActions.length > 0 || messageActions.length > 0) && (
        <MessageFooterActions
          align="left"
          timeText={timeText}
          timePersistent={shouldPersistCompletionTime}
          leadingActions={footerActions}
          actions={messageActions}
          testId="assistant-completion-actions"
        />
      )}
    </div>
  );
});

class ContentBlockErrorBoundary extends Component<{
  messageId: string;
  blockType: string;
  blockIdx: number;
  children: ReactNode;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AssistantMessage] content block render failed', {
      messageId: this.props.messageId,
      blockType: this.props.blockType,
      blockIdx: this.props.blockIdx,
      componentStack: info.componentStack,
    }, error);
  }

  componentDidUpdate(prevProps: Readonly<{ messageId: string; blockType: string; blockIdx: number; children: ReactNode }>) {
    if (!this.state.hasError) return;
    if (
      prevProps.messageId !== this.props.messageId ||
      prevProps.blockIdx !== this.props.blockIdx ||
      prevProps.blockType !== this.props.blockType
    ) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, agentId, yuan: _yuan, sessionPath, messageId, blockIdx, isStreaming, readOnly }: {
  block: ContentBlock;
  agentName: string;
  agentId?: string | null;
  yuan: string;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
  isStreaming: boolean;
  readOnly: boolean;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} collapsed={block.collapsed} agentName={agentName} />;
    case 'text':
      return <StreamingMarkdownContent html={block.html} source={block.source} active={isStreaming} linkContext={{ origin: 'session', sessionPath, messageId, blockIdx }} />;
    case 'file':
      return (
        <FileBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    case 'screenshot':
      return (
        <ScreenshotBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    case 'media_generation':
      return <MediaGenerationBlock block={block} sessionPath={sessionPath} readOnly={readOnly} />;
    case 'interlude':
      return <InterludeBlock block={block} />;
    default: {
      const Renderer = BLOCK_RENDERERS[block.type];
      return Renderer ? <Renderer block={block} agentId={agentId} sessionPath={sessionPath} /> : null;
    }
  }
});

// ── 简单子块组件（物种 B，统一接受 { block: any }） ──

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', cpp: 'C++', h: 'Header', sh: 'Shell', sql: 'SQL', xml: 'XML',
  csv: 'CSV', svg: 'SVG', skill: 'Skill',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
};

const MediaGenerationBlock = memo(function MediaGenerationBlock({ block, sessionPath, readOnly }: { block: any; sessionPath: string; readOnly: boolean }) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [localBlock, setLocalBlock] = useState<any | null>(null);
  const t = window.t ?? ((k: string) => k);
  const viewBlock = localBlock?.taskId === block.taskId ? { ...block, ...localBlock } : block;
  const failed = viewBlock.status === 'failed' || viewBlock.status === 'aborted';
  const kindLabel = viewBlock.kind === 'video' ? t('chat.media.kindVideo') : t('chat.media.kindImage');
  const canRetry = failed && viewBlock.kind !== 'video' && !readOnly && typeof viewBlock.taskId === 'string';
  const titleText = failed
    ? t('chat.media.generationFailed').replace('{kind}', kindLabel)
    : t('chat.media.generationInProgress').replace('{kind}', kindLabel);
  const reason = retryError || (typeof viewBlock.reason === 'string' ? viewBlock.reason : '');
  const prompt = typeof viewBlock.prompt === 'string' ? viewBlock.prompt : '';

  useEffect(() => {
    setLocalBlock(null);
    setRetrying(false);
    setRetryError('');
  }, [block]);

  const handleRetry = useCallback(async () => {
    if (!canRetry || retrying) return;
    setRetrying(true);
    setRetryError('');
    try {
      const res = await hanaFetch(`/api/media/tasks/${encodeURIComponent(viewBlock.taskId)}/retry`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => null);
      const placeholder = data?.placeholder || {
        type: 'media_generation',
        taskId: viewBlock.taskId,
        kind: 'image',
        status: 'pending',
        ...(prompt ? { prompt } : {}),
      };
      setLocalBlock(placeholder);
      useStore.getState().resolveBlockByTaskId(sessionPath, viewBlock.taskId, placeholder);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : t('chat.media.retryFailed'));
      setRetrying(false);
    }
  }, [canRetry, prompt, retrying, sessionPath, viewBlock.taskId]);

  return (
    <div className={`${styles.mediaGenerationCard}${failed ? ` ${styles.mediaGenerationCardFailed}` : ''}`}>
      <div className={styles.mediaGenerationSurface}>
        <div className={styles.mediaGenerationText}>
          <div className={styles.mediaGenerationTitle} aria-label={failed ? titleText : `${titleText}...`}>
            <span>{titleText}</span>
            {!failed && <span className={styles.mediaGenerationDots} aria-hidden="true" />}
          </div>
          {(failed ? reason : prompt) && (
            <div className={styles.mediaGenerationPrompt}>{failed ? reason : prompt}</div>
          )}
          {canRetry && (
            <button
              type="button"
              className={styles.mediaGenerationRetryButton}
              onClick={handleRetry}
              disabled={retrying}
              aria-label={t('chat.media.retryLabel').replace('{kind}', kindLabel)}
            >
              {retrying ? t('chat.media.submitting') : t('common.regenerate')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// file / image block

interface FileBlockCtx {
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}

const ImageOutputCard = memo(function ImageOutputCard({ fileId, filePath, label, ext, status, ctx }: { fileId?: string; filePath: string; label: string; ext: string; status?: string; ctx: FileBlockCtx }) {
  const [failed, setFailed] = useState(false);
  const displayName = label || filePath.split('/').pop() || filePath;
  const imageSrc = useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = files.find(file => (fileId && file.fileId === fileId) || file.path === filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label: displayName, ext, kind: ext.toLowerCase() === 'svg' ? 'svg' : 'image', ctx });
    try {
      return resolveFileRefUrl(ref, {
        connection: resolveServerConnection(state),
        platform: window.platform,
      }).url;
    } catch {
      return '';
    }
  }, [ctx, displayName, ext, fileId, filePath]));
  const downloadUrl = useSessionFileDownloadUrl({
    fileId,
    filePath,
    label: displayName,
    ext,
    kind: ext.toLowerCase() === 'svg' ? 'svg' : 'image',
    ctx,
  });

  const handleDragStart = useCallback((event: React.DragEvent) => {
    const payload = writeAppFileDragPayload(event.dataTransfer, {
      source: 'session-file',
      files: [{
        id: fileId || filePath,
        fileId,
        name: displayName,
        path: filePath,
      }],
    });
    event.currentTarget.addEventListener('dragend', () => clearAppFileDragPayload(payload.dragId), { once: true });
    if (filePath) {
      event.preventDefault();
      window.platform?.startDrag?.(filePath);
    }
  }, [fileId, filePath, displayName]);

  if (status === 'expired') return <FileOutputCard filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;
  if (failed) return <FileOutputCard filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;

  return (
    <div
      className={styles.imageOutputCard}
      draggable
      onDragStart={handleDragStart}
      onClick={() => openFilePreview(filePath, label, ext, {
        origin: 'session',
        sessionPath: ctx.sessionPath,
        messageId: ctx.messageId,
        fileId,
        blockIdx: ctx.blockIdx,
      })}
      style={{ cursor: 'default' }}
    >
      {downloadUrl && (
        <a
          className={styles.imageOutputDownloadButton}
          href={downloadUrl}
          download={displayName}
          draggable={false}
          aria-label={`${window.t('chat.fileActions.downloadToDevice')} ${displayName}`}
          title={window.t('chat.fileActions.downloadToDevice')}
          onClick={(event) => event.stopPropagation()}
        >
          <DownloadGlyph />
        </a>
      )}
      <img
        src={imageSrc}
        alt={displayName}
        className={styles.imageOutputPreview}
        onError={() => setFailed(true)}
        draggable={false}
      />
    </div>
  );
});

const VideoOutputCard = memo(function VideoOutputCard({ fileId, filePath, label, ext, status, ctx }: { fileId?: string; filePath: string; label: string; ext: string; status?: string; ctx: FileBlockCtx }) {
  const [failed, setFailed] = useState(false);
  const displayName = label || filePath.split('/').pop() || filePath;
  const videoSrc = useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = files.find(file => (fileId && file.fileId === fileId) || file.path === filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label: displayName, ext, kind: 'video', ctx });
    try {
      return resolveFileRefUrl(ref, {
        connection: resolveServerConnection(state),
        platform: window.platform,
      }).url;
    } catch {
      return '';
    }
  }, [ctx, displayName, ext, fileId, filePath]));
  const downloadUrl = useSessionFileDownloadUrl({
    fileId,
    filePath,
    label: displayName,
    ext,
    kind: 'video',
    ctx,
  });

  const handleDragStart = useCallback((event: React.DragEvent) => {
    const payload = writeAppFileDragPayload(event.dataTransfer, {
      source: 'session-file',
      files: [{
        id: fileId || filePath,
        fileId,
        name: displayName,
        path: filePath,
      }],
    });
    event.currentTarget.addEventListener('dragend', () => clearAppFileDragPayload(payload.dragId), { once: true });
    if (filePath) {
      event.preventDefault();
      window.platform?.startDrag?.(filePath);
    }
  }, [fileId, filePath, displayName]);

  if (status === 'expired') return <FileOutputCard filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;
  if (failed) return <FileOutputCard filePath={filePath} label={label} ext={ext} status={status} ctx={ctx} />;

  return (
    <div
      className={`${styles.imageOutputCard} ${styles.videoOutputCard}`}
      data-testid="video-output-card"
      draggable
      onDragStart={handleDragStart}
      onClick={() => openFilePreview(filePath, label, ext, {
        origin: 'session',
        sessionPath: ctx.sessionPath,
        messageId: ctx.messageId,
        fileId,
        blockIdx: ctx.blockIdx,
      })}
      style={{ cursor: 'default' }}
      aria-label={displayName}
    >
      {downloadUrl && (
        <a
          className={styles.imageOutputDownloadButton}
          href={downloadUrl}
          download={displayName}
          draggable={false}
          aria-label={`${window.t('chat.fileActions.downloadToDevice')} ${displayName}`}
          title={window.t('chat.fileActions.downloadToDevice')}
          onClick={(event) => event.stopPropagation()}
        >
          <DownloadGlyph />
        </a>
      )}
      <video
        src={videoSrc}
        className={styles.videoOutputPreview}
        preload="metadata"
        muted
        playsInline
        onError={() => setFailed(true)}
        draggable={false}
      />
      <span className={styles.videoOutputPlayBadge} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
    </div>
  );
});

function DownloadGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function buildFallbackSessionFileRef({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
}): FileRef {
  return {
    id: buildFileRefId({
      source: 'session-block-file',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      blockIdx: ctx.blockIdx,
      path: filePath,
    }),
    fileId,
    kind,
    source: 'session-block-file',
    name: label,
    path: filePath,
    ext,
    sessionMessageId: ctx.messageId,
    sessionBlockIdx: ctx.blockIdx,
  };
}

const FileOutputCard = memo(function FileOutputCard({ fileId, filePath, label, ext, status, ctx }: { fileId?: string; filePath: string; label: string; ext: string; status?: string; ctx: FileBlockCtx }) {
  const expired = status === 'expired';
  const expiredLabel = window.t('chat.fileExpired');
  const displayName = label || filePath.split('/').pop() || filePath;
  const downloadUrl = useSessionFileDownloadUrl({
    fileId,
    filePath,
    label: displayName,
    ext,
    kind: 'other',
    ctx,
  });
  const handlePreview = () => {
    if (expired) return;
    openFilePreview(filePath, label, ext, {
      origin: 'session',
      sessionPath: ctx.sessionPath,
      messageId: ctx.messageId,
      fileId,
      blockIdx: ctx.blockIdx,
    });
  };

  const typeLabel = EXT_LABELS[ext] || ext.toUpperCase();

  return (
    <ChatResourceCard
      icon={<FileResourceIcon />}
      title={displayName}
      subtitle={ext ? `${typeLabel} \u00b7 ${ext.toUpperCase()}` : typeLabel}
      statusLabel={expired ? expiredLabel : undefined}
      statusTone={expired ? 'muted' : 'neutral'}
      disabled={expired}
      onClick={expired ? undefined : handlePreview}
      ariaLabel={displayName}
      actionSlot={!expired && (
        <FileOutputActions
          filePath={filePath}
          displayName={displayName}
          downloadUrl={downloadUrl}
          downloadName={displayName}
        />
      )}
    />
  );
});

function useSessionFileDownloadUrl({
  fileId,
  filePath,
  label,
  ext,
  kind,
  ctx,
}: {
  fileId?: string;
  filePath: string;
  label: string;
  ext: string;
  kind: FileRef['kind'];
  ctx: FileBlockCtx;
}): string | null {
  return useStore(useCallback((state) => {
    const files = selectSessionFiles(state, ctx.sessionPath);
    const ref = files.find(file => (fileId && file.fileId === fileId) || file.path === filePath)
      ?? buildFallbackSessionFileRef({ fileId, filePath, label, ext, kind, ctx });
    if (ref.status === 'expired') return null;
    try {
      const resolved = resolveFileRefUrl(ref, {
        connection: resolveServerConnection(state),
        platform: typeof window !== 'undefined' ? window.platform : null,
        preferLocalFile: false,
      });
      if (resolved.mode === 'local-file') return null;
      return resolved.url;
    } catch {
      return null;
    }
  }, [ctx, ext, fileId, filePath, kind, label]));
}

const FileBlock = memo(function FileBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  const ctx: FileBlockCtx = { sessionPath, messageId, blockIdx };
  // 扩展名识别统一走中心表（inferKindByExt via isImageOrSvgExt）
  const kind = inferKindByExt(block.ext);
  if (isImageOrSvgExt(block.ext)) {
    return <ImageOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
  }
  if (kind === 'video') {
    return <VideoOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
  }
  return <FileOutputCard fileId={block.fileId} filePath={block.filePath} label={block.label} ext={block.ext} status={block.status} ctx={ctx} />;
});

// COMPAT(create_artifact, remove no earlier than v0.133):
// Old sessions may still contain `artifact` content blocks. New preview
// surface consumes them as PreviewItem records.

const LegacyArtifactBlock = memo(function LegacyArtifactBlock({ block }: { block: any }) {
  const handleClick = () => {
    const previewItem = {
      id: block.artifactId,
      type: block.artifactType,
      title: block.title,
      content: block.content,
      language: block.language,
      fileId: block.fileId,
      filePath: block.filePath,
      ext: block.ext,
      mime: block.mime,
      kind: block.kind,
      storageKind: block.storageKind,
      status: block.status,
      missingAt: block.missingAt,
    };
    openPreview(previewItem);
  };
  const expired = block.status === 'expired';

  return (
    <div className={styles.legacyArtifactCard} onClick={handleClick} style={{ cursor: 'default' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{block.title || block.artifactType}</span>
      {expired && <span className={styles.legacyArtifactExpiredBadge}>{window.t('chat.fileExpired')}</span>}
    </div>
  );
});

// plugin_card block

const PluginCardWrapper = memo(function PluginCardWrapper({ block, agentId }: { block: any; agentId?: string | null }) {
  return <PluginCardBlock card={block.card} agentId={agentId} />;
});

// screenshot block

const ScreenshotBlock = memo(function ScreenshotBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  // screenshot 无 path 但 id 由 buildFileRefId 生成，与 selectSessionFiles 一致，能命中 session 图片序列
  const handleClick = () => {
    const id = buildFileRefId({
      source: 'session-block-screenshot',
      sessionPath,
      messageId,
      blockIdx,
      path: '',
    });
    openMediaViewerForRef({
      id,
      kind: 'image',
      source: 'session-block-screenshot',
      name: `screenshot-${messageId}-${blockIdx}.png`,
      path: '',
      mime: block.mimeType,
      sessionMessageId: messageId,
      inlineData: { base64: block.base64, mimeType: block.mimeType },
    }, { origin: 'session', sessionPath });
  };

  return (
    <div className={styles.browserScreenshot} onClick={handleClick} style={{ cursor: 'default' }}>
      <img
        src={`data:${block.mimeType};base64,${block.base64}`}
        alt={window.t('chat.browserScreenshot')}
      />
    </div>
  );
});

// skill block

const SkillBlock = memo(function SkillBlock({ block }: { block: any }) {
  const skillFilePath = typeof block.installedSkillSource?.filePath === 'string'
    ? block.installedSkillSource.filePath
    : (typeof block.skillFilePath === 'string' ? block.skillFilePath : '');
  return (
    <ChatResourceCard
      icon={<SkillResourceIcon />}
      title={block.skillName}
      subtitle="Skill"
      onClick={() => openSkillPreview(block.skillName, skillFilePath, block.installedSkillSource)}
      ariaLabel={block.skillName}
    />
  );
});

// cron_confirm block

function automationRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function defaultAutomationAgentId(agents: any[], currentAgentId: string | null, draftAgentId: string | null) {
  return draftAgentId
    || currentAgentId
    || agents.find((agent: any) => agent?.isPrimary)?.id
    || agents[0]?.id
    || null;
}

class AutomationSubmissionError extends Error {}

function buildAutomationExecutionContext({
  agent,
  agentId,
  baseContext,
  sessionPath,
}: {
  agent: any;
  agentId: string | null;
  baseContext: Record<string, any>;
  sessionPath?: string;
}) {
  const homeFolder = typeof agent?.homeFolder === 'string' && agent.homeFolder.trim()
    ? agent.homeFolder.trim()
    : null;
  const baseAgentId = typeof baseContext.createdByAgentId === 'string' && baseContext.createdByAgentId.trim()
    ? baseContext.createdByAgentId.trim()
    : null;
  const crossesAgentBoundary = !!baseAgentId && !!agentId && baseAgentId !== agentId;
  return {
    kind: typeof baseContext.kind === 'string' && baseContext.kind.trim()
      ? baseContext.kind
      : 'session_workspace',
    cwd: homeFolder || (typeof baseContext.cwd === 'string' && baseContext.cwd.trim() ? baseContext.cwd : null),
    workspaceFolders: homeFolder
      ? [homeFolder]
      : (Array.isArray(baseContext.workspaceFolders)
        ? baseContext.workspaceFolders.filter((folder: unknown) => typeof folder === 'string' && folder.trim())
        : []),
    authorizedFolders: crossesAgentBoundary
      ? []
      : (Array.isArray(baseContext.authorizedFolders)
        ? baseContext.authorizedFolders.filter((folder: unknown) => typeof folder === 'string' && folder.trim())
        : []),
    sourceSessionId: crossesAgentBoundary ? null : (baseContext.sourceSessionId || null),
    sourceBridgeSessionKey: crossesAgentBoundary ? null : (baseContext.sourceBridgeSessionKey || null),
    sourceSessionPath: crossesAgentBoundary
      ? null
      : typeof baseContext.sourceSessionPath === 'string' && baseContext.sourceSessionPath.trim()
        ? baseContext.sourceSessionPath
        : (sessionPath || null),
    createdByAgentId: agentId || null,
  };
}

const CronConfirmBlock = memo(function CronConfirmBlock({ block, sessionPath }: { block: any; sessionPath?: string }) {
  const [status, setStatus] = useState(block.status);
  const [modalOpen, setModalOpen] = useState(false);
  const isSuggestionCard = block.type === 'suggestion_card';
  const isAutomationSuggestion = block.type !== 'suggestion_card'
    || block.kind === 'automation_draft'
    || block.detail?.kind === 'automation_draft';
  const jobData = block.jobData || block.detail?.jobData || {};
  const operation = block.operation || block.detail?.operation || 'create';
  const confirmLabelKey = operation === 'update' ? 'automation.confirmUpdate' : 'automation.confirmCreate';
  const initialType = (jobData.type || jobData.scheduleType || 'cron') as string;
  const agents = useStore(s => s.agents);
  const addToast = useStore(s => s.addToast);
  const currentAgentId = useStore(s => s.currentAgentId);
  const sourceSessionId = useStore(state => sessionIdForPathFromLocatorState(state, sessionPath));
  const fallbackAgentName = useStore(s => s.agentName) || 'Hanako';
  const fallbackAgentYuan = useStore(s => s.agentYuan) || 'hanako';
  const initialPrompt = (jobData.prompt as string) || (block.description as string) || '';
  const [draftLabel, setDraftLabel] = useState((jobData.label as string) || (block.title as string) || initialPrompt.slice(0, 40) || '');
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleDraftFromStored(initialType, jobData.schedule));
  const [draftPrompt, setDraftPrompt] = useState(initialPrompt);
  const [submitting, setSubmitting] = useState(false);
  const label = draftLabel || (draftPrompt || '').slice(0, 40) || '';
  const schedulePreview = schedulePreviewFromDraft(scheduleDraft);
  const pending = status === 'pending';
  const canOpenDraft = isSuggestionCard || pending;
  const draftAgentId = typeof jobData.actorAgentId === 'string' && jobData.actorAgentId.trim()
    ? jobData.actorAgentId.trim()
    : typeof jobData.executor?.agentId === 'string' && jobData.executor.agentId.trim()
      ? jobData.executor.agentId.trim()
      : typeof block.target?.id === 'string' && block.target.id.trim()
        ? block.target.id.trim()
        : null;
  const initialAgentId = defaultAutomationAgentId(agents, currentAgentId, draftAgentId);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId);
  const effectiveAgentId = selectedAgentId || initialAgentId;
  const selectedAgent = agents.find((agent: any) => agent.id === effectiveAgentId) || null;
  const agentInfo = resolveAgentDisplayInfo({
    id: effectiveAgentId,
    agents,
    fallbackAgentName,
    fallbackAgentYuan,
  });

  useEffect(() => {
    setStatus(block.status);
  }, [block.status]);

  useEffect(() => {
    if (effectiveAgentId && agents.some((agent: any) => agent.id === effectiveAgentId)) return;
    setSelectedAgentId(initialAgentId);
  }, [agents, effectiveAgentId, initialAgentId]);

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  if (!isAutomationSuggestion) {
    return (
      <ChatResourceCard
        icon={<AutomationDraftIcon />}
        title={block.title || window.t('automation.suggestionTitle')}
        subtitle={block.description}
        statusLabel={status && status !== 'pending' ? status : undefined}
        statusTone={status === 'rejected' ? 'muted' : 'accent'}
        className={styles.automationDraftCard}
      />
    );
  }

  const buildDraftJobData = () => {
    const nextSchedule = storedScheduleFromDraft(scheduleDraft);
    const baseExecutor = automationRecord(jobData.executor);
    const model = jobData.model ?? baseExecutor.model ?? '';
    const executionContext = buildAutomationExecutionContext({
      agent: selectedAgent,
      agentId: effectiveAgentId,
      baseContext: automationRecord(jobData.executionContext || baseExecutor.executionContext),
      sessionPath,
    });
    return {
      ...jobData,
      type: nextSchedule.type,
      schedule: nextSchedule.schedule,
      label: draftLabel,
      prompt: draftPrompt,
      model,
      actorAgentId: effectiveAgentId,
      executionContext,
      executor: {
        ...baseExecutor,
        kind: 'agent_session',
        agentId: effectiveAgentId,
        prompt: draftPrompt,
        model,
        executionContext,
      },
    };
  };

  const submitDraftJob = async (editedJobData: Record<string, unknown>) => {
    if (isSuggestionCard) {
      const suggestionId = block.suggestionId || block.detail?.suggestionId;
      if (typeof suggestionId !== 'string' || !suggestionId.trim() || !sourceSessionId) {
        throw new Error('automation suggestion identity unavailable');
      }
      const response = await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'apply_suggestion',
          suggestionId: suggestionId.trim(),
          sessionId: sourceSessionId,
          jobData: {
            type: editedJobData.type,
            schedule: editedJobData.schedule,
            label: editedJobData.label,
            prompt: editedJobData.prompt,
            model: editedJobData.model,
            ...(effectiveAgentId ? { targetAgentId: effectiveAgentId } : {}),
          },
        }),
        throwOnHttpError: false,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new AutomationSubmissionError(normalizeSessionRouteError(body).message);
      }
      return;
    }
    const isUpdate = operation === 'update';
    const { id, ...fields } = editedJobData;
    const response = await hanaFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isUpdate
        ? { action: 'update', id, ...fields }
        : { action: 'add', ...editedJobData }),
      throwOnHttpError: false,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new AutomationSubmissionError(normalizeSessionRouteError(body).message);
    }
  };

  const handleApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const editedJobData = buildDraftJobData();
      if (isSuggestionCard) {
        await submitDraftJob(editedJobData);
      } else if (block.confirmId) {
        await hanaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirmed', value: { jobData: editedJobData } }),
        });
      } else {
        await submitDraftJob(editedJobData);
      }
      setStatus('approved');
      setModalOpen(false);
    } catch (err) {
      const prefix = window.t('automation.createFailed');
      const detail = err instanceof AutomationSubmissionError ? err.message.trim() : '';
      addToast(detail ? `${prefix}: ${detail}` : prefix, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (isSuggestionCard) {
      setModalOpen(false);
      return;
    }
    if (block.confirmId) {
      try {
        await hanaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rejected' }),
        });
      } catch { /* silent */ }
    }
    setStatus('rejected');
    setModalOpen(false);
  };

  const card = (
    <ChatResourceCard
      icon={<AutomationDraftIcon />}
      title={label || window.t('automation.draftTitle')}
      titleMeta={!isSuggestionCard && pending ? window.t('automation.suggested') : undefined}
      titleTail={isSuggestionCard ? window.t('automation.viewSuggestion') : undefined}
      subtitle={`${agentInfo.displayName} · ${schedulePreview}`}
      statusLabel={!isSuggestionCard && !pending ? (status === 'approved' ? window.t('common.approved') : window.t('common.rejected')) : undefined}
      statusTone={!isSuggestionCard && !pending ? (status === 'approved' ? 'success' : 'muted') : 'accent'}
      onClick={canOpenDraft ? () => setModalOpen(true) : undefined}
      ariaLabel={window.t('automation.openDraft')}
      className={styles.automationDraftCard}
    />
  );

  const modal = canOpenDraft && modalOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        className={styles.automationDraftOverlay}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setModalOpen(false);
        }}
      >
        <div className={styles.automationDraftModal} role="dialog" aria-modal="true" aria-label={window.t('automation.draftTitle')}>
          <div className={styles.automationDraftHeader}>
            <input
              className={styles.automationDraftTitleInput}
              value={draftLabel}
              onChange={e => setDraftLabel(e.target.value)}
              placeholder={window.t('automation.draftTitle')}
              spellCheck={false}
            />
            <button className={styles.automationDraftIconButton} type="button" title={window.t('automation.closeDraft')} onClick={() => setModalOpen(false)}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <textarea
            className={styles.automationDraftPrompt}
            value={draftPrompt}
            onChange={e => setDraftPrompt(e.target.value)}
            placeholder={window.t('automation.promptPlaceholder', { agent: agentInfo.displayName })}
            aria-label={window.t('automation.field.prompt')}
            spellCheck={false}
          />
          <div className={styles.automationDraftFooter}>
            <ScheduleEditor draft={scheduleDraft} onChange={setScheduleDraft} className={styles.automationDraftSchedule} />
            <label className={styles.automationDraftField}>
              <span>{window.t('automation.field.agent')}</span>
              <SelectWidget
                className={styles.automationDraftAgentSelect}
                triggerClassName={styles.automationDraftControlButton}
                popupClassName={styles.automationDraftAgentPopup}
                value={effectiveAgentId || ''}
                options={agents.map((agent: any): SelectOption => ({
                  value: agent.id,
                  label: agent.name || agent.id,
                }))}
                onChange={(value) => setSelectedAgentId(value)}
                align="start"
                placement="top"
                density="comfortable"
                renderTrigger={(_option, isOpen) => (
                  <>
                    <AgentAvatar info={agentInfo} className={styles.automationDraftAgentAvatar} />
                    <span className={styles.automationDraftAgentName}>{agentInfo.displayName}</span>
                    <svg className={styles.automationDraftControlArrow} data-open={isOpen} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </>
                )}
                renderOption={(option, selected) => {
                  const info = resolveAgentDisplayInfo({
                    id: option.value,
                    agents,
                    fallbackAgentName: option.label,
                  });
                  return (
                    <span className={styles.automationDraftAgentOption} data-selected={selected}>
                      <AgentAvatar info={info} className={styles.automationDraftAgentAvatar} />
                      <span>{info.displayName}</span>
                    </span>
                  );
                }}
              />
            </label>
            <div className={styles.automationDraftActions}>
              <button className={styles.automationDraftTextButton} type="button" onClick={handleReject} disabled={submitting}>{window.t('common.cancel')}</button>
              <button className={styles.automationDraftPrimaryButton} type="button" onClick={handleApprove} disabled={submitting} aria-busy={submitting}>{window.t(confirmLabelKey)}</button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      {card}
      {modal}
    </>
  );
});

// suggestion_card 分发：session 协作草稿（send / create）走 SessionCollabDraftCard，
// 其余（automation_draft 等）沿用既有 CronConfirmBlock。BLOCK_RENDERERS 是「组件引用」表，
// 保持表结构不变，只把 'suggestion_card' 注册成这个小分发器。
const SuggestionCardDispatch = memo(function SuggestionCardDispatch({ block, sessionPath }: { block: any; sessionPath?: string }) {
  if (block.kind === 'session_send_draft' || block.kind === 'session_create_draft') {
    return <SessionCollabDraftCard block={block} sessionPath={sessionPath} />;
  }
  return <CronConfirmBlock block={block} sessionPath={sessionPath} />;
});

function AutomationDraftIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
      <path d="M6.5 5.5 5 4" />
      <path d="M17.5 5.5 19 4" />
    </svg>
  );
}

// settings_confirm block

const SettingsConfirmBlock = memo(function SettingsConfirmBlock({ block }: { block: any }) {
  return <SettingsConfirmCard {...block} />;
});

const SettingsUpdateBlock = memo(function SettingsUpdateBlock({ block }: { block: any }) {
  return <SettingsUpdateCard update={block.update} />;
});

// ── 注册所有物种 B 渲染器 ──
// 注：`file` 与 `screenshot` 需 session 上下文（sessionPath/messageId/blockIdx），
// 统一走 ContentBlockView 的 switch 内联分发，不注册到全局表中。
BLOCK_RENDERERS['subagent'] = SubagentCard;
BLOCK_RENDERERS['workflow'] = WorkflowInlineCard;
BLOCK_RENDERERS['artifact'] = LegacyArtifactBlock;
BLOCK_RENDERERS['plugin_card'] = PluginCardWrapper;
BLOCK_RENDERERS['skill'] = SkillBlock;
BLOCK_RENDERERS['cron_confirm'] = CronConfirmBlock;
BLOCK_RENDERERS['suggestion_card'] = SuggestionCardDispatch;
BLOCK_RENDERERS['settings_confirm'] = SettingsConfirmBlock;
BLOCK_RENDERERS['settings_update'] = SettingsUpdateBlock;
BLOCK_RENDERERS['interactive_card'] = InteractiveCard;
