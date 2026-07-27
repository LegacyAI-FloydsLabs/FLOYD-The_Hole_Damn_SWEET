'use strict';

const crypto = require('crypto');

const DEFAULT_TICKET_TTL_MS = 10_000;
const MAX_OUTSTANDING_TICKETS = 256;

function rejectUpgrade(socket, statusCode, message) {
  const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : 'Not Found';
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  );
  socket.destroy();
}

function installWebSocketAuth({ app, server, wss, allowedOrigin, ticketTtlMs = DEFAULT_TICKET_TTL_MS }) {
  const expectedHost = new URL(allowedOrigin).host;
  const tickets = new Map();

  function prune(now = Date.now()) {
    for (const [ticket, record] of tickets) {
      if (record.expiresAt <= now) tickets.delete(ticket);
    }
    while (tickets.size >= MAX_OUTSTANDING_TICKETS) tickets.delete(tickets.keys().next().value);
  }

  app.post('/api/ws-ticket', (req, res) => {
    const fetchSite = req.get('sec-fetch-site');
    if (req.get('origin') !== allowedOrigin || req.get('host') !== expectedHost || (fetchSite && fetchSite !== 'same-origin')) {
      res.status(403).set('Cache-Control', 'no-store').json({ error: 'same-origin request required' });
      return;
    }
    prune();
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(ticket, { expiresAt: Date.now() + ticketTtlMs, remoteAddress: req.socket.remoteAddress || null });
    res.status(201).set('Cache-Control', 'no-store').json({ ticket, expiresInMs: ticketTtlMs });
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin !== allowedOrigin || req.headers.host !== expectedHost) {
      rejectUpgrade(socket, 403, 'WebSocket origin rejected');
      return;
    }
    const url = new URL(req.url || '/', allowedOrigin);
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'WebSocket endpoint not found');
      return;
    }
    const ticket = url.searchParams.get('ticket');
    const record = ticket ? tickets.get(ticket) : undefined;
    if (ticket) tickets.delete(ticket);
    if (!record || record.expiresAt <= Date.now() || record.remoteAddress !== (req.socket.remoteAddress || null)) {
      rejectUpgrade(socket, 401, 'Missing, expired, or already-used WebSocket ticket');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return { tickets };
}

module.exports = { DEFAULT_TICKET_TTL_MS, installWebSocketAuth };
