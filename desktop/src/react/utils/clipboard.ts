/** Native desktop writes do not depend on Chromium's document focus check. */
export function copyTextToClipboard(text: string, targetWindow: Window | null = window): Promise<void> {
  try {
    if (targetWindow?.platform?.writeClipboardText) {
      return targetWindow.platform.writeClipboardText(text);
    }
    const clipboard = targetWindow?.navigator.clipboard;
    if (clipboard?.writeText) return clipboard.writeText(text);
    return Promise.reject(new Error('Clipboard API is unavailable for this window.'));
  } catch (error) {
    return Promise.reject(error);
  }
}
