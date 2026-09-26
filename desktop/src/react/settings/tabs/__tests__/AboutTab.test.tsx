/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

let shellUpdateStateOverride: { status: string; version?: string | null } | null = null;

vi.mock('../../../hooks/use-auto-update-state', () => ({
  useAutoUpdateState: () => shellUpdateStateOverride ?? { status: 'idle' },
}));

const checkTrainNow = vi.fn();
const applyTrainNow = vi.fn();

interface TrainOverride {
  currentVersion: string;
  available: { version: string } | null;
  minShellBlocked: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
  manifestSource: 'origin' | 'mirror' | null;
  manifestReleasedAt: string | null;
  originUnreachable: boolean;
  phase: 'idle' | 'checking' | 'downloading' | 'applying';
  progress: { receivedBytes: number; totalBytes: number } | null;
}

const DEFAULT_TRAIN_OVERRIDE: TrainOverride = {
  currentVersion: '0.160.2',
  available: null,
  minShellBlocked: false,
  lastError: null,
  lastCheckedAt: null,
  manifestSource: null,
  manifestReleasedAt: null,
  originUnreachable: false,
  phase: 'idle',
  progress: null,
};

let trainOverride: TrainOverride = { ...DEFAULT_TRAIN_OVERRIDE };

vi.mock('../../../hooks/use-train-update-state', () => ({
  useTrainUpdateState: () => ({
    ...trainOverride,
    checkNow: checkTrainNow,
    applyNow: applyTrainNow,
  }),
}));

vi.mock('@/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/ui')>(),
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-busy={on === undefined ? 'true' : undefined}
      aria-checked={on === undefined ? 'mixed' : on ? 'true' : 'false'}
      data-testid={`${ariaLabel || label}-${on === undefined ? 'loading' : on ? 'on' : 'off'}`}
      disabled={on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    >
      toggle
    </button>
  ),
}));

const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
}));

import { AboutTab } from '../AboutTab';
import { useSettingsStore } from '../../store';

afterEach(() => {
  cleanup();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  checkTrainNow.mockReset();
  applyTrainNow.mockReset();
  trainOverride = { ...DEFAULT_TRAIN_OVERRIDE };
  shellUpdateStateOverride = null;
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

function installHana(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      autoUpdateCheck: vi.fn(),
      autoUpdateInstall: vi.fn(),
      autoUpdateSetChannel: vi.fn(),
      openExternal: vi.fn(),
      getUpdateDigestHistory: vi.fn().mockResolvedValue({ entries: [], source: 'none', complete: false }),
      ...overrides,
    },
  }));
}

const digest = (version: string) => ({
  schemaVersion: 1 as const,
  tag: `v${version}`,
  version,
  previousTag: '',
  generatedAt: '2026-07-01T00:00:00.000Z',
  noUserFacingChanges: false,
  summary: { zh: `${version} 摘要`, en: `${version} summary` },
  counts: { feature: 0, fix: 1, improvement: 0, migration: 0 },
  items: [{
    id: `${version}-fix`,
    kind: 'fix' as const,
    importance: 'high' as const,
    title: { zh: `${version} 修复`, en: `${version} fix` },
    summary: { zh: `${version} 修复说明`, en: `${version} fix detail` },
    details: [],
    sources: [],
  }],
});

describe('AboutTab', () => {
  it('keeps startup and background controls out of the about page', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(screen.getByText('settings.about.autoCheckUpdates')).toBeTruthy();
    expect(screen.getByText('settings.about.betaUpdates')).toBeTruthy();
    expect(screen.queryByText('settings.general.launchAtLogin')).toBeNull();
    expect(screen.queryByText('settings.general.keepAwake')).toBeNull();
  });

  it('keeps update switches in loading state until settings config is ready', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: null });

    render(<AboutTab />);

    const switches = screen.getAllByRole('button').filter(
      el => el.getAttribute('aria-checked') === 'mixed',
    ) as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    for (const item of switches) {
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
    }
    expect(autoSaveConfig).not.toHaveBeenCalled();
    expect(loadSettingsConfig).not.toHaveBeenCalled();
  });

  it('shows the content version (single source, not the shell version) in the hero', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, currentVersion: '0.388.0' };

    render(<AboutTab />);

    expect(screen.getByText('v0.388.0')).toBeTruthy();
  });

  it('does not render the platform-update row when no shell update is pending', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    shellUpdateStateOverride = { status: 'idle' };

    render(<AboutTab />);

    expect(screen.queryByText('settings.about.shellStickerTitle')).toBeNull();
  });

  it('renders the platform-update row only while a shell update is downloaded, and wires it to autoUpdateInstall', () => {
    const autoUpdateInstall = vi.fn();
    installHana({ autoUpdateInstall });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    shellUpdateStateOverride = { status: 'downloaded', version: '2.0.0' };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.shellStickerTitle')).toBeTruthy();
    expect(screen.getByText('v2.0.0')).toBeTruthy();

    fireEvent.click(screen.getByText('settings.about.updateInstall'));
    expect(autoUpdateInstall).toHaveBeenCalledTimes(1);
  });

  it('escalates the platform-update row copy when minShellBlocked is true (two-tier copy)', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    shellUpdateStateOverride = { status: 'downloaded', version: '2.0.0' };
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, minShellBlocked: true };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.shellStickerTitleBlocking')).toBeTruthy();
    expect(screen.queryByText('settings.about.shellStickerTitle')).toBeNull();
  });

  it('available: shows the "new version available" headline with an update button that calls applyNow (never autoUpdateInstall)', () => {
    const autoUpdateInstall = vi.fn();
    installHana({ autoUpdateInstall });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, available: { version: '0.389.0' } };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateAvailable')).toBeTruthy();
    fireEvent.click(screen.getByText('settings.about.updateApply'));

    expect(applyTrainNow).toHaveBeenCalledTimes(1);
    expect(autoUpdateInstall).not.toHaveBeenCalled();
    // No manual "check for updates" button while an update is already sitting there.
    expect(screen.queryByText('settings.about.updateCheckBtn')).toBeNull();
  });

  it('lastError: shows the error text with a retry button that calls checkNow', () => {
    const autoUpdateCheck = vi.fn();
    installHana({ autoUpdateCheck });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, lastError: 'network down' };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateError')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();

    fireEvent.click(screen.getByText('settings.about.updateRetryBtn'));
    expect(checkTrainNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('settings.about.updateRetryBtn'));
    expect(checkTrainNow).toHaveBeenCalledTimes(2);
    expect(autoUpdateCheck).toHaveBeenCalledTimes(2);
    // The generic check button is redundant once the retry button is showing.
    expect(screen.queryByText('settings.about.updateCheckBtn')).toBeNull();
  });

  it('distinguishes an unavailable Gitee update feed from a successful update check', () => {
    installHana();
    const lastError = 'artifact-ota: Gitee channel manifest request failed: artifact-ota: HTTP 404 for https://gitee.com/luo-juncheng666/cagent/raw/master/updates/channels/stable.json';
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, lastError, lastCheckedAt: '2026-09-27T00:00:00.000Z' };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateSourceNotReady')).toBeTruthy();
    expect(screen.getByText('settings.about.updateSourceNotReadyHint')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateLatestCheckedAt')).toBeNull();
    expect(screen.queryByText('settings.about.updateError')).toBeNull();
    const details = screen.getByText(lastError).closest('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('settings.about.updateErrorDetails')).toBeTruthy();
    fireEvent.click(screen.getByText('settings.about.updateRetryBtn'));
    expect(checkTrainNow).toHaveBeenCalledTimes(1);
  });

  it.each([
    'artifact-ota: Gitee channel manifest request failed: artifact-ota: HTTP 503 for https://gitee.com/updates/channels/stable.json',
    'artifact-ota: Gitee channel manifest failed signature or schema verification',
    'artifact-ota: HTTP 404 for https://gitee.com/releases/renderer.zip',
  ])('keeps other update failures visible: %s', (lastError) => {
    installHana();
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, lastError };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateError')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateSourceNotReady')).toBeNull();
    expect(screen.getByText(lastError).closest('details')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateLatestCheckedAt')).toBeNull();
  });

  it('links to this fork on Gitee and displays its copyright', () => {
    const openExternal = vi.fn();
    installHana({ openExternal });

    render(<AboutTab />);

    expect(screen.getByText('© 2026 @呈平安')).toBeTruthy();
    expect(screen.getByText('Apache License 2.0')).toBeTruthy();
    const repository = screen.getByRole('link', { name: /gitee.com\/luo-juncheng666\/cagent/ });
    expect(repository.getAttribute('href')).toBe('https://gitee.com/luo-juncheng666/cagent');
    fireEvent.click(repository);
    expect(openExternal).toHaveBeenCalledWith('https://gitee.com/luo-juncheng666/cagent');
    expect(screen.queryByText('github.com/liliMozi')).toBeNull();
  });

  it('up-to-date: only shows the "latest, last checked at" line when there is no available update and no error', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, lastCheckedAt: '2026-07-11T08:00:00.000Z' };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateLatestCheckedAt')).toBeTruthy();
    // Manual check remains available from the calm "up to date" state.
    expect(screen.getByText('settings.about.updateCheckBtn')).toBeTruthy();
    // No manifest date line when the hook never reported one (pre-upgrade
    // shell / never-fetched-from-real-source case).
    expect(screen.queryByText('settings.about.updateManifestReleasedAt')).toBeNull();
    expect(screen.queryByText('settings.about.updateManifestReleasedAtViaMirror')).toBeNull();
  });

  it('up-to-date: shows the neutral shelf-manifest-issued line when manifestReleasedAt is present, without the mirror suffix when origin was reachable', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = {
      ...DEFAULT_TRAIN_OVERRIDE,
      lastCheckedAt: '2026-07-11T08:00:00.000Z',
      manifestSource: 'origin',
      manifestReleasedAt: '2026-07-11T00:00:00.000Z',
      originUnreachable: false,
    };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateManifestReleasedAt')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateManifestReleasedAtViaMirror')).toBeNull();
  });

  it('up-to-date: ignores legacy source flags and always uses the single-source manifest copy', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = {
      ...DEFAULT_TRAIN_OVERRIDE,
      lastCheckedAt: '2026-07-11T08:00:00.000Z',
      manifestSource: 'mirror',
      manifestReleasedAt: '2026-07-11T00:00:00.000Z',
      originUnreachable: true,
    };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.updateManifestReleasedAt')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateManifestReleasedAtViaMirror')).toBeNull();
  });

  it('never checked: renders no conclusion text, only the manual check button', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(screen.queryByText('settings.about.updateAvailable')).toBeNull();
    expect(screen.queryByText('settings.about.updateError')).toBeNull();
    expect(screen.queryByText('settings.about.updateLatestCheckedAt')).toBeNull();
    expect(screen.getByText('settings.about.updateCheckBtn')).toBeTruthy();
  });

  it('downloading: shows byte progress while an apply is in flight, driven by the hook phase/progress', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = {
      ...DEFAULT_TRAIN_OVERRIDE,
      available: { version: '0.389.0' },
      phase: 'downloading',
      progress: { receivedBytes: 50, totalBytes: 200 },
    };

    render(<AboutTab />);

    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(25);
  });

  it('applying: shows the applying message and hides the manual check button', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    trainOverride = { ...DEFAULT_TRAIN_OVERRIDE, available: { version: '0.389.0' }, phase: 'applying' };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.trainStickerApplying')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateCheckBtn')).toBeNull();
  });

  it('the beta toggle drives both the shell channel IPC and a train update check', async () => {
    const autoUpdateSetChannel = vi.fn();
    installHana({ autoUpdateSetChannel });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    // Toggle rows render in JSX order: autoCheckUpdates, then betaUpdates —
    // pick the second toggle (mocked Toggle exposes aria-checked).
    const toggles = screen.getAllByRole('button').filter(b => b.hasAttribute('aria-checked'));
    expect(toggles).toHaveLength(2);
    await act(async () => {
      fireEvent.click(toggles[1]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(autoUpdateSetChannel).toHaveBeenCalledWith('beta');
    expect(autoSaveConfig).toHaveBeenCalledWith({ update_channel: 'beta' }, { silent: true });
    expect(checkTrainNow).toHaveBeenCalledTimes(1);
  });

  it('loads the newest five releases only after the update-history dialog is opened', async () => {
    const getUpdateDigestHistory = vi.fn().mockResolvedValue({
      entries: [
        digest('0.400.5'),
        digest('0.400.4'),
        digest('0.400.3'),
        digest('0.400.2'),
        digest('0.400.1'),
      ],
      source: 'online',
      complete: true,
    });
    installHana({
      getUpdateDigestHistory,
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(getUpdateDigestHistory).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'settings.about.updateHistoryTitle' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.updateHistoryTitle' }));

    expect(await screen.findByRole('dialog', { name: 'settings.about.updateHistoryTitle' })).toBeTruthy();
    expect(await screen.findByText('v0.400.5')).toBeTruthy();
    expect(screen.getByText('v0.400.1')).toBeTruthy();
    expect(getUpdateDigestHistory).toHaveBeenCalledTimes(1);
  });

  // ── 邀请制测试通道 ──

  it('renders no invite entry at all while the redemption service is unconfigured', async () => {
    const inviteStatus = vi.fn().mockResolvedValue({
      configured: false, active: false, inviteCodes: [], channel: 'default',
    });
    installHana({ inviteStatus });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    await act(async () => {
      render(<AboutTab />);
      await Promise.resolve();
    });

    expect(inviteStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('settings.about.inviteSectionTitle')).toBeNull();
    expect(screen.queryByText('settings.about.inviteRedeemBtn')).toBeNull();
  });

  it('offers the invite code field once the redemption service is configured', async () => {
    installHana({
      inviteStatus: vi.fn().mockResolvedValue({
        configured: true, active: false, inviteCodes: [], channel: 'default',
      }),
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    await act(async () => {
      render(<AboutTab />);
      await Promise.resolve();
    });

    expect(screen.getByText('settings.about.inviteSectionTitle')).toBeTruthy();
    expect(screen.getByText('settings.about.inviteRedeemBtn')).toBeTruthy();
  });

  it('separates "code is invalid or used up" from a network failure in the redeem error copy', async () => {
    const inviteRedeem = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid', message: 'code not found' });
    installHana({
      inviteStatus: vi.fn().mockResolvedValue({
        configured: true, active: false, inviteCodes: [], channel: 'default',
      }),
      inviteRedeem,
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    await act(async () => {
      render(<AboutTab />);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText('settings.about.inviteCodeLabel'), { target: { value: 'HANA-BAD' } });
    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.inviteRedeemBtn'));
      await Promise.resolve();
    });

    expect(inviteRedeem).toHaveBeenCalledWith('HANA-BAD');
    expect(screen.getByText('settings.about.inviteErrorInvalid')).toBeTruthy();
    expect(screen.queryByText('settings.about.inviteErrorNetwork')).toBeNull();

    inviteRedeem.mockResolvedValue({ ok: false, reason: 'network', message: 'ENOTFOUND' });
    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.inviteRedeemBtn'));
      await Promise.resolve();
    });

    expect(screen.getByText('settings.about.inviteErrorNetwork')).toBeTruthy();
    expect(screen.queryByText('settings.about.inviteErrorInvalid')).toBeNull();
  });

  it('never activates the channel when the one-way-data confirmation is cancelled', async () => {
    const inviteActivate = vi.fn();
    installHana({
      inviteStatus: vi.fn().mockResolvedValue({
        configured: true, active: false, inviteCodes: [], channel: 'default',
      }),
      inviteRedeem: vi.fn().mockResolvedValue({
        ok: true, feedUrl: 'https://updates.example.com/alpha', childCodes: ['CHILD-1', 'CHILD-2'],
      }),
      inviteActivate,
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    await act(async () => {
      render(<AboutTab />);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText('settings.about.inviteCodeLabel'), { target: { value: 'HANA-OK' } });
    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.inviteRedeemBtn'));
      await Promise.resolve();
    });

    // 兑换成功只开对话框，绝不先落盘。
    expect(screen.getByText('settings.about.inviteConfirmTitle')).toBeTruthy();
    expect(inviteActivate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.inviteConfirmCancel'));
      await Promise.resolve();
    });

    expect(inviteActivate).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.about.inviteChannelActive')).toBeNull();
  });

  it('activates the channel and shows the two fission codes only after the confirmation is accepted', async () => {
    const inviteActivate = vi.fn().mockResolvedValue({
      configured: true, active: true, inviteCodes: ['CHILD-1', 'CHILD-2'], channel: 'alpha',
    });
    installHana({
      inviteStatus: vi.fn().mockResolvedValue({
        configured: true, active: false, inviteCodes: [], channel: 'default',
      }),
      inviteRedeem: vi.fn().mockResolvedValue({
        ok: true, feedUrl: 'https://updates.example.com/alpha', childCodes: ['CHILD-1', 'CHILD-2'],
      }),
      inviteActivate,
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    await act(async () => {
      render(<AboutTab />);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText('settings.about.inviteCodeLabel'), { target: { value: 'HANA-OK' } });
    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.inviteRedeemBtn'));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.inviteConfirmOk'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inviteActivate).toHaveBeenCalledWith({
      feedUrl: 'https://updates.example.com/alpha',
      inviteCodes: ['CHILD-1', 'CHILD-2'],
    });
    expect(screen.getByText('settings.about.inviteChannelActive')).toBeTruthy();
    expect((screen.getByDisplayValue('CHILD-1') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByDisplayValue('CHILD-2')).toBeTruthy();
    expect(screen.getAllByText('settings.about.inviteCopy')).toHaveLength(2);
  });

  it('offers a manual platform-update check inside the active beta channel section', async () => {
    const autoUpdateCheck = vi.fn().mockResolvedValue(null);
    installHana({
      inviteStatus: vi.fn().mockResolvedValue({
        configured: true, active: true, inviteCodes: [], channel: 'alpha',
      }),
      autoUpdateCheck,
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    await act(async () => {
      render(<AboutTab />);
      await Promise.resolve();
    });

    // 激活态下提供「检查平台更新」手动入口：一点即触发壳检查 IPC。
    expect(screen.getByText('settings.about.platformCheckLabel')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('settings.about.platformCheckBtn'));
      await Promise.resolve();
    });
    expect(autoUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('shows an explicit bundled-history warning when online history is unavailable', async () => {
    installHana({
      getUpdateDigestHistory: vi.fn().mockResolvedValue({
        entries: [digest('0.400.0')],
        source: 'bundled',
        complete: false,
      }),
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.updateHistoryTitle' }));

    expect(await screen.findByText('settings.about.updateHistoryOffline')).toBeTruthy();
    expect(screen.getByText('v0.400.0')).toBeTruthy();
  });
});
