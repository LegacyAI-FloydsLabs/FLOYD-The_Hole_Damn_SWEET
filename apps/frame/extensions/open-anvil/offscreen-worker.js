// offscreen-worker.js — Open Anvil v1.0.0
// Offscreen document for GIF recording (canvas operations not available in service workers)
'use strict';

let gifRecorderPromise;

function getGifRecorderImportPath() {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
    return chrome.runtime.getURL('gif-recorder.js');
  }
  return './gif-recorder.js';
}

async function getGifRecorder() {
  if (!gifRecorderPromise) {
    gifRecorderPromise = import(getGifRecorderImportPath());
  }
  return gifRecorderPromise;
}

async function handleGifCommand(data) {
  const recorder = await getGifRecorder();
  const command = data && data.command;

  switch (command) {
    case 'gif_start':
      return recorder.gifStart();
    case 'gif_add_frame':
      return recorder.gifAddFrame(data);
    case 'gif_stop':
      return recorder.gifStop(data);
    default:
      throw new Error(`Unknown GIF command: ${command}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_GIF') {
    handleGifCommand(message.data)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
  return true;
});
