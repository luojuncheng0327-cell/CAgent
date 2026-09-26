import { copyTextToClipboard } from '../../utils/clipboard';
/**
 * UserMessage — 用户消息气泡
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MessageFooterActions, formatMessageTime, type MessageFooterAction } from './MessageFooterActions';
import { useMessageFooterActions } from './MessageActions';
import { AttachmentChip } from '../shared/AttachmentChip';
import { AudioAttachmentChip } from '../shared/AudioAttachmentChip';
import { FileKindIcon } from '../shared/FileKindIcon';
import { FolderIcon } from '../shared/FolderIcon';
import type { ChatMessage, UserAttachment, DeskContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { selectSelectedIdsBySession } from '../../stores/session-selectors';
import { extractSelectedTexts } from '../../utils/message-text';
import { openFilePreview } from '../../utils/file-preview';
import { isImageOrSvgExt, extOfName, kindOfFileName } from '../../utils/file-kind';
import { getUserAttachmentImageSrc } from '../../utils/user-attachment-media';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import {
  retrySessionTurn,
  type ForkedSessionHandler,
  type SessionNodeTarget,
} from '../../stores/message-turn-actions';
import { AgentReviewCard } from './AgentReviewCard';
import { AgentReviewRequestCard } from './AgentReviewRequestCard';
import { useSessionNodeActions } from './SessionNodeActions';
import styles from './Chat.module.css';
import badgeStyles from '../input/SkillBadgeView.module.css';

const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  sessionPath: string;
  readOnly?: boolean;
  hideIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  viewerIdentity: { name: string; avatarUrl: string | null };
  isStreaming: boolean;
  isSelected: boolean;
  isLatestUserMessage?: boolean;
  onForkCreated?: ForkedSessionHandler;
  messageRef?: (element: HTMLDivElement | null) => void;
}

export const UserMessage = memo(function UserMessage({
  message,
  showAvatar,
  sessionPath,
  readOnly = false,
  hideIdentity = false,
  userIdentity,
  viewerIdentity,
  isStreaming,
  isSelected,
  isLatestUserMessage = false,
  onForkCreated,
  messageRef,
}: Props) {
  const t = window.t ?? ((p: string) => p);
  const storeUserName = viewerIdentity.name;
  const userName = userIdentity?.name || storeUserName;
  const displayAvatarUrl = userIdentity ? (userIdentity.avatarUrl || null) : viewerIdentity.avatarUrl;
  const userDisplayInfo = useMemo(() => resolveAgentDisplayInfo({
    id: 'user',
    agents: [],
    userName,
    userAvatarUrl: displayAvatarUrl,
  }), [userName, displayAvatarUrl]);

  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.text || '');
  const [editBusy, setEditBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setEditValue(message.text || '');
  }, [editing, message.text]);

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const handleCopy = useCallback(() => {
    const ids = selectSelectedIdsBySession(useStore.getState(), sessionPath);
    const text = ids.length > 0
      ? extractSelectedTexts(sessionPath, ids)
      : (message.text || '');
    if (!text) return;
    copyTextToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [message.text, sessionPath]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id, sessionPath);
  }, [message.id, sessionPath]);

  const isReviewTurn = !!message.agentReview || !!message.agentReviewRequest;
  const turnTarget = useMemo<SessionNodeTarget | null>(() => (
    message.sourceEntryId
      ? { role: 'user', entryId: message.sourceEntryId }
      : null
  ), [message.sourceEntryId]);
  const { actions: nodeActions, busy: nodeActionBusy } = useSessionNodeActions({
    sessionPath,
    target: readOnly ? null : turnTarget,
    retryMessage: message,
    onForkCreated,
    disabled: isStreaming,
  });
  const busy = editBusy || nodeActionBusy;

  const handleEdit = useCallback(() => {
    if (busy || isStreaming) return;
    setEditValue(message.text || '');
    setEditing(true);
  }, [busy, isStreaming, message.text]);

  const handleCancelEdit = useCallback(() => {
    if (busy) return;
    setEditing(false);
    setEditValue(message.text || '');
  }, [busy, message.text]);

  const handleConfirmEdit = useCallback(async () => {
    const nextText = editValue.trim();
    if (!nextText || busy || isStreaming) return;
    setEditBusy(true);
    try {
      if (!turnTarget) return;
      const ok = await retrySessionTurn(
        sessionPath,
        turnTarget,
        { message, replacementText: nextText },
      );
      if (ok) setEditing(false);
    } finally {
      setEditBusy(false);
    }
  }, [busy, editValue, isStreaming, message, sessionPath, turnTarget]);

  // Retry and fork preserve the recorded review envelope. Inline text editing remains
  // unavailable because changing only its text would no longer match that snapshot.
  const canEdit = !readOnly && !isReviewTurn && isLatestUserMessage && !!turnTarget;
  const timeText = formatMessageTime(message.timestamp);
  const editingActions: MessageFooterAction[] = useMemo(() => [
    {
      id: 'cancel',
      title: t('common.cancel'),
      icon: <XIcon />,
      onClick: () => handleCancelEdit(),
      disabled: busy,
    },
    {
      id: 'confirm',
      title: t('common.confirm'),
      icon: <CheckIcon />,
      onClick: () => { void handleConfirmEdit(); },
      disabled: busy || !editValue.trim(),
    },
  ], [busy, editValue, handleCancelEdit, handleConfirmEdit, t]);
  const standardMessageActions = useMessageFooterActions({
    messageId: message.id,
    sessionPath,
    onCopy: handleCopy,
    onScreenshot: () => { void handleScreenshot(); },
    copied,
    isStreaming: isStreaming || busy,
  });
  const messageActions = readOnly || editing ? [] : standardMessageActions;
  const editActions: MessageFooterAction[] = useMemo(() => canEdit ? [
    {
      id: 'edit',
      title: t('common.edit'),
      icon: <EditIcon />,
      onClick: () => handleEdit(),
      disabled: isStreaming || busy,
    },
  ] : [], [busy, canEdit, handleEdit, isStreaming, t]);
  const footerActions = editing ? editingActions : [...nodeActions, ...editActions];
  const hasSkillBadges = !!message.skills?.length;
  const hasTextBubble = editing || !!message.textHtml || hasSkillBadges;

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupUser}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
         ref={messageRef}
         data-message-id={message.id}>
      {showAvatar && !hideIdentity && (
        <div className={`${styles.avatarRow} ${styles.avatarRowUser}`}>
          <span className={styles.avatarName}>{userName}</span>
          <AgentAvatar
            info={userDisplayInfo}
            className={`${styles.avatar} ${styles.userAvatar}`}
            alt={userName}
          />
        </div>
      )}
      {message.quotedText && (
        <div className={styles.userAttachments}>
          <AttachmentChip
            icon={<GridIcon />}
            name={message.quotedText}
          />
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <UserAttachmentsView
          attachments={message.attachments}
          deskContext={message.deskContext}
          sessionPath={sessionPath}
          messageId={message.id}
        />
      )}
      {hasTextBubble && (
        <div className={`${styles.message} ${styles.messageUser}${editing ? ` ${styles.messageUserEditing}` : ''}`}>
          {message.skills && message.skills.length > 0 && message.skills.map(skillName => (
            <span key={skillName} className={badgeStyles.badge} style={{ cursor: 'default' }}>
              <svg className={badgeStyles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
                <path d="M8 1 L9.5 6 L15 8 L9.5 10 L8 15 L6.5 10 L1 8 L6.5 6 Z" />
              </svg>
              <span className={badgeStyles.name}>{skillName}</span>
            </span>
          ))}
          {editing ? (
            <textarea
              ref={textareaRef}
              className={styles.userEditTextarea}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleConfirmEdit();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelEdit();
                }
              }}
              disabled={busy}
              spellCheck={false}
            />
          ) : (
            message.textHtml && <MarkdownContent html={message.textHtml} linkContext={{ origin: 'session', sessionPath, messageId: message.id }} />
          )}
        </div>
      )}
      {message.agentReview && <AgentReviewCard review={message.agentReview} />}
      {message.agentReviewRequest && <AgentReviewRequestCard request={message.agentReviewRequest} />}
      {(timeText || messageActions.length > 0 || footerActions.length > 0) && (
        <MessageFooterActions
          align="right"
          timeText={timeText}
          leadingActions={footerActions}
          visible={editing}
          actions={messageActions}
          testId="user-message-footer-actions"
        />
      )}
    </div>
  );
});

// ── 附件区 ──

const UserAttachmentsView = memo(function UserAttachmentsView({ attachments, deskContext, sessionPath, messageId }: {
  attachments: UserAttachment[];
  deskContext?: DeskContext | null;
  sessionPath: string;
  messageId: string;
}) {
  // 扩展名识别统一走中心表 EXT_TO_KIND；禁止维护私有 IMAGE_EXTS 表。
  const isImage = useCallback((att: UserAttachment) => {
    return isImageOrSvgExt(extOfName(att.name));
  }, []);

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={styles.userAttachments}>
      {attachments.map((att, i) => {
        const expired = att.status === 'expired';
        const expiredLabel = t('chat.fileExpired');
        const imageSrc = !expired && isImage(att) ? getUserAttachmentImageSrc(att) : null;
        const kind = att.isDir ? 'directory' : kindOfFileName(att.name || att.path, att.mimeType);
        if (!expired && kind === 'audio') {
          const isVoiceInput = att.presentation === 'voice-input';
          const transcriptText = isVoiceInput && att.transcription?.status === 'ready'
            ? att.transcription.text?.trim()
            : '';
          if (isVoiceInput) {
            return (
              <div key={att.fileId || att.path || att.name || `att-${i}`} className={styles.voiceInputCard}>
                {transcriptText && <div className={styles.voiceInputTranscript}>{transcriptText}</div>}
                <AudioAttachmentChip
                  file={{
                    path: att.path,
                    name: att.name,
                    base64Data: att.base64Data,
                    mimeType: att.mimeType,
                    waveform: att.waveform,
                  }}
                  showName={false}
                  className={styles.voiceInputAudioStrip}
                  waveform={att.waveform}
                />
              </div>
            );
          }
          return (
            <AudioAttachmentChip
              key={att.fileId || att.path || att.name || `att-${i}`}
              file={{
                path: att.path,
                name: att.name,
                base64Data: att.base64Data,
                mimeType: att.mimeType,
                waveform: att.waveform,
              }}
              showName={att.presentation !== 'voice-input'}
              waveform={att.waveform}
            />
          );
        }
        if (imageSrc) {
          return (
            <div key={att.name || `att-${i}`} className={styles.attachImageWrap}>
              <img
                className={styles.attachImage}
                src={imageSrc}
                alt={att.name}
                loading="lazy"
                onClick={(e) => {
                  e.stopPropagation();
                  const ext = att.name.split('.').pop()?.toLowerCase() || '';
                  openFilePreview(att.path, att.name, ext, {
                    origin: 'session',
                    sessionPath,
                    messageId,
                  });
                }}
                style={{ cursor: 'default' }}
              />
              {att.visionAuxiliary && (
                <div className={styles.visionAuxiliaryLabel}>
                  {t('chat.visionAuxiliary')}
                </div>
              )}
            </div>
          );
        }
        return (
          <AttachmentChip
            key={att.fileId || att.path || att.name || `att-${i}`}
            icon={att.isDir ? <FolderIcon /> : <FileKindIcon kind={kindOfFileName(att.name || att.path, att.mimeType)} size={14} />}
            name={expired ? `${att.name} · ${expiredLabel}` : att.name}
            variant={expired ? 'expired' : 'normal'}
          />
        );
      })}
      {deskContext && (
        <AttachmentChip
          icon={<FolderIcon />}
          name={`${t('sidebar.jian')} (${deskContext.fileCount})`}
        />
      )}
    </div>
  );
});

// ── Icons ──

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <line x1="6" y1="8" x2="18" y2="8" />
      <line x1="6" y1="16" x2="18" y2="16" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
