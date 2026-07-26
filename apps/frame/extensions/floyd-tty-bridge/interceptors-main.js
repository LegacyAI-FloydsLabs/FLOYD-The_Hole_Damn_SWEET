(function() {
  // Pass the extension ID into the window scope for the main world to use
  const EXT_ID = document.currentScript?.dataset?.extId;

  function notifyExtension(data) {
    // Filter out noisy telemetry/logging endpoints that aren't useful for the agent
    if (data.type === 'network_error' && typeof data.url === 'string') {
      const noisyPatterns = [
        'claude.ai/api/event_logging',
        'google-analytics.com',
        'doubleclick.net',
        'sentry.io',
        'browser-intake-datadoghq.com',
        'api.mixpanel.com',
        'favicon.ico'
      ];
      if (noisyPatterns.some(pattern => data.url.includes(pattern))) {
        return;
      }
    }
    window.postMessage({ type: 'TOM_INTERCEPTOR_EVENT', data }, '*');
  }

  // 1. Console Error Interception
  const originalConsoleError = console.error;
  console.error = function(...args) {
    notifyExtension({
      type: 'console_error',
      message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    });
    originalConsoleError.apply(console, args);
  };

  // 2. Fetch Interception
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok) {
        notifyExtension({
          type: 'network_error',
          method: 'FETCH',
          url: args[0],
          status: response.status,
          statusText: response.statusText
        });
      }
      return response;
    } catch (err) {
      notifyExtension({
        type: 'network_error',
        method: 'FETCH',
        url: args[0],
        error: err.message
      });
      throw err;
    }
  };

  // 3. XHR Interception
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._method = method;
    this._url = url;
    return originalOpen.apply(this, arguments);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      if (this.status >= 400) {
        notifyExtension({
          type: 'network_error',
          method: 'XHR',
          url: this._url,
          status: this.status,
          statusText: this.statusText
        });
      }
    });
    this.addEventListener('error', function() {
      notifyExtension({
        type: 'network_error',
        method: 'XHR',
        url: this._url,
        error: 'XHR Network Error'
      });
    });
    return originalSend.apply(this, arguments);
  };

  // 4. Unhandled Exceptions
  window.addEventListener('error', (event) => {
    notifyExtension({
      type: 'unhandled_exception',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    notifyExtension({
      type: 'unhandled_rejection',
      reason: String(event.reason)
    });
  });
})();
