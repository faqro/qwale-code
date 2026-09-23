const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const HEARTBEAT_INTERVAL_MS = 30000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += CODE_ALPHABET.charAt(crypto.randomInt(CODE_ALPHABET.length));
  }
  return output;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
}

function send(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

// A session represents one QwaleCode host sharing a project. Clients (including the
// host's own editor window) join the session by code and are relayed to the host socket.
class Session {
  constructor(code) {
    this.code = code;
    this.sessionId = crypto.randomUUID();
    this.hostSocket = null;
    this.participants = new Map(); // connId -> socket
    this.createdAt = Date.now();
  }
}

const sessions = new Map(); // code -> Session

function generateUniqueCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = randomCode(6);
    if (!sessions.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to allocate a session code.');
}

function destroySession(session, reason) {
  if (!session) {
    return;
  }

  sessions.delete(session.code);
  for (const participantSocket of session.participants.values()) {
    send(participantSocket, { kind: 'host-left', message: reason || 'Host ended the session.' });
    try {
      participantSocket.close();
    } catch {
      // Ignore close errors during teardown.
    }
  }
  session.participants.clear();
}

function handleRegisterHost(socket, packet) {
  if (socket.role) {
    send(socket, { kind: 'error', message: 'This connection is already registered.' });
    return;
  }

  let code = String(packet.code || '').trim().toUpperCase();
  if (code && sessions.has(code)) {
    send(socket, { kind: 'error', message: 'That session code is already in use.' });
    return;
  }
  if (!code) {
    code = generateUniqueCode();
  }

  const session = new Session(code);
  session.hostSocket = socket;
  sessions.set(code, session);

  socket.role = 'host';
  socket.sessionCode = code;

  send(socket, { kind: 'host-registered', code, sessionId: session.sessionId });
}

function handleJoinSession(socket, packet) {
  if (socket.role) {
    send(socket, { kind: 'error', message: 'This connection is already registered.' });
    return;
  }

  const code = String(packet.code || '').trim().toUpperCase();
  const session = sessions.get(code);
  if (!session || !session.hostSocket || session.hostSocket.readyState !== WebSocket.OPEN) {
    send(socket, { kind: 'error', message: 'Session not found. Check the code and try again.' });
    return;
  }

  const connId = crypto.randomUUID();
  session.participants.set(connId, socket);

  socket.role = 'client';
  socket.connId = connId;
  socket.sessionCode = code;

  send(socket, { kind: 'session-joined', connId, sessionId: session.sessionId });
  send(session.hostSocket, { kind: 'peer-joined', connId });
}

// Data messages are always addressed to a single participant (the host already knows
// how to fan a message out to every collaborator), so the relay never needs to broadcast.
function handleRelayData(socket, packet) {
  const session = sessions.get(socket.sessionCode || '');
  if (!session) {
    send(socket, { kind: 'error', message: 'Not part of an active session.' });
    return;
  }

  if (socket.role === 'client') {
    send(session.hostSocket, { kind: 'relay', from: socket.connId, data: packet.data });
    return;
  }

  if (socket.role === 'host') {
    const targetSocket = session.participants.get(String(packet.to || ''));
    if (targetSocket) {
      send(targetSocket, { kind: 'relay', from: 'host', data: packet.data });
    }
  }
}

function handleKickPeer(socket, packet) {
  if (socket.role !== 'host') {
    return;
  }

  const session = sessions.get(socket.sessionCode || '');
  if (!session) {
    return;
  }

  const targetSocket = session.participants.get(String(packet.connId || ''));
  if (targetSocket) {
    try {
      targetSocket.close();
    } catch {
      // Ignore close errors.
    }
  }
}

function handleDisconnect(socket) {
  if (socket.role === 'host' && socket.sessionCode) {
    const session = sessions.get(socket.sessionCode);
    if (session && session.hostSocket === socket) {
      destroySession(session, 'Host disconnected.');
    }
    return;
  }

  if (socket.role === 'client' && socket.sessionCode) {
    const session = sessions.get(socket.sessionCode);
    if (!session) {
      return;
    }
    session.participants.delete(socket.connId);
    send(session.hostSocket, { kind: 'peer-left', connId: socket.connId });
  }
}

function handleMessage(socket, packet) {
  switch (packet.kind) {
    case 'register-host':
      handleRegisterHost(socket, packet);
      return;
    case 'join-session':
      handleJoinSession(socket, packet);
      return;
    case 'relay':
      handleRelayData(socket, packet);
      return;
    case 'kick-peer':
      handleKickPeer(socket, packet);
      return;
    default:
      send(socket, { kind: 'error', message: `Unknown message kind: ${packet.kind}` });
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/sessions/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const session = sessions.get(code);
  res.json({ exists: Boolean(session), participantCount: session ? session.participants.size : 0 });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.role = null; // 'host' | 'client'
  socket.connId = null;
  socket.sessionCode = null;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    const packet = safeJsonParse(raw);
    if (!packet || typeof packet.kind !== 'string') {
      send(socket, { kind: 'error', message: 'Invalid relay message.' });
      return;
    }
    handleMessage(socket, packet);
  });

  socket.on('close', () => handleDisconnect(socket));
  socket.on('error', () => handleDisconnect(socket));
});

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      try {
        socket.terminate();
      } catch {
        // Ignore terminate errors.
      }
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      // Ignore ping errors.
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

server.listen(PORT, () => {
  console.log(`QwaleCode relay server listening on port ${PORT}`);
});

module.exports = { app, server };
