const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');
const ignore = require('ignore');
const {
  normalizeOperation,
  transformOperationAgainstApplied,
  applyOperationBatchToText
} = require('./ot');

const EDIT_ACTIVITY_IDLE_MS = 1200;

function randomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return output;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createTreeNodeSnapshot(node, projectPath) {
  const rel = path.relative(projectPath, node.path).split(path.sep).join('/');
  const base = {
    name: node.name,
    path: rel,
    type: node.type,
    ignored: Boolean(node.ignored)
  };

  if (node.type === 'folder') {
    base.children = Array.isArray(node.children)
      ? node.children.map((child) => createTreeNodeSnapshot(child, projectPath))
      : [];
  }

  return base;
}

function filterIgnoredNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const filtered = [];
  for (const node of list) {
    if (!node || node.ignored) {
      continue;
    }

    if (node.type === 'folder') {
      filtered.push({
        ...node,
        children: filterIgnoredNodes(node.children)
      });
      continue;
    }

    filtered.push(node);
  }

  return filtered;
}

class CollaborationHostServer {
  constructor(options = {}) {
    this.getProjectPath = options.getProjectPath;
    this.buildTreeSnapshot = options.buildTreeSnapshot;
    this.emitToHostRenderer = options.emitToHostRenderer;
    this.onServerStopped = options.onServerStopped;

    this.wss = null;
    this.sessionId = null;
    this.sessionCode = null;
    this.port = null;
    this.hostSenderId = null;
    this.sessionHostClientId = null;
    this.projectPath = null;
    this.gitignoreMatcher = null;

    this.clients = new Map();
    this.fileStates = new Map();
    this.editActivityTimers = new Map();
  }

  isRunning() {
    return Boolean(this.wss);
  }

  getInfo() {
    if (!this.isRunning()) {
      return {
        running: false,
        clients: []
      };
    }

    const clients = [];
    for (const client of this.clients.values()) {
      clients.push({
        clientId: client.clientId,
        name: client.name,
        isHostClient: client.isHostClient,
        currentFile: client.currentFile || null,
        lastSeenAt: client.lastSeenAt
      });
    }

    return {
      running: true,
      sessionId: this.sessionId,
      code: this.sessionCode,
      port: this.port,
      projectName: path.basename(this.projectPath || ''),
      clients
    };
  }

  stop() {
    if (!this.wss) {
      return;
    }

    for (const socket of this.clients.keys()) {
      try {
        socket.close();
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    this.clients.clear();
    this.fileStates.clear();

    for (const timer of this.editActivityTimers.values()) {
      clearTimeout(timer);
    }
    this.editActivityTimers.clear();

    try {
      this.wss.close();
    } catch {
      // Ignore close errors.
    }

    this.wss = null;
    this.sessionId = null;
    this.sessionCode = null;
    this.port = null;
    this.hostSenderId = null;
    this.sessionHostClientId = null;
    this.projectPath = null;
    this.gitignoreMatcher = null;

    if (typeof this.onServerStopped === 'function') {
      this.onServerStopped();
    }
  }

  async start(senderId, requestedPort) {
    if (this.isRunning()) {
      return this.getInfo();
    }

    const projectPath = this.getProjectPath(senderId);
    if (!projectPath) {
      throw new Error('Open a project before starting collaboration.');
    }

    this.projectPath = projectPath;
    this.gitignoreMatcher = await this.createGitignoreMatcher(projectPath);
    this.hostSenderId = senderId;
    this.sessionId = randomUUID ? randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.sessionCode = randomCode(6);

    this.wss = new WebSocketServer({
      host: '0.0.0.0',
      port: Number.isFinite(Number(requestedPort)) ? Number(requestedPort) : 0
    });

    this.wss.on('connection', (socket) => {
      this.handleSocketConnection(socket);
    });

    await new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });

    const address = this.wss.address();
    this.port = address && typeof address === 'object' ? address.port : null;

    return this.getInfo();
  }

  async handleSocketConnection(socket) {
    socket.on('message', async (raw) => {
      await this.handleSocketMessage(socket, raw);
    });

    socket.on('close', () => {
      this.removeClient(socket);
    });

    socket.on('error', () => {
      this.removeClient(socket);
    });
  }

  send(socket, type, payload = {}) {
    if (!socket || socket.readyState !== 1) {
      return;
    }

    socket.send(JSON.stringify({ type, ...payload }));
  }

  broadcast(type, payload = {}, exceptSocket = null) {
    for (const socket of this.clients.keys()) {
      if (exceptSocket && socket === exceptSocket) {
        continue;
      }
      this.send(socket, type, payload);
    }
  }

  emitHostEvent(type, payload = {}) {
    if (typeof this.emitToHostRenderer === 'function') {
      this.emitToHostRenderer(this.hostSenderId, {
        type,
        payload
      });
    }
  }

  removeClient(socket) {
    const client = this.clients.get(socket);
    if (!client) {
      return;
    }

    this.clients.delete(socket);
    if (this.sessionHostClientId && client.clientId === this.sessionHostClientId) {
      this.sessionHostClientId = null;
    }
    this.clearEditActivityForClient(client.clientId);
    this.broadcast('presence:left', {
      clientId: client.clientId,
      name: client.name,
      at: Date.now()
    });
  }

  getPresenceList() {
    const list = [];
    for (const client of this.clients.values()) {
      list.push({
        clientId: client.clientId,
        name: client.name,
        currentFile: client.currentFile || null,
        isHostClient: client.isHostClient
      });
    }
    return list;
  }

  getSocketByClientId(clientId) {
    for (const [socket, client] of this.clients.entries()) {
      if (client && client.clientId === clientId) {
        return socket;
      }
    }
    return null;
  }

  getUniqueClientName(desiredName) {
    const baseCandidate = String(desiredName || '').trim() || 'Collaborator';
    const maxLength = 40;
    const normalize = (value) => String(value || '').trim().toLowerCase();

    const taken = new Set();
    for (const client of this.clients.values()) {
      taken.add(normalize(client && client.name));
    }

    const base = baseCandidate.slice(0, maxLength);
    if (!taken.has(normalize(base))) {
      return base;
    }

    for (let suffix = 1; suffix <= 9999; suffix += 1) {
      const suffixText = String(suffix);
      const trimmedBase = base.slice(0, Math.max(1, maxLength - suffixText.length));
      const candidate = `${trimmedBase}${suffixText}`;
      if (!taken.has(normalize(candidate))) {
        return candidate;
      }
    }

    return `${Date.now()}`.slice(-maxLength);
  }

  getCursorSnapshotForFile(filePath, excludeClientId = null) {
    const targetPath = String(filePath || '');
    if (!targetPath) {
      return [];
    }

    const cursors = [];
    for (const client of this.clients.values()) {
      if (!client || !client.clientId || (excludeClientId && client.clientId === excludeClientId)) {
        continue;
      }

      const lastCursor = client.lastCursor;
      if (!lastCursor || String(lastCursor.filePath || '') !== targetPath) {
        continue;
      }

      cursors.push({
        clientId: client.clientId,
        name: client.name,
        filePath: targetPath,
        position: lastCursor.position || null,
        selection: lastCursor.selection || null,
        at: lastCursor.at || Date.now()
      });
    }

    return cursors;
  }

  resolveRelativePath(inputPath) {
    const rel = String(inputPath || '').replace(/^[\\/]+/, '');
    const abs = path.resolve(this.projectPath, rel);
    if (!abs.startsWith(path.resolve(this.projectPath) + path.sep) && abs !== path.resolve(this.projectPath)) {
      throw new Error('Path is outside the shared project.');
    }
    return {
      relativePath: rel.split(path.sep).join('/'),
      absolutePath: abs
    };
  }

  async createGitignoreMatcher(projectPath) {
    const matcher = ignore();
    matcher.add('.git/');

    const gitignorePath = path.join(projectPath, '.gitignore');
    try {
      const content = await fs.readFile(gitignorePath, 'utf8');
      matcher.add(content);
    } catch {
      // .gitignore is optional.
    }

    return matcher;
  }

  isIgnoredRelativePath(relativePath, isDirectory) {
    if (!this.gitignoreMatcher) {
      return false;
    }

    const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.startsWith('..')) {
      return false;
    }

    return this.gitignoreMatcher.ignores(isDirectory ? `${rel}/` : rel);
  }

  isSharedPath(relativePath, isDirectory = false) {
    return !this.isIgnoredRelativePath(relativePath, isDirectory);
  }

  async buildSnapshotPayload() {
    const fullTree = await this.buildTreeSnapshot(this.projectPath);
    const sharedTree = filterIgnoredNodes(fullTree.tree || []);
    const snapshotTree = sharedTree.map((node) => createTreeNodeSnapshot(node, this.projectPath));
    return {
      rootName: path.basename(this.projectPath),
      tree: snapshotTree
    };
  }

  async getFileState(relativePath) {
    const normalized = String(relativePath || '').replace(/^[\\/]+/, '').split(path.sep).join('/');
    if (this.fileStates.has(normalized)) {
      return this.fileStates.get(normalized);
    }

    const resolved = this.resolveRelativePath(normalized);
    const content = await fs.readFile(resolved.absolutePath, 'utf8');
    const state = {
      filePath: normalized,
      content,
      history: []
    };
    this.fileStates.set(normalized, state);
    return state;
  }

  async handleSocketMessage(socket, raw) {
    const packet = safeJsonParse(String(raw || ''));
    if (!packet || typeof packet.type !== 'string') {
      this.send(socket, 'error', { message: 'Invalid collaboration message.' });
      return;
    }

    if (packet.type === 'join') {
      await this.handleJoin(socket, packet);
      return;
    }

    const client = this.clients.get(socket);
    if (!client) {
      this.send(socket, 'error', { message: 'Join a session first.' });
      return;
    }

    client.lastSeenAt = Date.now();

    if (packet.type === 'file:get') {
      await this.handleFileGet(socket, packet, client);
      return;
    }

    if (packet.type === 'file:ops') {
      await this.handleFileOps(socket, packet, client);
      return;
    }

    if (packet.type === 'cursor:update') {
      this.handleCursorUpdate(socket, packet, client);
      return;
    }

    if (packet.type === 'file:operation') {
      await this.handleFileOperation(socket, packet, client);
      return;
    }

    if (packet.type === 'client:kick') {
      await this.handleClientKick(socket, packet, client);
      return;
    }

    if (packet.type === 'presence:file') {
      const nextFilePath = String(packet.filePath || '');
      client.currentFile = this.isSharedPath(nextFilePath, false) ? nextFilePath : '';
      this.broadcast('presence:update', {
        clientId: client.clientId,
        name: client.name,
        currentFile: client.currentFile
      });

      this.send(socket, 'cursor:snapshot', {
        filePath: client.currentFile,
        cursors: this.getCursorSnapshotForFile(client.currentFile, client.clientId)
      });
    }
  }

  getEditActivityKey(clientId, filePath) {
    return `${String(clientId || '')}::${String(filePath || '')}`;
  }

  clearEditActivityForClient(clientId) {
    const prefix = `${String(clientId || '')}::`;
    for (const [key, timer] of this.editActivityTimers.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      clearTimeout(timer);
      this.editActivityTimers.delete(key);
    }
  }

  scheduleEditActivity(client, filePath) {
    if (!client || !client.clientId || !filePath) {
      return;
    }

    const key = this.getEditActivityKey(client.clientId, filePath);
    const existingTimer = this.editActivityTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.editActivityTimers.delete(key);

      this.broadcast('activity:add', {
        level: 'edit',
        message: `${client.name} edited ${filePath}`,
        at: Date.now(),
        clientId: client.clientId,
        filePath
      });
    }, EDIT_ACTIVITY_IDLE_MS);

    this.editActivityTimers.set(key, timer);
  }

  async handleJoin(socket, packet) {
    const incomingCode = String(packet.code || '').trim().toUpperCase();
    if (!incomingCode || incomingCode !== this.sessionCode) {
      this.send(socket, 'join:error', {
        requestId: packet.requestId || null,
        message: 'Invalid collaboration code.'
      });
      return;
    }

    const clientId = randomUUID ? randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const requestedName = String(packet.name || 'Collaborator').trim().slice(0, 40) || 'Collaborator';
    const clientName = this.getUniqueClientName(requestedName);
    const isHostClient = packet.mode === 'host';
    const client = {
      clientId,
      name: clientName,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      currentFile: null,
      lastCursor: null,
      isHostClient
    };

    this.clients.set(socket, client);
    if (!this.sessionHostClientId && isHostClient) {
      this.sessionHostClientId = clientId;
    }

    const snapshot = await this.buildSnapshotPayload();
    this.send(socket, 'join:ok', {
      requestId: packet.requestId || null,
      clientId,
      name: clientName,
      isSessionHost: clientId === this.sessionHostClientId,
      sessionId: this.sessionId,
      code: this.sessionCode,
      snapshot,
      presence: this.getPresenceList()
    });

    this.broadcast('presence:joined', {
      clientId,
      name: clientName,
      isHostClient,
      at: Date.now()
    }, socket);
  }

  async handleFileGet(socket, packet, client) {
    const targetPath = String(packet.filePath || '').replace(/^[\\/]+/, '');
    if (!this.isSharedPath(targetPath, false)) {
      this.send(socket, 'file:get:error', {
        requestId: packet.requestId || null,
        message: 'That path is not shared in this session.'
      });
      return;
    }

    const fileState = await this.getFileState(targetPath);
    this.send(socket, 'file:data', {
      requestId: packet.requestId || null,
      filePath: targetPath,
      content: fileState.content,
      version: fileState.history.length
    });
  }

  async handleFileOps(socket, packet, client) {
    const filePath = String(packet.filePath || '').replace(/^[\\/]+/, '');
    if (!this.isSharedPath(filePath, false)) {
      this.send(socket, 'file:ops:error', {
        requestId: packet.requestId || null,
        message: 'That path is not shared in this session.'
      });
      return;
    }

    const requestedBaseVersion = Math.max(0, Number(packet.baseVersion) || 0);
    const incomingOps = Array.isArray(packet.ops) ? packet.ops.map((entry) => normalizeOperation(entry)) : [];
    if (!filePath || !incomingOps.length) {
      return;
    }

    const fileState = await this.getFileState(filePath);
    const currentVersion = fileState.history.length;

    if (requestedBaseVersion > currentVersion) {
      this.send(socket, 'file:sync', {
        filePath,
        content: fileState.content,
        version: currentVersion
      });
      return;
    }

    let transformedOps = incomingOps;
    if (requestedBaseVersion < currentVersion) {
      const historySlice = fileState.history.slice(requestedBaseVersion);
      transformedOps = transformedOps.map((op) => {
        let next = op;
        for (const applied of historySlice) {
          next = transformOperationAgainstApplied(next, applied);
        }
        return next;
      });
    }

    fileState.content = applyOperationBatchToText(fileState.content, transformedOps);
    for (const op of transformedOps) {
      fileState.history.push(op);
    }

    const resolved = this.resolveRelativePath(filePath);
    await fs.writeFile(resolved.absolutePath, fileState.content, 'utf8');

    const nextVersion = fileState.history.length;

    this.send(socket, 'file:ack', {
      requestId: packet.requestId || null,
      filePath,
      version: nextVersion
    });

    this.broadcast('file:ops', {
      filePath,
      fromClientId: client.clientId,
      fromVersion: requestedBaseVersion,
      toVersion: nextVersion,
      ops: transformedOps
    }, socket);

    this.scheduleEditActivity(client, filePath);
  }

  handleCursorUpdate(socket, packet, client) {
    const targetPath = String(packet.filePath || '');
    if (!this.isSharedPath(targetPath, false)) {
      return;
    }

    const payload = {
      clientId: client.clientId,
      name: client.name,
      filePath: targetPath,
      position: packet.position || null,
      selection: packet.selection || null,
      at: Date.now()
    };

    client.lastCursor = {
      filePath: payload.filePath,
      position: payload.position,
      selection: payload.selection,
      at: payload.at
    };

    this.broadcast('cursor:update', payload, socket);
  }

  async handleClientKick(socket, packet, requester) {
    const requestId = packet && packet.requestId ? packet.requestId : null;
    if (!this.sessionHostClientId || requester.clientId !== this.sessionHostClientId) {
      this.send(socket, 'client:kick:error', {
        requestId,
        message: 'Only the session host can remove collaborators.'
      });
      return;
    }

    const targetClientId = String(packet.targetClientId || '').trim();
    if (!targetClientId) {
      this.send(socket, 'client:kick:error', {
        requestId,
        message: 'Missing target collaborator.'
      });
      return;
    }

    if (targetClientId === requester.clientId) {
      this.send(socket, 'client:kick:error', {
        requestId,
        message: 'You cannot remove yourself.'
      });
      return;
    }

    const targetSocket = this.getSocketByClientId(targetClientId);
    const targetClient = targetSocket ? this.clients.get(targetSocket) : null;
    if (!targetSocket || !targetClient) {
      this.send(socket, 'client:kick:error', {
        requestId,
        message: 'Collaborator is no longer connected.'
      });
      return;
    }

    this.send(socket, 'client:kick:ok', {
      requestId,
      targetClientId,
      targetName: targetClient.name
    });

    this.send(targetSocket, 'session:kicked', {
      byClientId: requester.clientId,
      byName: requester.name,
      at: Date.now()
    });

    this.broadcast('activity:add', {
      level: 'moderation',
      message: `${requester.name} removed ${targetClient.name}`,
      at: Date.now(),
      clientId: requester.clientId
    });

    try {
      targetSocket.close();
    } catch {
      // Ignore close failures.
    }
  }

  async handleFileOperation(socket, packet, client) {
    const operation = packet && typeof packet.operation === 'object' ? packet.operation : null;
    if (!operation || typeof operation.type !== 'string') {
      return;
    }

    const type = operation.type;
    if (!client.isHostClient) {
      if (type === 'create-file') {
        const parent = this.resolveRelativePath(String(operation.parentPath || ''));
        const name = String(operation.name || '').trim();
        if (!name) {
          throw new Error('File name is required.');
        }
        const relativeTarget = path.join(parent.relativePath, name).split(path.sep).join('/');
        if (!this.isSharedPath(parent.relativePath, true) || !this.isSharedPath(relativeTarget, false)) {
          throw new Error('Cannot create files in ignored paths.');
        }
        await fs.writeFile(path.join(parent.absolutePath, name), '', { flag: 'wx' });
      } else if (type === 'create-folder') {
        const parent = this.resolveRelativePath(String(operation.parentPath || ''));
        const name = String(operation.name || '').trim();
        if (!name) {
          throw new Error('Folder name is required.');
        }
        const relativeTarget = path.join(parent.relativePath, name).split(path.sep).join('/');
        if (!this.isSharedPath(parent.relativePath, true) || !this.isSharedPath(relativeTarget, true)) {
          throw new Error('Cannot create folders in ignored paths.');
        }
        await fs.mkdir(path.join(parent.absolutePath, name));
      } else if (type === 'delete') {
        const target = this.resolveRelativePath(String(operation.targetPath || ''));
        const stat = await fs.stat(target.absolutePath);
        if (!this.isSharedPath(target.relativePath, stat.isDirectory())) {
          throw new Error('Cannot modify ignored paths.');
        }
        if (stat.isDirectory()) {
          await fs.rm(target.absolutePath, { recursive: true, force: false });
        } else {
          await fs.unlink(target.absolutePath);
        }
      } else if (type === 'rename') {
        const target = this.resolveRelativePath(String(operation.targetPath || ''));
        const newName = String(operation.newName || '').trim();
        if (!newName) {
          throw new Error('New name is required.');
        }
        const stat = await fs.stat(target.absolutePath);
        const destinationRelativePath = path.join(path.dirname(target.relativePath), newName).split(path.sep).join('/');
        if (!this.isSharedPath(target.relativePath, stat.isDirectory()) || !this.isSharedPath(destinationRelativePath, stat.isDirectory())) {
          throw new Error('Cannot rename ignored paths.');
        }
        const destination = path.join(path.dirname(target.absolutePath), newName);
        await fs.rename(target.absolutePath, destination);
      } else {
        return;
      }
    }

    const snapshot = await this.buildSnapshotPayload();
    this.broadcast('tree:update', {
      tree: snapshot.tree,
      rootName: snapshot.rootName
    });

    this.broadcast('activity:add', {
      level: 'file-op',
      message: `${client.name} performed ${type}`,
      at: Date.now()
    });

    this.send(socket, 'file:operation:ok', {
      requestId: packet.requestId || null,
      type
    });
  }
}

module.exports = {
  CollaborationHostServer
};