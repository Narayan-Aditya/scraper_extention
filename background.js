// Insta Handle & Data Exporter — Service Worker Hub
//
// Clean modular service worker importing individual feature orchestrators.
// Each runner maintains its own state, tab lifecycle, alarms, and isolated message namespaces.

importScripts("background-profiles.js");
importScripts("background-youtube.js");
importScripts("background-discover.js");
importScripts("background-brief.js");

// Makes the toolbar icon open the persistent side panel (popup/popup.html)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
