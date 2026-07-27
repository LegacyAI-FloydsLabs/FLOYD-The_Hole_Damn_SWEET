'use strict';

const http = require('node:http');
const WebSocket = require('ws');

function allowedOrigin(port, host = '127.0.0.1') {
  return `http://${host}:${port}`;
}

function requestTicket(port, origin = allowedOrigin(port), host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: host,
      port,
      path: '/api/ws-ticket',
      method: 'POST',
      headers: { Origin: origin, Accept: 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 201) return reject(new Error(`ticket request failed (${response.statusCode}): ${body}`));
        resolve(JSON.parse(body).ticket);
      });
    });
    request.once('error', reject);
    request.end();
  });
}

async function createTestWebSocket(port, host = '127.0.0.1') {
  const origin = allowedOrigin(port, host);
  const ticket = await requestTicket(port, origin, host);
  return new WebSocket(`ws://${host}:${port}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { Origin: origin } });
}

module.exports = { allowedOrigin, createTestWebSocket, requestTicket };
