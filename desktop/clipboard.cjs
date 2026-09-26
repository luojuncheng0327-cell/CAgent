/** Clipboard writes from the app's own top-level renderer only. */
function registerClipboardIpc({ handle, clipboard, preloadPath }) {
  handle("clipboard-write-text", (event, text) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || event.sender.getLastWebPreferences()?.preload !== preloadPath) {
      throw new Error("Clipboard writes require an app renderer");
    }
    if (typeof text !== "string") throw new TypeError("Clipboard text must be a string");
    clipboard.writeText(text);
  });
}

module.exports = { registerClipboardIpc };
