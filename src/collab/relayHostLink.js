const EventEmitter = require('events');
const WebSocket = require('ws');

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
}

// Stands in for a real per-connection websocket so CollaborationHostServer can keep
// treating every collaborator as an independent socket, even though all traffic
// actually flows over one connection to the relay server.
class RelayPeerSocket {
  constructor(connId, link) {
    this.connId = connId;
    this.link = link;
    this.readyState = WebSocket.OPEN;
  }

  send(raw) {
    this.link.sendToPeer(this.connId, raw);
  }

  close() {
    this.link.kickPeer(this.connId);
  }
}

class RelayHostLink extends EventEmitter {
  constructor(relayUrl) {
    super();
    this.relayUrl = relayUrl;
    this.ws = null;
    this.code = null;
    this.sessionId = null;
  }

  connect(requestedCode) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new WebSocket(this.relayUrl);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = socket;

      socket.on('open', () => {
        socket.send(JSON.stringify({ kind: 'register-host', code: requestedCode || undefined }));
      });

      socket.on('message', (raw) => {
        const packet = safeJsonParse(raw);
        if (!packet || typeof packet.kind !== 'string') {
          return;
        }

        if (packet.kind === 'host-registered') {
          this.code = packet.code;
          this.sessionId = packet.sessionId;
          settled = true;
          resolve({ code: packet.code, sessionId: packet.sessionId });
          return;
        }

        if (packet.kind === 'error') {
          if (!settled) {
            settled = true;
            reject(new Error(packet.message || 'Relay server rejected the connection.'));
          }
          return;
        }

        if (packet.kind === 'peer-joined') {
          this.emit('peer-joined', packet.connId);
          return;
        }

        if (packet.kind === 'peer-left') {
          this.emit('peer-left', packet.connId);
          return;
        }

        if (packet.kind === 'relay') {
          this.emit('peer-message', packet.from, JSON.stringify(packet.data));
        }
      });

      socket.on('close', () => {
        this.emit('closed');
        if (!settled) {
          settled = true;
          reject(new Error('Collaboration relay connection was closed.'));
        }
      });

      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  createPeerSocket(connId) {
    return new RelayPeerSocket(connId, this);
  }

  sendToPeer(connId, raw) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const data = safeJsonParse(raw);
    if (data === null) {
      return;
    }
    this.ws.send(JSON.stringify({ kind: 'relay', to: connId, data }));
  }

  kickPeer(connId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ kind: 'kick-peer', connId }));
  }

  disconnect() {
    if (!this.ws) {
      return;
    }
    try {
      this.ws.close();
    } catch {
      // Ignore close errors.
    }
    this.ws = null;
  }
}

module.exports = { RelayHostLink };
