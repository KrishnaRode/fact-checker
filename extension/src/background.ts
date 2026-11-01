import { refreshIndex } from "./refresh";

/**
 * Service worker:
 *  - right-click "Fact-check this" and the toolbar button open the side panel; the selection is
 *    handed over through session storage (nothing is sent until the user checks it);
 *  - keeps the local 14-day news index fresh: on install/startup and every 30 minutes.
 */
const MENU_ID = "fact-check-selection";
const ALARM = "refresh-index";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Fact-check “%s”", contexts: ["selection"] });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void chrome.alarms.create(ALARM, { periodInMinutes: 30, delayInMinutes: 30 });
  void refreshIndex();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: 30 });
  void refreshIndex();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void refreshIndex();
});

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  if (msg?.type === "refresh-index") {
    refreshIndex().then(reply, () => reply(null));
    return true; // async reply
  }
  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const text = info.selectionText.slice(0, 12_000);
  // Open first (must happen within the user gesture), then hand over the text.
  if (tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
  void chrome.storage.session.set({ pendingClaim: { text, source: tab?.url ?? null, at: Date.now() } });
});
