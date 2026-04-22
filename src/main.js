const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const pty = require('node-pty');
const ignore = require('ignore');
const { spawnSync } = require('child_process');
const { execFile } = require('child_process');
const { networkInterfaces } = require('os');
const { CollaborationHostServer } = require('./collab/server');
const { updateElectronApp, UpdateSourceType } = require('update-electron-app');

if (require('electron-squirrel-startup')) { //prevent duplicate startups from electron squirrel setup
  app.quit();
}

const enforceSingleInstance = app.isPackaged;
if (enforceSingleInstance) {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  }

  app.on('second-instance', () => {
    const targetWindow = getTargetWindow() || createWindow();
    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }
    targetWindow.focus();
  });
}

let mainWindow = null;
const terminals = new Map();
let recentProjects = [];
const windowProjectState = new Map();
const windowInitialProject = new Map();
const projectWatchers = new Map();
const metaFieldPattern = /^(?:_.*|timestamp|time|createdat|updatedat|requestid|traceid|metadata|meta|servertime|duration|elapsed)$/i;
let collaborationHostServer = null;
const filteredDevtoolsContents = new WeakSet();

function getServerHostCandidates() {
  const hosts = new Set(['127.0.0.1', 'localhost']);
  const nets = networkInterfaces();

  for (const entries of Object.values(nets || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') {
        continue;
      }
      hosts.add(entry.address);
    }
  }

  return [...hosts];
}

function killTerminalSession(termId) {
  const session = terminals.get(termId);
  if (!session) {
    return;
  }

  try {
    session.ptyProcess.kill();
  } catch {
    // Ignore teardown failures while closing terminal sessions.
  }

  terminals.delete(termId);
}

function killTerminalsForWebContents(webContentsId) {
  for (const [id, term] of terminals.entries()) {
    if (term.webContentsId === webContentsId) {
      killTerminalSession(id);
    }
  }
}

function killAllTerminals() {
  for (const termId of terminals.keys()) {
    killTerminalSession(termId);
  }
}

function stopProjectWatcherForWebContents(webContentsId) {
  const watcherEntry = projectWatchers.get(webContentsId);
  if (!watcherEntry) {
    return;
  }

  if (watcherEntry.timer) {
    clearTimeout(watcherEntry.timer);
  }

  try {
    watcherEntry.watcher.close();
  } catch {
    // Ignore watcher close errors during teardown.
  }

  projectWatchers.delete(webContentsId);
}

function stopAllProjectWatchers() {
  for (const webContentsId of projectWatchers.keys()) {
    stopProjectWatcherForWebContents(webContentsId);
  }
}

function sendCollabEventToRenderer(webContentsId, payload) {
  const targetWindow = BrowserWindow
    .getAllWindows()
    .find((win) => !win.isDestroyed() && win.webContents.id === webContentsId);
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send('collab:event', payload);
}

function notifyProjectChanged(webContentsId, expectedProjectPath) {
  const currentProjectPath = windowProjectState.get(webContentsId);
  if (!currentProjectPath || path.resolve(currentProjectPath) !== path.resolve(expectedProjectPath)) {
    return;
  }

  const targetWindow = BrowserWindow
    .getAllWindows()
    .find((win) => !win.isDestroyed() && win.webContents.id === webContentsId);
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send('project:changed', {
    rootPath: currentProjectPath
  });
}

function scheduleProjectChangedNotification(webContentsId, expectedProjectPath) {
  const watcherEntry = projectWatchers.get(webContentsId);
  if (!watcherEntry) {
    return;
  }

  if (watcherEntry.timer) {
    clearTimeout(watcherEntry.timer);
  }

  watcherEntry.timer = setTimeout(() => {
    watcherEntry.timer = null;
    notifyProjectChanged(webContentsId, expectedProjectPath);
  }, 250);
}

function startProjectWatcherForWebContents(webContentsId, projectPath) {
  stopProjectWatcherForWebContents(webContentsId);

  if (!projectPath) {
    return;
  }

  const normalizedProjectPath = path.resolve(projectPath);

  try {
    const watcher = fs.watch(normalizedProjectPath, { recursive: true }, () => {
      scheduleProjectChangedNotification(webContentsId, normalizedProjectPath);
    });

    projectWatchers.set(webContentsId, {
      watcher,
      rootPath: normalizedProjectPath,
      timer: null
    });
  } catch {
    // If watcher setup fails, project refresh remains manual.
  }
}

function configureChromiumStoragePaths() {
  try {
    const localBase = process.env.LOCALAPPDATA || path.join(os.tmpdir(), 'QwaleCode');
    const sessionDataPath = path.join(localBase, 'QwaleCode', 'session-data');
    const diskCachePath = path.join(sessionDataPath, 'Cache');

    fs.mkdirSync(sessionDataPath, { recursive: true });
    fs.mkdirSync(diskCachePath, { recursive: true });

    app.setPath('sessionData', sessionDataPath);
    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath);
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  } catch {
    // Fall back to Electron defaults if path setup fails.
  }
}

configureChromiumStoragePaths();

function initAutoUpdates() {
  if (!app.isPackaged) {
    return;
  }

  try {
    const updaterLogger = {
      log: (...args) => console.log('[auto-update]', ...args)
    };

    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: 'faqro/qwale-code',
        host: 'https://update.electronjs.org'
      },
      updateInterval: '10 minutes',
      notifyUser: true,
      logger: updaterLogger
    });

    console.log('[auto-update] updateElectronApp initialized');
  } catch (error) {
    // App should still run if updater initialization fails.
    console.error('Auto-update initialization failed:', error);
  }
}
initAutoUpdates();

function simplifyResponseData(value, depth = 0) {
  if (depth > 8 || value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 250).map((entry) => simplifyResponseData(entry, depth + 1));
  }

  if (typeof value !== 'object') {
    return value;
  }

  const preferredKeys = ['data', 'result', 'results', 'items', 'item', 'object', 'payload'];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return simplifyResponseData(value[key], depth + 1);
    }
  }

  const simplified = {};
  for (const [key, entry] of Object.entries(value)) {
    if (metaFieldPattern.test(key)) {
      continue;
    }
    simplified[key] = simplifyResponseData(entry, depth + 1);
  }

  if (Object.keys(simplified).length > 0) {
    return simplified;
  }

  return value;
}

function getRecentProjectsFilePath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

async function loadRecentProjects() {
  try {
    const filePath = getRecentProjectsFilePath();
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    recentProjects = Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
  } catch {
    recentProjects = [];
  }
}

async function persistRecentProjects() {
  const filePath = getRecentProjectsFilePath();
  await fsp.writeFile(filePath, JSON.stringify(recentProjects, null, 2), 'utf8');
}

async function rememberRecentProject(projectPath) {
  const normalized = path.resolve(projectPath);
  recentProjects = [normalized, ...recentProjects.filter((entry) => entry !== normalized)].slice(0, 10);
  await persistRecentProjects();
  createAppMenu();
}

function getTargetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    return focused;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  return null;
}

function sendMenuAction(action, payload = {}) {
  const targetWindow = getTargetWindow();
  if (!targetWindow) {
    return;
  }

  targetWindow.webContents.send('menu:action', { action, payload });
}

function createAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('project:open')
        },
        {
          label: 'Open Recent',
          enabled: recentProjects.length > 0,
          submenu: recentProjects.length
            ? [
                ...recentProjects.map((projectPath) => ({
                  label: projectPath,
                  click: () => sendMenuAction('project:openRecent', { path: projectPath })
                })),
                { type: 'separator' },
                {
                  label: 'Clear Recents',
                  click: () => {
                    recentProjects = [];
                    persistRecentProjects().then(() => createAppMenu()).catch(() => {});
                    sendMenuAction('project:recentCleared');
                  }
                }
              ]
            : []
        },
        {
          label: 'Close Folder',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => sendMenuAction('project:closeFolder')
        },
        { type: 'separator' },
        {
          label: 'New File',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('project:newFile')
        },
        {
          label: 'New Folder',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => sendMenuAction('project:newFolder')
        },
        { type: 'separator' },
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('file:save')
        },
        {
          label: 'Save File As',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('file:saveAs')
        },
        {
          label: 'Save All Files',
          accelerator: 'CmdOrCtrl+Alt+S',
          click: () => sendMenuAction('file:saveAll')
        },
        { type: 'separator' },
        {
          label: 'Preferences',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('app:preferences')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendMenuAction('edit:find')
        },
        {
          label: 'Find & Replace',
          accelerator: 'CmdOrCtrl+H',
          click: () => sendMenuAction('edit:replace')
        },
        { type: 'separator' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' }
            ]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function isIgnorableDevtoolsConsoleWarning(message, sourceId) {
  if (!sourceId || !String(sourceId).startsWith('devtools://')) {
    return false;
  }

  const text = String(message || '');
  return (
    text.includes('Autofill.enable')
    || text.includes('Autofill.setAddresses')
  ) && text.includes("wasn't found");
}

function attachDevtoolsConsoleFilter(win) {
  if (!win || win.isDestroyed() || !win.webContents) {
    return;
  }

  const devtoolsContents = win.webContents.devToolsWebContents;
  if (!devtoolsContents || devtoolsContents.isDestroyed() || filteredDevtoolsContents.has(devtoolsContents)) {
    return;
  }

  devtoolsContents.on('console-message', (event, _level, message, _line, sourceId) => {
    if (!isIgnorableDevtoolsConsoleWarning(message, sourceId)) {
      return;
    }

    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  });

  filteredDevtoolsContents.add(devtoolsContents);
}

function toggleDevtoolsWithFilter(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  if (win.webContents.isDevToolsOpened()) {
    win.webContents.closeDevTools();
    return;
  }

  win.webContents.once('devtools-opened', () => {
    attachDevtoolsConsoleFilter(win);
  });

  win.webContents.openDevTools();
}

function createWindow(initialProjectPath = null) {
  const isWindows = process.platform === 'win32';

  const createdWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    icon: path.join(__dirname, 'renderer/assets/app-logo.png'),
    autoHideMenuBar: isWindows,
    backgroundColor: '#101822',
    ...(isWindows
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#101822',
            symbolColor: '#eef6ff',
            height: 34
          }
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const createdWebContentsId = createdWindow.webContents.id;

  createdWindow.webContents.on('devtools-opened', () => {
    attachDevtoolsConsoleFilter(createdWindow);
  });

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createdWindow;
  }

  windowProjectState.set(createdWebContentsId, initialProjectPath ? path.resolve(initialProjectPath) : null);
  startProjectWatcherForWebContents(createdWebContentsId, windowProjectState.get(createdWebContentsId));

  createdWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  createdWindow.setMenuBarVisibility(!isWindows);

  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) {
      mainWindow = null;
    }

    windowProjectState.delete(createdWebContentsId);
    stopProjectWatcherForWebContents(createdWebContentsId);
    killTerminalsForWebContents(createdWebContentsId);
  });

  return createdWindow;
}

function getProjectPathForSender(sender) {
  return windowProjectState.get(sender.id) || null;
}

function isWithinProject(candidatePath, projectPath) {
  if (!projectPath) {
    return false;
  }

  const absoluteProject = path.resolve(projectPath);
  const absoluteCandidate = path.resolve(candidatePath);

  return (
    absoluteCandidate === absoluteProject ||
    absoluteCandidate.startsWith(absoluteProject + path.sep)
  );
}

async function removePathRecursive(targetPath) {
  const stat = await fsp.stat(targetPath);
  if (stat.isDirectory()) {
    await fsp.rm(targetPath, { recursive: true, force: false });
  } else {
    await fsp.unlink(targetPath);
  }
}

function decodeBufferWithEncoding(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      content: buffer.slice(2).toString('utf16le'),
      encoding: 'UTF-16 LE'
    };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.slice(2));
    swapped.swap16();
    return {
      content: swapped.toString('utf16le'),
      encoding: 'UTF-16 BE'
    };
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return {
      content: buffer.slice(3).toString('utf8'),
      encoding: 'UTF-8'
    };
  }

  const isAscii = buffer.every((byte) => byte <= 0x7f);
  return {
    content: buffer.toString('utf8'),
    encoding: isAscii ? 'ASCII' : 'UTF-8'
  };
}

async function buildTree(dirPath, projectPath, matcher, inheritedIgnored = false) {
  const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  const folders = [];
  const files = [];
  const pendingFolderChildren = [];

  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      const ignored = inheritedIgnored || isIgnoredPath(matcher, projectPath, fullPath, true);
      const folderNode = {
        name: dirent.name,
        path: fullPath,
        type: 'folder',
        ignored,
        children: []
      };
      folders.push(folderNode);

      pendingFolderChildren.push(
        buildTree(fullPath, projectPath, matcher, ignored)
          .then((children) => {
            folderNode.children = children;
          })
      );
    } else {
      const ignored = inheritedIgnored || isIgnoredPath(matcher, projectPath, fullPath, false);
      files.push({
        name: dirent.name,
        path: fullPath,
        type: 'file',
        ignored
      });
    }
  }

  if (pendingFolderChildren.length > 0) {
    await Promise.all(pendingFolderChildren);
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...folders, ...files];
}

async function createGitignoreMatcher(projectPath) {
  const matcher = ignore();
  matcher.add('.git/');

  const gitignorePath = path.join(projectPath, '.gitignore');
  try {
    const content = await fsp.readFile(gitignorePath, 'utf8');
    matcher.add(content);
  } catch {
    // .gitignore is optional.
  }

  return matcher;
}

function toRelativePosixPath(projectPath, targetPath) {
  const rel = path.relative(projectPath, targetPath).split(path.sep).join('/');
  return rel;
}

function isIgnoredPath(matcher, projectPath, targetPath, isDirectory) {
  const relativePath = toRelativePosixPath(projectPath, targetPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return false;
  }

  return matcher.ignores(isDirectory ? `${relativePath}/` : relativePath);
}

async function buildSearchableFiles(dirPath, projectPath, matcher) {
  const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  const files = [];
  const pendingNestedFiles = [];

  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name);

    if (dirent.isDirectory()) {
      if (isIgnoredPath(matcher, projectPath, fullPath, true)) {
        continue;
      }
      pendingNestedFiles.push(buildSearchableFiles(fullPath, projectPath, matcher));
      continue;
    }

    if (isIgnoredPath(matcher, projectPath, fullPath, false)) {
      continue;
    }

    files.push(fullPath);
  }

  if (pendingNestedFiles.length > 0) {
    const nestedLists = await Promise.all(pendingNestedFiles);
    for (const nestedFiles of nestedLists) {
      files.push(...nestedFiles);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function buildProjectSnapshot(projectPath) {
  const matcher = await createGitignoreMatcher(projectPath);
  const [tree, searchableFiles] = await Promise.all([
    buildTree(projectPath, projectPath, matcher, false),
    buildSearchableFiles(projectPath, projectPath, matcher)
  ]);
  return {
    tree,
    searchableFiles
  };
}

function ensureCollaborationServer() {
  if (collaborationHostServer) {
    return collaborationHostServer;
  }

  collaborationHostServer = new CollaborationHostServer({
    getProjectPath: (senderId) => windowProjectState.get(senderId) || null,
    buildTreeSnapshot: buildProjectSnapshot,
    emitToHostRenderer: (senderId, payload) => {
      sendCollabEventToRenderer(senderId, payload);
    },
    onServerStopped: () => {
      collaborationHostServer = null;
    }
  });

  return collaborationHostServer;
}

ipcMain.handle('collab:startServer', async (event, payload = {}) => {
  const server = ensureCollaborationServer();
  const port = Number(payload.port) || 0;
  const info = await server.start(event.sender.id, port);
  const hosts = getServerHostCandidates();

  return {
    ...info,
    hosts,
    urls: hosts.map((host) => `ws://${host}:${info.port}`)
  };
});

ipcMain.handle('collab:stopServer', async () => {
  if (collaborationHostServer) {
    collaborationHostServer.stop();
    collaborationHostServer = null;
  }

  return { ok: true };
});

ipcMain.handle('collab:getServerInfo', async () => {
  if (!collaborationHostServer) {
    return {
      running: false,
      clients: [],
      hosts: getServerHostCandidates(),
      urls: []
    };
  }

  const info = collaborationHostServer.getInfo();
  const hosts = getServerHostCandidates();
  return {
    ...info,
    hosts,
    urls: info.running && info.port ? hosts.map((host) => `ws://${host}:${info.port}`) : []
  };
});

ipcMain.handle('collab:openJoinWindow', async (_event, payload = {}) => {
  const serverUrl = String(payload.serverUrl || '').trim();
  const code = String(payload.code || '').trim().toUpperCase();
  const name = String(payload.name || '').trim();

  if (!serverUrl || !code) {
    throw new Error('Enter both server URL and session code.');
  }

  const joinWindow = createWindow();
  joinWindow.webContents.once('did-finish-load', () => {
    if (joinWindow.isDestroyed()) {
      return;
    }

    joinWindow.webContents.send('menu:action', {
      action: 'collab:autoJoin',
      payload: {
        serverUrl,
        code,
        name
      }
    });
  });

  return { ok: true };
});

ipcMain.handle('project:open', async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  const result = await dialog.showOpenDialog(senderWindow || undefined, {
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const selectedProjectPath = path.resolve(result.filePaths[0]);
  await rememberRecentProject(selectedProjectPath);

  if (windowProjectState.get(event.sender.id)) {
    const newWindow = createWindow();
    windowInitialProject.set(newWindow.webContents.id, selectedProjectPath);
    return { openedInNewWindow: true };
  }

  windowProjectState.set(event.sender.id, selectedProjectPath);
  startProjectWatcherForWebContents(event.sender.id, selectedProjectPath);
  const matcher = await createGitignoreMatcher(selectedProjectPath);
  const [tree, searchableFiles] = await Promise.all([
    buildTree(selectedProjectPath, selectedProjectPath, matcher, false),
    buildSearchableFiles(selectedProjectPath, selectedProjectPath, matcher)
  ]);

  return {
    canceled: false,
    rootPath: selectedProjectPath,
    rootName: path.basename(selectedProjectPath),
    tree,
    searchableFiles
  };
});

ipcMain.handle('project:openPath', async (event, folderPath) => {
  if (!folderPath) {
    throw new Error('Invalid folder path.');
  }

  const resolved = path.resolve(folderPath);
  const stats = await fsp.stat(resolved);
  if (!stats.isDirectory()) {
    throw new Error('Recent path is not a folder.');
  }

  await rememberRecentProject(resolved);

  if (windowProjectState.get(event.sender.id)) {
    const newWindow = createWindow();
    windowInitialProject.set(newWindow.webContents.id, resolved);
    return { openedInNewWindow: true };
  }

  windowProjectState.set(event.sender.id, resolved);
  startProjectWatcherForWebContents(event.sender.id, resolved);
  const matcher = await createGitignoreMatcher(resolved);
  const [tree, searchableFiles] = await Promise.all([
    buildTree(resolved, resolved, matcher, false),
    buildSearchableFiles(resolved, resolved, matcher)
  ]);

  return {
    canceled: false,
    rootPath: resolved,
    rootName: path.basename(resolved),
    tree,
    searchableFiles
  };
});

ipcMain.handle('project:getRecent', async () => {
  return recentProjects;
});

ipcMain.handle('project:getInitial', async (event) => {
  const initialPath = windowInitialProject.get(event.sender.id);
  if (!initialPath) {
    return null;
  }
  windowInitialProject.delete(event.sender.id);

  windowProjectState.set(event.sender.id, initialPath);
  startProjectWatcherForWebContents(event.sender.id, initialPath);
  const matcher = await createGitignoreMatcher(initialPath);
  const [tree, searchableFiles] = await Promise.all([
    buildTree(initialPath, initialPath, matcher, false),
    buildSearchableFiles(initialPath, initialPath, matcher)
  ]);

  return {
    canceled: false,
    rootPath: initialPath,
    rootName: path.basename(initialPath),
    tree,
    searchableFiles
  };
});

ipcMain.handle('project:close', async (event) => {
  windowProjectState.set(event.sender.id, null);
  stopProjectWatcherForWebContents(event.sender.id);
  return { ok: true };
});

ipcMain.handle('project:clearRecent', async () => {
  recentProjects = [];
  await persistRecentProjects();
  createAppMenu();
  return { ok: true };
});

ipcMain.handle('project:refresh', async (event) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!currentProjectPath) {
    return { rootPath: null, rootName: '', tree: [], searchableFiles: [] };
  }

  const matcher = await createGitignoreMatcher(currentProjectPath);
  const [tree, searchableFiles] = await Promise.all([
    buildTree(currentProjectPath, currentProjectPath, matcher, false),
    buildSearchableFiles(currentProjectPath, currentProjectPath, matcher)
  ]);
  return {
    rootPath: currentProjectPath,
    rootName: path.basename(currentProjectPath),
    tree,
    searchableFiles
  };
});

ipcMain.handle('file:read', async (event, input) => {
  const request = typeof input === 'string'
    ? { filePath: input, allowMissing: false }
    : (input && typeof input === 'object' ? input : {});

  const filePath = String(request.filePath || '');
  const allowMissing = Boolean(request.allowMissing);

  if (!filePath) {
    throw new Error('File path is required.');
  }

  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!isWithinProject(filePath, currentProjectPath)) {
    throw new Error('File is outside the opened project.');
  }

  try {
    const buffer = await fsp.readFile(filePath);
    return decodeBufferWithEncoding(buffer);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
});

ipcMain.handle('file:write', async (event, { filePath, content }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!isWithinProject(filePath, currentProjectPath)) {
    throw new Error('File is outside the opened project.');
  }

  await fsp.writeFile(filePath, content, 'utf8');
  return { ok: true };
});

ipcMain.handle('file:saveAs', async (event, { currentPath, content }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!currentProjectPath) {
    throw new Error('Open a project first.');
  }

  const defaultPath = currentPath && isWithinProject(currentPath, currentProjectPath)
    ? currentPath
    : path.join(currentProjectPath, 'untitled.txt');

  const result = await dialog.showSaveDialog(senderWindow || mainWindow, {
    defaultPath,
    buttonLabel: 'Save File As'
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  if (!isWithinProject(result.filePath, currentProjectPath)) {
    throw new Error('Save File As is limited to the opened project folder.');
  }

  await fsp.writeFile(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('fs:createFile', async (event, { parentPath, name }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!parentPath || !name) {
    throw new Error('Invalid file input.');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new Error('File name cannot contain path separators.');
  }

  const targetPath = path.join(parentPath, name);
  if (!isWithinProject(targetPath, currentProjectPath)) {
    throw new Error('Target path is outside the opened project.');
  }

  await fsp.writeFile(targetPath, '', { flag: 'wx' });
  return { ok: true, path: targetPath };
});

ipcMain.handle('fs:createFolder', async (event, { parentPath, name }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!parentPath || !name) {
    throw new Error('Invalid folder input.');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Folder name cannot contain path separators.');
  }

  const targetPath = path.join(parentPath, name);
  if (!isWithinProject(targetPath, currentProjectPath)) {
    throw new Error('Target path is outside the opened project.');
  }

  try {
    await fsp.mkdir(targetPath, { recursive: false });
    return { ok: true, path: targetPath, created: true };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = await fsp.stat(targetPath).catch(() => null);
      if (existing && existing.isDirectory()) {
        return { ok: true, path: targetPath, created: false };
      }

      throw new Error('A file with the same name already exists.');
    }

    throw error;
  }
});

ipcMain.handle('fs:rename', async (event, { targetPath, newName }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!targetPath || !newName) {
    throw new Error('Invalid rename input.');
  }

  if (newName.includes('/') || newName.includes('\\')) {
    throw new Error('Name cannot contain path separators.');
  }

  if (!isWithinProject(targetPath, currentProjectPath)) {
    throw new Error('Target path is outside the opened project.');
  }

  const destinationPath = path.join(path.dirname(targetPath), newName);
  if (!isWithinProject(destinationPath, currentProjectPath)) {
    throw new Error('Destination path is outside the opened project.');
  }

  await fsp.rename(targetPath, destinationPath);
  return { ok: true, path: destinationPath };
});

ipcMain.handle('fs:delete', async (event, { targetPath }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!targetPath) {
    throw new Error('Invalid delete target.');
  }

  if (!isWithinProject(targetPath, currentProjectPath)) {
    throw new Error('Target path is outside the opened project.');
  }

  await removePathRecursive(targetPath);
  return { ok: true };
});

ipcMain.handle('fs:copy', async (event, { sourcePath, destinationDir }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!sourcePath || !destinationDir) {
    throw new Error('Invalid copy input.');
  }

  if (!isWithinProject(sourcePath, currentProjectPath) || !isWithinProject(destinationDir, currentProjectPath)) {
    throw new Error('Path is outside the opened project.');
  }

  const destinationPath = path.join(destinationDir, path.basename(sourcePath));
  if (!isWithinProject(destinationPath, currentProjectPath)) {
    throw new Error('Destination path is outside the opened project.');
  }

  await fsp.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true, force: false });
  return { ok: true, path: destinationPath };
});

ipcMain.handle('fs:move', async (event, { sourcePath, destinationDir }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!sourcePath || !destinationDir) {
    throw new Error('Invalid move input.');
  }

  if (!isWithinProject(sourcePath, currentProjectPath) || !isWithinProject(destinationDir, currentProjectPath)) {
    throw new Error('Path is outside the opened project.');
  }

  const destinationPath = path.join(destinationDir, path.basename(sourcePath));
  if (!isWithinProject(destinationPath, currentProjectPath)) {
    throw new Error('Destination path is outside the opened project.');
  }

  try {
    await fsp.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fsp.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true, force: false });
      await removePathRecursive(sourcePath);
    } else {
      throw error;
    }
  }

  return { ok: true, path: destinationPath };
});

ipcMain.handle('fs:openInExplorer', async (event, { targetPath }) => {
  const currentProjectPath = getProjectPathForSender(event.sender);
  if (!targetPath) {
    throw new Error('Invalid target path.');
  }

  if (!isWithinProject(targetPath, currentProjectPath)) {
    throw new Error('Path is outside the opened project.');
  }

  shell.showItemInFolder(targetPath);
  return { ok: true };
});

ipcMain.handle('app:command', (event, command) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    return { ok: false };
  }

  const currentZoom = win.webContents.getZoomFactor();

  if (command === 'view:reload') {
    win.webContents.reload();
  } else if (command === 'view:toggleDevTools') {
    toggleDevtoolsWithFilter(win);
  } else if (command === 'view:toggleFullscreen') {
    win.setFullScreen(!win.isFullScreen());
  } else if (command === 'view:zoomIn') {
    win.webContents.setZoomFactor(Math.min(3, currentZoom + 0.1));
  } else if (command === 'view:zoomOut') {
    win.webContents.setZoomFactor(Math.max(0.25, currentZoom - 0.1));
  } else if (command === 'view:resetZoom') {
    win.webContents.setZoomFactor(1);
  } else if (command === 'window:minimize') {
    win.minimize();
  } else if (command === 'window:close') {
    win.close();
  }

  return { ok: true };
});

ipcMain.handle('app:copyToClipboard', async (_event, text) => {
  if (typeof text !== 'string') {
    throw new Error('Clipboard text must be a string.');
  }

  clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle('app:getInfo', () => {
  return {
    name: "QwaleCode",
    version: app.getVersion(),
    description: 'QwaleCode - Lightweight Electron IDE',
    license: 'CC BY-NC-ND 4.0',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  };
});

ipcMain.handle('http:request', async (_event, payload = {}) => {
  const method = String(payload.method || 'GET').toUpperCase();
  const url = String(payload.url || '').trim();
  if (!url) {
    throw new Error('Enter a request URL.');
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('URL must start with http:// or https://');
  }

  const requestHeaders = payload && typeof payload.headers === 'object' && payload.headers !== null
    ? payload.headers
    : {};

  const requestOptions = {
    method,
    headers: requestHeaders,
    signal: AbortSignal.timeout(30000)
  };

  const hasBody = !['GET', 'HEAD'].includes(method);
  if (hasBody && typeof payload.body === 'string' && payload.body.length > 0) {
    requestOptions.body = payload.body;
  }

  const response = await fetch(url, requestOptions);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  let responseData;
  if (contentType.includes('application/json')) {
    try {
      const parsed = await response.json();
      responseData = simplifyResponseData(parsed);
    } catch {
      responseData = await response.text();
    }
  } else {
    responseData = await response.text();
  }

  if (typeof responseData === 'string' && responseData.length > 200000) {
    responseData = `${responseData.slice(0, 200000)}\n...truncated...`;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data: responseData
  };
});

function runGit(projectPath, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', projectPath, ...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message || 'Git command failed.').trim();
        reject(new Error(message));
        return;
      }

      resolve({
        stdout: (stdout || '').trimEnd(),
        stderr: (stderr || '').trimEnd()
      });
    });
  });
}

async function ensureGitRepository(projectPath) {
  if (!projectPath) {
    throw new Error('Open a project first.');
  }

  try {
    await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error('Current folder is not a Git repository.');
  }
}

async function isGitRepository(projectPath) {
  if (!projectPath) {
    return false;
  }

  try {
    await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

function parseGitStatusPorcelain(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const branchLine = lines[0] || '';
  const files = [];

  for (const line of lines.slice(1)) {
    if (line.length < 3) {
      continue;
    }

    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    const x = code[0];
    const y = code[1];

    files.push({
      path: filePath,
      code,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' && y !== '?',
      untracked: code === '??'
    });
  }

  return {
    branchLine,
    files
  };
}

function parseGitGraphCommits(stdout) {
  const records = stdout.split('\x1e').map((entry) => entry.trim()).filter(Boolean);

  return records.map((record) => {
    const [hash, parentsRaw, refsRaw, subjectRaw] = record.split('\x1f');
    const parents = (parentsRaw || '').trim() ? parentsRaw.trim().split(/\s+/) : [];
    return {
      hash: (hash || '').trim(),
      shortHash: (hash || '').trim().slice(0, 7),
      parents,
      refs: (refsRaw || '').trim(),
      subject: (subjectRaw || '').trim()
    };
  }).filter((entry) => entry.hash);
}

ipcMain.handle('git:getOverview', async (event) => {
  const projectPath = getProjectPathForSender(event.sender);
  if (!projectPath) {
    return {
      state: 'no-project'
    };
  }

  const hasRepo = await isGitRepository(projectPath);
  if (!hasRepo) {
    return {
      state: 'no-repo'
    };
  }

  const statusOutput = await runGit(projectPath, ['status', '--porcelain=v1', '-b']);
  const status = parseGitStatusPorcelain(statusOutput.stdout);

  let branchesOutput = { stdout: '' };
  try {
    branchesOutput = await runGit(projectPath, ['branch', '--all', '--no-color']);
  } catch {
    branchesOutput = { stdout: '' };
  }

  const branches = branchesOutput.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      name: line.replace(/^\*\s*/, '').trim(),
      current: line.startsWith('*')
    }));

  let graphOutput = { stdout: '' };
  try {
    graphOutput = await runGit(projectPath, [
      'log',
      '--all',
      '--date-order',
      '--pretty=format:%H%x1f%P%x1f%D%x1f%s%x1e',
      '-n',
      '120'
    ]);
  } catch {
    graphOutput = { stdout: '' };
  }

  const graphCommits = parseGitGraphCommits(graphOutput.stdout);

  return {
    state: 'ready',
    branchLine: status.branchLine,
    files: status.files,
    branches,
    graphCommits
  };
});

ipcMain.handle('git:initRepo', async (event) => {
  const projectPath = getProjectPathForSender(event.sender);
  if (!projectPath) {
    throw new Error('Open a project first.');
  }

  const hasRepo = await isGitRepository(projectPath);
  if (!hasRepo) {
    await runGit(projectPath, ['init']);
  }

  return { ok: true, alreadyExists: hasRepo };
});

ipcMain.handle('git:publish', async (event, { remoteUrl, branchName }) => {
  const projectPath = getProjectPathForSender(event.sender);
  if (!projectPath) {
    throw new Error('Open a project first.');
  }

  const remote = String(remoteUrl || '').trim();
  if (!remote) {
    throw new Error('Remote URL is required to publish.');
  }

  const hasRepo = await isGitRepository(projectPath);
  if (!hasRepo) {
    await runGit(projectPath, ['init']);
  }

  let hasOrigin = true;
  try {
    await runGit(projectPath, ['remote', 'get-url', 'origin']);
  } catch {
    hasOrigin = false;
  }

  if (hasOrigin) {
    await runGit(projectPath, ['remote', 'set-url', 'origin', remote]);
  } else {
    await runGit(projectPath, ['remote', 'add', 'origin', remote]);
  }

  let targetBranch = String(branchName || '').trim();
  if (!targetBranch) {
    const currentBranch = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    targetBranch = (currentBranch.stdout || '').trim();
  }

  if (!targetBranch || targetBranch === 'HEAD') {
    targetBranch = 'main';
  }

  const pushResult = await runGit(projectPath, ['push', '--set-upstream', 'origin', targetBranch]);
  return {
    ok: true,
    output: pushResult.stdout || pushResult.stderr || 'Published.'
  };
});

ipcMain.handle('git:commit', async (event, { message }) => {
  const projectPath = getProjectPathForSender(event.sender);
  await ensureGitRepository(projectPath);

  if (!message || !String(message).trim()) {
    throw new Error('Commit message is required.');
  }

  await runGit(projectPath, ['add', '-A']);
  const result = await runGit(projectPath, ['commit', '-m', String(message).trim()]);
  return { ok: true, output: result.stdout || result.stderr || 'Committed.' };
});

ipcMain.handle('git:push', async (event) => {
  const projectPath = getProjectPathForSender(event.sender);
  await ensureGitRepository(projectPath);
  const result = await runGit(projectPath, ['push']);
  return { ok: true, output: result.stdout || result.stderr || 'Push complete.' };
});

ipcMain.handle('git:fetch', async (event) => {
  const projectPath = getProjectPathForSender(event.sender);
  await ensureGitRepository(projectPath);
  const result = await runGit(projectPath, ['fetch']);
  return { ok: true, output: result.stdout || result.stderr || 'Fetch complete.' };
});

ipcMain.handle('git:pull', async (event) => {
  const projectPath = getProjectPathForSender(event.sender);
  await ensureGitRepository(projectPath);
  const result = await runGit(projectPath, ['pull']);
  return { ok: true, output: result.stdout || result.stderr || 'Pull complete.' };
});

ipcMain.handle('git:createBranch', async (event, { name }) => {
  const projectPath = getProjectPathForSender(event.sender);
  await ensureGitRepository(projectPath);

  const branchName = String(name || '').trim();
  if (!branchName) {
    throw new Error('Branch name is required.');
  }

  await runGit(projectPath, ['branch', branchName]);
  return { ok: true };
});

ipcMain.handle('git:switchBranch', async (event, { name }) => {
  const projectPath = getProjectPathForSender(event.sender);
  await ensureGitRepository(projectPath);

  const branchName = String(name || '').trim();
  if (!branchName) {
    throw new Error('Branch name is required.');
  }

  try {
    await runGit(projectPath, ['switch', branchName]);
  } catch {
    await runGit(projectPath, ['checkout', branchName]);
  }

  return { ok: true };
});

function isWslAvailable() {
  if (process.platform !== 'win32') {
    return false;
  }

  const result = spawnSync('wsl.exe', ['--help'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 2000
  });

  return !result.error;
}

function getAvailableTerminalProfiles() {
  if (process.platform === 'win32') {
    const profiles = [
      { id: 'powershell', label: 'PowerShell' },
      { id: 'cmd', label: 'Command Prompt' }
    ];

    if (isWslAvailable()) {
      profiles.push({ id: 'wsl', label: 'WSL' });
    }

    return profiles;
  }

  return [{ id: 'shell', label: 'Shell' }];
}

function resolveTerminalCommand(profileId) {
  if (process.platform === 'win32') {
    if (profileId === 'cmd') {
      return { shell: 'cmd.exe', args: [] };
    }

    if (profileId === 'wsl' && isWslAvailable()) {
      return { shell: 'wsl.exe', args: [] };
    }

    return { shell: 'powershell.exe', args: [] };
  }

  return { shell: process.env.SHELL || 'bash', args: [] };
}

ipcMain.handle('terminal:getProfiles', () => {
  return {
    profiles: getAvailableTerminalProfiles()
  };
});

ipcMain.handle('app:openExternal', async (_event, url) => {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    throw new Error('Invalid URL.');
  }

  await shell.openExternal(targetUrl);
  return { ok: true };
});

ipcMain.handle('app:setTheme', (event, mode) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || process.platform !== 'win32' || typeof win.setTitleBarOverlay !== 'function') {
    return { ok: false };
  }

  const isLight = mode === 'light';
  win.setTitleBarOverlay({
    color: isLight ? '#f5f8ff' : '#101822',
    symbolColor: isLight ? '#1f2a3a' : '#eef6ff',
    height: 34
  });

  return { ok: true };
});

ipcMain.handle('terminal:create', (event, { cwd, shellType }) => {
  const senderProjectPath = getProjectPathForSender(event.sender);
  const senderWebContentsId = event.sender.id;
  const termId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const normalizedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  const hasValidCwd = Boolean(normalizedCwd) && fs.existsSync(normalizedCwd);
  const projectCwd = hasValidCwd ? normalizedCwd : senderProjectPath || app.getPath('home');
  const requestedShellType = typeof shellType === 'string' ? shellType : 'powershell';

  if (requestedShellType === 'wsl' && !isWslAvailable()) {
    throw new Error('WSL is not installed on this device.');
  }

  const command = resolveTerminalCommand(requestedShellType);

  const ptyProcess = pty.spawn(command.shell, command.args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: projectCwd,
    env: process.env
  });

  terminals.set(termId, {
    ptyProcess,
    webContentsId: senderWebContentsId
  });

  ptyProcess.onData((data) => {
    const targetWindow = BrowserWindow
      .getAllWindows()
      .find((win) => !win.isDestroyed() && win.webContents.id === senderWebContentsId);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    targetWindow.webContents.send('terminal:data', { termId, data });
  });

  ptyProcess.onExit((exitEvent) => {
    const targetWindow = BrowserWindow
      .getAllWindows()
      .find((win) => !win.isDestroyed() && win.webContents.id === senderWebContentsId);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    terminals.delete(termId);
    targetWindow.webContents.send('terminal:exit', { termId, exitCode: exitEvent.exitCode });
  });

  return { termId };
});

ipcMain.on('terminal:input', (_, { termId, data }) => {
  const terminal = terminals.get(termId);
  if (terminal) {
    terminal.ptyProcess.write(data);
  }
});

ipcMain.on('terminal:resize', (_, { termId, cols, rows }) => {
  const terminal = terminals.get(termId);
  if (!terminal) {
    return;
  }

  const safeCols = Math.max(2, Number(cols) || 2);
  const safeRows = Math.max(2, Number(rows) || 2);
  terminal.ptyProcess.resize(safeCols, safeRows);
});

ipcMain.on('terminal:kill', (_, { termId }) => {
  killTerminalSession(termId);
});

ipcMain.handle('ai:runCommand', async (event, { command }) => {
  const projectPath = getProjectPathForSender(event.sender);
  if (!projectPath) {
    throw new Error('Open a project first.');
  }

  const cmd = String(command || '').trim();
  if (!cmd) {
    throw new Error('Command is required.');
  }

  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash'),
      process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-lc', cmd],
      {
        cwd: projectPath,
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : 0,
          stdout: (stdout || '').trimEnd(),
          stderr: (stderr || '').trimEnd(),
          message: error ? (error.message || 'Command failed.') : ''
        });
      });
  });
});

app.whenReady().then(async () => {
  await loadRecentProjects();
  createAppMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  if (collaborationHostServer) {
    collaborationHostServer.stop();
    collaborationHostServer = null;
  }
  stopAllProjectWatchers();
  killAllTerminals();
});

app.on('window-all-closed', () => {
  if (collaborationHostServer) {
    collaborationHostServer.stop();
    collaborationHostServer = null;
  }
  stopAllProjectWatchers();
  killAllTerminals();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
