/**
 * Service worker: a right-click "Fact-check this" on selected text, and the toolbar button,
 * both open the side panel. The selection is passed through session storage (never sent
 * anywhere until the user presses Investigate in the panel).
 */
const MENU_ID = "fact-check-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Fact-check “%s”", contexts: ["selection"] });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const text = info.selectionText.slice(0, 12_000);
  // Open first (must happen within the user gesture), then hand over the text.
  if (tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
  void chrome.storage.session.set({ pendingClaim: { text, source: tab?.url ?? null, at: Date.now() } });
});
