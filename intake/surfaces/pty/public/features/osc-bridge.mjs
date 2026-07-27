/**
 * OSC bridge — intercepts xterm OSC sequences that remote applications use to
 * control the local client. Supports:
 *   - OSC 52: write to the local clipboard from the remote shell.
 *   - OSC 777: trigger a local browser notification from the remote shell.
 *
 * ShellFish parity: remote-to-local clipboard and notifications.
 */
export function init(T1) {
  T1.onTermReady((term) => {
    // xterm.js does not expose a clean OSC hook, but it parses and ignores
    // unknown OSC sequences. We intercept raw output before it is written,
    // look for the sequences, strip them, and perform the local action.
    const original = term.write.bind(term);
    const osc52Re = /\x1b\]52;[cCsS];([A-Za-z0-9+\/=]*)\x07/g;
    const osc777Re = /\x1b\]777;([^\x07]*)\x07/g;

    term.write = function (data) {
      if (typeof data !== 'string') return original(data);

      // OSC 52 — set clipboard. Data is base64.
      let m;
      while ((m = osc52Re.exec(data)) !== null) {
        try {
          const text = atob(m[1]);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
          }
          T1.toast('Clipboard updated by remote');
        } catch (_) {}
      }
      osc52Re.lastIndex = 0;

      // OSC 777 — notification. Payload is free-form text.
      while ((m = osc777Re.exec(data)) !== null) {
        try {
          const payload = m[1];
          const title = 'TerminalOne';
          const body = payload.startsWith('notify;') ? payload.slice(7) : payload;
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body, tag: 'terminalone' });
          } else if ('Notification' in window && Notification.permission !== 'denied') {
            Notification.requestPermission().then((p) => {
              if (p === 'granted') new Notification(title, { body, tag: 'terminalone' });
            }).catch(() => {});
          }
          T1.toast(`Notification: ${body}`, 'info');
        } catch (_) {}
      }
      osc777Re.lastIndex = 0;

      // Strip the sequences from the visible stream.
      const cleaned = data.replace(osc52Re, '').replace(osc777Re, '');
      return original(cleaned);
    };
  });
}
