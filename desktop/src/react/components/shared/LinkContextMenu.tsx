import { copyTextToClipboard } from '../../utils/clipboard';
import { ContextMenu, type ContextMenuItem } from '../../ui';
import {
  copyValueForLink,
  openExternalLink,
  resolveLinkTarget,
  type LinkOpenContext,
} from '../../utils/link-open';

export interface LinkContextMenuState {
  href: string;
  context: LinkOpenContext;
  position: { x: number; y: number };
}

interface LinkContextMenuProps {
  state: LinkContextMenuState;
  onClose: () => void;
}

function tr(key: string, fallback: string): string {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

export function LinkContextMenu({ state, onClose }: LinkContextMenuProps) {
  const target = resolveLinkTarget(state.href, state.context);
  const isFile = target.kind === 'file';
  const copyLabel = isFile
    ? tr('link.copyPath', '复制路径')
    : tr('link.copyLink', '复制链接');
  const openLabel = isFile
    ? tr('desk.openWithDefault', '用默认应用打开')
    : tr('link.openInSystemBrowser', '用系统浏览器打开');

  const items: ContextMenuItem[] = [
    {
      label: openLabel,
      disabled: target.kind === 'anchor',
      action: () => { openExternalLink(state.href, state.context); },
    },
    {
      label: copyLabel,
      action: () => {
        copyTextToClipboard(copyValueForLink(state.href, state.context)).catch(() => {});
      },
    },
  ];

  return (
    <ContextMenu
      items={items}
      position={state.position}
      onClose={onClose}
    />
  );
}
