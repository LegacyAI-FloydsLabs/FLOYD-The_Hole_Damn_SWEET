(function() {
  'use strict';

  const HOST_ID = 'floyd-agent-indicator-host';

  function showIndicator() {
    // Idempotent: don't stack indicators
    if (document.getElementById(HOST_ID)) {
      return;
    }

    // Create host element for Shadow DOM
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-floyd-indicator', 'true');
    
    // Ensure host itself doesn't interfere with layout
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    host.style.overflow = 'visible';
    host.style.zIndex = '2147483646';

    // Use Shadow DOM to isolate styles
    const shadow = host.attachShadow({ mode: 'closed' });

    // Create styles
    const style = document.createElement('style');
    style.textContent = `
      .floyd-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 2147483646;
        box-sizing: border-box;
        border: 2px solid rgba(207, 107, 60, 0.8);
        animation: floyd-pulse 1.5s ease-in-out infinite;
      }

      .floyd-stop-btn {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        pointer-events: auto;
        background: rgba(207, 107, 60, 0.9);
        color: white;
        border: none;
        padding: 12px;
        border-radius: 6px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        transition: background 0.2s ease, transform 0.1s ease;
      }

      .floyd-stop-btn:hover {
        background: rgba(227, 127, 80, 1);
      }
      
      .floyd-stop-btn:active {
        transform: translateX(-50%) scale(0.98);
      }

      @keyframes floyd-pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 1; }
      }
    `;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'floyd-overlay';
    overlay.setAttribute('data-floyd-indicator', 'true');

    // Create stop button
    const stopBtn = document.createElement('button');
    stopBtn.className = 'floyd-stop-btn';
    stopBtn.textContent = 'Stop';
    stopBtn.setAttribute('data-floyd-indicator', 'true');

    // Handle stop button click
    stopBtn.addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'AGENT_STOP' });
      }
      hideIndicator();
    });

    // Assemble Shadow DOM
    shadow.appendChild(style);
    shadow.appendChild(overlay);
    shadow.appendChild(stopBtn);

    // Append to document
    const target = document.body || document.documentElement;
    if (target) {
      target.appendChild(host);
    }
  }

  function hideIndicator() {
    const host = document.getElementById(HOST_ID);
    // Cleanup: don't crash if host is already removed
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
    }
  }

  // Listen for messages from background.js
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return;
      
      if (message.type === 'AGENT_WORKING') {
        showIndicator();
      } else if (message.type === 'AGENT_DONE') {
        hideIndicator();
      }
    });
  }
})();
