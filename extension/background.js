// Opens the side panel when the toolbar icon is clicked, on every tab.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("AltFix AI: failed to set panel behavior", err));
