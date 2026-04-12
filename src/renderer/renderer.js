const api = window.qwaleApi;

const appMenubar = document.getElementById('appMenubar');
const projectInfo = document.getElementById('projectInfo');
const treeRoot = document.getElementById('treeRoot');
const editorTabs = document.getElementById('editorTabs');
const editor = document.getElementById('editor');
const statusPosition = document.getElementById('statusPosition');
const statusEncoding = document.getElementById('statusEncoding');
const terminalPanel = document.getElementById('terminalPanel');
const terminalContainer = document.getElementById('terminalContainer');
const terminalResizeHandle = document.getElementById('terminalResizeHandle');
const terminalTabs = document.getElementById('terminalTabs');
const newTerminalBtn = document.getElementById('newTerminalBtn');
const newTerminalTypeBtn = document.getElementById('newTerminalTypeBtn');
const terminalTypeMenu = document.getElementById('terminalTypeMenu');
const terminalActions = document.getElementById('terminalActions');

let project = {
  rootPath: null,
  rootName: '',
  tree: []
};

let monacoEditor = null;
let currentFilePath = null;
let previewFilePath = null;
let selectedNodePath = null;
let activeTerminalId = null;
let terminalSessionSeq = 1;
let terminalProfiles = [];
let terminalEventsBound = false;
let recentProjectsCache = [];
let menuDocumentClickBound = false;
let helpOverlay = null;
let helpTitle = null;
let helpBody = null;
let confirmOverlay = null;
let confirmTitle = null;
let confirmMessage = null;
let confirmCancelBtn = null;
let confirmPrimaryBtn = null;
let confirmResolver = null;
let unsavedOverlay = null;
let unsavedTitle = null;
let unsavedMessage = null;
let unsavedResolver = null;
let isCloseFlowRunning = false;
let isWindowCloseApproved = false;
let explorerMenu = null;
let inlineEditState = null;
let explorerClipboard = null;
let fileSearchContainer = null;
let fileSearchInput = null;
let fileSearchResults = null;
let fileSearchQuery = '';
let fileSearchDocumentClickBound = false;
let fileSearchIndex = [];

const openFiles = new Map();
const terminalSessions = new Map();

const expandedFolders = new Set();

const terminal = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: 'Consolas, monospace',
  fontSize: 13,
  theme: {
    background: '#0d1723',
    foreground: '#d6e9ff',
    cursor: '#45d483'
  }
});
const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalContainer);

terminal.onData((data) => {
  if (!activeTerminalId) {
    return;
  }
  api.sendTerminalInput({ termId: activeTerminalId, data });
});

function getTerminalTypeLabel(profileId) {
  if (profileId === 'cmd') {
    return 'CMD';
  }
  if (profileId === 'wsl') {
    return 'WSL';
  }
  if (profileId === 'shell') {
    return 'SH';
  }
  return 'PS';
}

function closeTerminalTypeMenu() {
  terminalTypeMenu.classList.add('hidden');
}

function setActiveTerminal(termId) {
  activeTerminalId = termId;
  terminal.clear();

  const session = activeTerminalId ? terminalSessions.get(activeTerminalId) : null;
  if (session && session.buffer) {
    terminal.write(session.buffer);
  }

  renderTerminalTabs();

  requestAnimationFrame(() => {
    fitAddon.fit();
    if (activeTerminalId) {
      api.resizeTerminal({ termId: activeTerminalId, cols: terminal.cols, rows: terminal.rows });
    }
  });
}

function renderTerminalTabs() {
  terminalTabs.innerHTML = '';

  for (const [termId, session] of terminalSessions) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `terminal-tab${termId === activeTerminalId ? ' active' : ''}`;
    tab.title = `${session.profileLabel} terminal`;

    const label = document.createElement('span');
    label.className = 'terminal-tab-label';
    label.textContent = `${session.profileLabel} ${session.index}`;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'terminal-tab-close';
    close.textContent = 'x';
    close.title = 'Kill terminal';

    close.addEventListener('click', async (event) => {
      event.stopPropagation();
      await killTerminalSession(termId);
    });

    tab.addEventListener('click', () => {
      setActiveTerminal(termId);
    });

    tab.appendChild(label);
    tab.appendChild(close);
    terminalTabs.appendChild(tab);
  }
}

function renderTerminalTypeMenu() {
  terminalTypeMenu.innerHTML = '';

  for (const profile of terminalProfiles) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'terminal-type-item';
    item.textContent = profile.label;
    item.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeTerminalTypeMenu();
      await createTerminalSession(profile.id);
    });
    terminalTypeMenu.appendChild(item);
  }
}

function bindTerminalBridgeEvents() {
  if (terminalEventsBound) {
    return;
  }

  api.onTerminalData(({ termId, data }) => {
    const session = terminalSessions.get(termId);
    if (!session) {
      return;
    }

    session.buffer += data;
    if (termId === activeTerminalId) {
      terminal.write(data);
    }
  });

  api.onTerminalExit(({ termId, exitCode }) => {
    const session = terminalSessions.get(termId);
    if (!session) {
      return;
    }

    session.exited = true;
    const message = `\r\n[Process exited with code ${exitCode}]`;
    session.buffer += message;
    if (termId === activeTerminalId) {
      terminal.writeln(`\r\n[Process exited with code ${exitCode}]`);
    }
  });

  terminalEventsBound = true;
}

async function createTerminalSession(shellType = 'powershell') {
  const created = await api.createTerminal({
    cwd: project.rootPath,
    shellType
  });

  const session = {
    termId: created.termId,
    shellType,
    profileLabel: getTerminalTypeLabel(shellType),
    index: terminalSessionSeq++,
    buffer: '',
    exited: false
  };

  terminalSessions.set(created.termId, session);
  setActiveTerminal(created.termId);
}

async function killTerminalSession(termId) {
  if (!terminalSessions.has(termId)) {
    return;
  }

  api.killTerminal({ termId });
  terminalSessions.delete(termId);

  if (activeTerminalId === termId) {
    const remaining = [...terminalSessions.keys()];
    if (remaining.length) {
      setActiveTerminal(remaining[remaining.length - 1]);
    } else {
      activeTerminalId = null;
      terminal.clear();
      renderTerminalTabs();
    }
  } else {
    renderTerminalTabs();
  }
}

function killAllTerminalSessions() {
  for (const termId of terminalSessions.keys()) {
    api.killTerminal({ termId });
  }

  terminalSessions.clear();
  activeTerminalId = null;
  terminal.clear();
  renderTerminalTabs();
}

async function initTerminalSystem() {
  bindTerminalBridgeEvents();

  const profilePayload = await api.getTerminalProfiles();
  terminalProfiles = Array.isArray(profilePayload && profilePayload.profiles)
    ? profilePayload.profiles
    : [];

  if (!terminalProfiles.length) {
    terminalProfiles = [{ id: 'powershell', label: 'PowerShell' }];
  }

  renderTerminalTypeMenu();
  renderTerminalTabs();
  await createTerminalSession('powershell');
}

function getFileName(filePath) {
  return filePath.split(/[/\\]/).pop();
}

function getRelativeProjectPath(filePath) {
  if (!project.rootPath) {
    return getFileName(filePath);
  }

  const root = project.rootPath.replace(/\\/g, '/');
  const target = filePath.replace(/\\/g, '/');
  if (target.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }

  return getFileName(filePath);
}

function collectProjectFiles(nodes, collector = []) {
  for (const node of nodes || []) {
    if (node.type === 'file') {
      collector.push({
        path: node.path,
        name: node.name,
        relativePath: getRelativeProjectPath(node.path)
      });
      continue;
    }

    collectProjectFiles(node.children || [], collector);
  }

  return collector;
}

function closeFileSearchResults() {
  if (!fileSearchContainer) {
    return;
  }
  fileSearchContainer.classList.remove('open');
}

function updateFileSearchAvailability() {
  if (!fileSearchInput) {
    return;
  }

  const hasProject = Boolean(project.rootPath);
  fileSearchInput.disabled = !hasProject;
  fileSearchInput.placeholder = hasProject ? 'Search files by name...' : 'Open a folder to search files';
  if (!hasProject) {
    fileSearchInput.value = '';
    fileSearchQuery = '';
    if (fileSearchResults) {
      fileSearchResults.innerHTML = '';
    }
    closeFileSearchResults();
  }
}

function renderFileSearchResults() {
  if (!fileSearchResults || !fileSearchInput) {
    return;
  }

  fileSearchResults.innerHTML = '';

  const query = fileSearchQuery.trim().toLowerCase();
  if (!query || !project.rootPath) {
    closeFileSearchResults();
    return;
  }

  const startsWith = [];
  const includes = [];

  for (const entry of fileSearchIndex) {
    const nameLower = entry.name.toLowerCase();
    if (nameLower.startsWith(query)) {
      startsWith.push(entry);
    } else if (nameLower.includes(query)) {
      includes.push(entry);
    }
  }

  const results = [...startsWith, ...includes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 60);

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'file-search-empty';
    empty.textContent = 'No files match your search.';
    fileSearchResults.appendChild(empty);
    fileSearchContainer.classList.add('open');
    return;
  }

  for (const result of results) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-search-result';

    const name = document.createElement('span');
    name.className = 'file-search-result-name';
    name.textContent = result.name;

    const path = document.createElement('span');
    path.className = 'file-search-result-path';
    path.textContent = result.relativePath;

    btn.appendChild(name);
    btn.appendChild(path);

    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      selectedNodePath = result.path;
      await openFile(result.path, { mode: 'permanent' });
      renderTree();
      closeFileSearchResults();
    });

    fileSearchResults.appendChild(btn);
  }

  fileSearchContainer.classList.add('open');
}

function refreshFileSearchIndex() {
  if (project.rootPath && Array.isArray(project.searchableFiles)) {
    fileSearchIndex = project.searchableFiles.map((filePath) => ({
      path: filePath,
      name: getFileName(filePath),
      relativePath: getRelativeProjectPath(filePath)
    }));
  } else {
    fileSearchIndex = project.rootPath ? collectProjectFiles(project.tree, []) : [];
  }
  updateFileSearchAvailability();
  renderFileSearchResults();
}

function createFileSearchBar() {
  const container = document.createElement('div');
  container.className = 'file-search';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-search-input';
  input.placeholder = 'Search files by name...';
  input.value = fileSearchQuery;
  input.setAttribute('autocomplete', 'off');

  const results = document.createElement('div');
  results.className = 'file-search-results';

  input.addEventListener('input', () => {
    fileSearchQuery = input.value;
    renderFileSearchResults();
  });

  input.addEventListener('focus', () => {
    renderFileSearchResults();
  });

  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFileSearchResults();
      input.blur();
      return;
    }

    if (event.key === 'Enter') {
      const firstResult = results.querySelector('.file-search-result');
      if (firstResult) {
        event.preventDefault();
        firstResult.click();
      }
    }
  });

  container.appendChild(input);
  container.appendChild(results);

  fileSearchContainer = container;
  fileSearchInput = input;
  fileSearchResults = results;

  if (!fileSearchDocumentClickBound) {
    document.addEventListener('click', (event) => {
      if (!fileSearchContainer) {
        return;
      }
      if (!fileSearchContainer.contains(event.target)) {
        closeFileSearchResults();
      }
    });
    fileSearchDocumentClickBound = true;
  }

  updateFileSearchAvailability();
  renderFileSearchResults();
  return container;
}

function closeExplorerContextMenu() {
  if (!explorerMenu) {
    return;
  }
  explorerMenu.classList.add('hidden');
}

function ensureExplorerContextMenu() {
  if (explorerMenu) {
    return;
  }

  explorerMenu = document.createElement('div');
  explorerMenu.className = 'explorer-context-menu hidden';
  document.body.appendChild(explorerMenu);

  document.addEventListener('click', () => {
    closeExplorerContextMenu();
  });
}

function addExplorerMenuItem(container, label, action, { disabled = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `explorer-context-item${disabled ? ' disabled' : ''}`;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (disabled) {
      return;
    }
    closeExplorerContextMenu();
    try {
      await action();
    } catch (error) {
      alert(error.message);
    }
  });
  container.appendChild(btn);
}

function addExplorerMenuDivider(container) {
  const divider = document.createElement('div');
  divider.className = 'explorer-context-divider';
  container.appendChild(divider);
}

function getPasteTargetPath(contextNode) {
  if (!project.rootPath) {
    return null;
  }

  if (!contextNode) {
    return project.rootPath;
  }

  if (contextNode.type === 'folder') {
    return contextNode.path;
  }

  return contextNode.path.replace(/[\\/][^\\/]+$/, '');
}

function showExplorerContextMenu(event, contextNode) {
  ensureExplorerContextMenu();
  explorerMenu.innerHTML = '';

  const hasNode = Boolean(contextNode);
  const isFolder = contextNode && contextNode.type === 'folder';
  const pasteTarget = getPasteTargetPath(contextNode);
  const canPaste = Boolean(explorerClipboard && pasteTarget);

  if (hasNode) {
    addExplorerMenuItem(explorerMenu, 'Open With', async () => {
      if (contextNode.type === 'file') {
        await openFile(contextNode.path, { mode: 'permanent' });
      }
    });

    addExplorerMenuItem(explorerMenu, contextNode.type === 'file' ? 'Copy File' : 'Copy Folder', async () => {
      explorerClipboard = { mode: 'copy', sourcePath: contextNode.path, type: contextNode.type };
    });

    addExplorerMenuItem(explorerMenu, contextNode.type === 'file' ? 'Cut File' : 'Cut Folder', async () => {
      explorerClipboard = { mode: 'cut', sourcePath: contextNode.path, type: contextNode.type };
    });

    addExplorerMenuItem(explorerMenu, 'Rename', async () => {
      startInlineRename(contextNode.path, contextNode.type);
    });

    addExplorerMenuItem(explorerMenu, 'Delete', async () => {
      const shouldDelete = await showConfirmDialog({
        title: 'Delete',
        message: `Delete ${contextNode.name}? This cannot be undone.`,
        confirmLabel: 'Delete',
        confirmStyle: 'danger'
      });
      if (!shouldDelete) {
        return;
      }

      await api.deletePath({ targetPath: contextNode.path });
      if (openFiles.has(contextNode.path)) {
        await closeTab(contextNode.path);
      }
      await refreshProjectTree();
    });

    addExplorerMenuItem(explorerMenu, 'Open in File Explorer', async () => {
      await api.openInExplorer({ targetPath: contextNode.path });
    });

    if (isFolder) {
      addExplorerMenuDivider(explorerMenu);
      addExplorerMenuItem(explorerMenu, 'New File', async () => {
        startInlineCreate('file', contextNode.path);
      });
      addExplorerMenuItem(explorerMenu, 'New Folder', async () => {
        startInlineCreate('folder', contextNode.path);
      });
      addExplorerMenuItem(explorerMenu, 'Paste File/Folder', async () => {
        await pasteIntoPath(contextNode.path);
      }, { disabled: !canPaste });
    }
  } else {
    addExplorerMenuItem(explorerMenu, 'New File', async () => {
      startInlineCreate('file', project.rootPath);
    }, { disabled: !project.rootPath });
    addExplorerMenuItem(explorerMenu, 'New Folder', async () => {
      startInlineCreate('folder', project.rootPath);
    }, { disabled: !project.rootPath });
    addExplorerMenuItem(explorerMenu, 'Paste', async () => {
      await pasteIntoPath(project.rootPath);
    }, { disabled: !canPaste });
  }

  explorerMenu.style.left = `${event.clientX}px`;
  explorerMenu.style.top = `${event.clientY}px`;
  explorerMenu.classList.remove('hidden');
}

function startInlineRename(targetPath, targetType) {
  inlineEditState = {
    mode: 'rename',
    targetPath,
    targetType,
    value: getFileName(targetPath)
  };
  renderTree();
}

function startInlineCreate(targetType, parentPath) {
  inlineEditState = {
    mode: 'create',
    parentPath,
    targetType,
    value: ''
  };
  if (parentPath) {
    expandedFolders.add(parentPath);
  }
  renderTree();
}

function cancelInlineEdit() {
  if (!inlineEditState) {
    return;
  }
  inlineEditState = null;
  renderTree();
}

async function commitInlineEdit(name) {
  const state = inlineEditState;
  inlineEditState = null;

  const trimmed = (name || '').trim();
  if (!state || !trimmed) {
    renderTree();
    return;
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    alert('Name cannot contain path separators.');
    renderTree();
    return;
  }

  if (state.mode === 'rename') {
    const result = await api.renamePath({ targetPath: state.targetPath, newName: trimmed });
    const renamedPath = result && result.path ? result.path : null;
    if (renamedPath && openFiles.has(state.targetPath)) {
      const fileState = openFiles.get(state.targetPath);
      openFiles.delete(state.targetPath);
      openFiles.set(renamedPath, fileState);
      if (currentFilePath === state.targetPath) {
        currentFilePath = renamedPath;
      }
      if (previewFilePath === state.targetPath) {
        previewFilePath = renamedPath;
      }
      updateEditorStatusBar();
      updateEditorTitle();
      renderTabs();
    }
  } else if (state.mode === 'create') {
    if (state.targetType === 'folder') {
      await api.createFolder({ parentPath: state.parentPath, name: trimmed });
    } else {
      await api.createFile({ parentPath: state.parentPath, name: trimmed });
    }
  }

  await refreshProjectTree();
}

async function pasteIntoPath(destinationPath) {
  if (!explorerClipboard || !destinationPath) {
    return;
  }

  const { mode, sourcePath } = explorerClipboard;

  if (mode === 'copy') {
    await api.copyPath({ sourcePath, destinationDir: destinationPath });
  } else {
    await api.movePath({ sourcePath, destinationDir: destinationPath });
    explorerClipboard = null;
  }

  await refreshProjectTree();
}

function getFileTypeIconClass(filePath) {
  const ext = (filePath.match(/\.([^.\\/]+)$/) || [])[1]?.toLowerCase() || '';

  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) {
    return 'ft-js';
  }
  if (['ts', 'tsx'].includes(ext)) {
    return 'ft-ts';
  }
  if (ext === 'html' || ext === 'htm') {
    return 'ft-html';
  }
  if (ext === 'json') {
    return 'ft-json';
  }
  if (ext === 'css' || ext === 'scss' || ext === 'less') {
    return 'ft-css';
  }
  if (ext === 'py') {
    return 'ft-py';
  }
  if (['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'].includes(ext)) {
    return 'ft-cpp';
  }
  if (ext === 'c' || ext === 'h') {
    return 'ft-c';
  }
  if (ext === 'md') {
    return 'ft-md';
  }

  return 'ft-default';
}

function createFileTypeIconElement(filePath, className) {
  const icon = document.createElement('span');
  icon.className = `${className} ${getFileTypeIconClass(filePath)}`;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function hasDirtyFiles() {
  for (const [, state] of openFiles) {
    if (state.model.getValue() !== state.savedContent) {
      return true;
    }
  }
  return false;
}

function canRunSaveActions() {
  return openFiles.size > 0 && hasDirtyFiles();
}

function inferEncodingFromText(content) {
  return /^[\x00-\x7F]*$/.test(content) ? 'ASCII' : 'UTF-8';
}

function updateEditorStatusBar() {
  if (!currentFilePath || !monacoEditor || !monacoEditor.getModel()) {
    statusPosition.textContent = 'Ln -, Col -';
    statusEncoding.textContent = '-';
    return;
  }

  const pos = monacoEditor.getPosition();
  if (pos) {
    statusPosition.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
  } else {
    statusPosition.textContent = 'Ln -, Col -';
  }

  const state = openFiles.get(currentFilePath);
  statusEncoding.textContent = state?.encoding || 'UTF-8';
}

function isMenuItemDisabled(itemId) {
  if (itemId === 'project:closeFolder') {
    return !project.rootPath;
  }

  if (itemId === 'project:openRecent') {
    return recentProjectsCache.length === 0;
  }

  if (itemId === 'file:save' || itemId === 'file:saveAs' || itemId === 'file:saveAll') {
    return !canRunSaveActions();
  }
  return false;
}

async function refreshRecentProjectsCache() {
  recentProjectsCache = await api.getRecentProjects();
}

async function clearRecentProjects() {
  await api.clearRecentProjects();
  await refreshRecentProjectsCache();
  renderMenuBar();
}

function updateSaveMenuItemsState() {
  const disabled = !canRunSaveActions();
  const saveIds = ['file:save', 'file:saveAs', 'file:saveAll'];

  for (const id of saveIds) {
    const items = appMenubar.querySelectorAll(`[data-menu-action="${id}"]`);
    items.forEach((item) => {
      item.disabled = disabled;
      item.classList.toggle('disabled', disabled);
    });
  }

  const closeFolderItems = appMenubar.querySelectorAll('[data-menu-action="project:closeFolder"]');
  closeFolderItems.forEach((item) => {
    const closeDisabled = !project.rootPath;
    item.disabled = closeDisabled;
    item.classList.toggle('disabled', closeDisabled);
  });
}

function renderMenuBar() {
  const groups = [
    {
      label: 'File',
      items: [
        { label: 'Open Folder', shortcut: 'Ctrl+O', action: () => openProject() },
        {
          id: 'project:openRecent',
          label: 'Open Recent',
          submenu: [
            ...recentProjectsCache.map((recentPath) => ({
              label: recentPath,
              action: () => openRecentProject(recentPath)
            })),
            ...(recentProjectsCache.length ? [{ divider: true }] : []),
            ...(recentProjectsCache.length
              ? [
                  {
                    label: 'Clear Recents',
                    action: () => clearRecentProjects()
                  }
                ]
              : [])
          ]
        },
        { id: 'project:closeFolder', label: 'Close Folder', shortcut: 'Ctrl+Shift+W', action: () => closeFolder() },
        { divider: true },
        { label: 'New File', shortcut: 'Ctrl+N', action: () => createNewFile() },
        { label: 'New Folder', shortcut: 'Ctrl+Shift+N', action: () => createNewFolder() },
        { divider: true },
        { id: 'file:save', label: 'Save File', shortcut: 'Ctrl+S', action: () => saveCurrentFile() },
        { id: 'file:saveAs', label: 'Save File As', shortcut: 'Ctrl+Shift+S', action: () => saveCurrentFileAs() },
        { id: 'file:saveAll', label: 'Save All Files', shortcut: 'Ctrl+Alt+S', action: () => saveAllFiles() }
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: () => monacoEditor && monacoEditor.trigger('menu', 'undo', null) },
        { label: 'Redo', shortcut: 'Ctrl+Y', action: () => monacoEditor && monacoEditor.trigger('menu', 'redo', null) },
        { divider: true },
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => document.execCommand('cut') },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => document.execCommand('copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', action: () => document.execCommand('paste') },
        { divider: true },
        { label: 'Find', shortcut: 'Ctrl+F', action: () => monacoEditor && monacoEditor.trigger('menu', 'actions.find', null) },
        { label: 'Find & Replace', shortcut: 'Ctrl+H', action: () => monacoEditor && monacoEditor.trigger('menu', 'editor.action.startFindReplaceAction', null) },
        { divider: true },
        { label: 'Select All', shortcut: 'Ctrl+A', action: () => monacoEditor && monacoEditor.trigger('menu', 'editor.action.selectAll', null) }
      ]
    },
    {
      label: 'View',
      items: [
        { label: 'Reload', action: () => api.dispatchAppCommand('view:reload') },
        { label: 'Toggle Developer Tools', action: () => api.dispatchAppCommand('view:toggleDevTools') },
        { divider: true },
        { label: 'Zoom In', action: () => api.dispatchAppCommand('view:zoomIn') },
        { label: 'Zoom Out', action: () => api.dispatchAppCommand('view:zoomOut') },
        { label: 'Reset Zoom', action: () => api.dispatchAppCommand('view:resetZoom') },
        { divider: true },
        { label: 'Toggle Full Screen', action: () => api.dispatchAppCommand('view:toggleFullscreen') }
      ]
    },
    {
      label: 'Window',
      items: [
        { label: 'Minimize', action: () => api.dispatchAppCommand('window:minimize') },
        { label: 'Close', action: () => api.dispatchAppCommand('window:close') }
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'View License', action: () => showLicenseDialog() },
        { label: 'About', action: () => showAboutDialog() }
      ]
    }
  ];

  appMenubar.innerHTML = '';

  const logo = document.createElement('span');
  logo.className = 'menu-logo';
  logo.setAttribute('aria-hidden', 'true');
  appMenubar.appendChild(logo);

  for (const group of groups) {
    const root = document.createElement('div');
    root.className = 'menu-root';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'menu-trigger';
    trigger.textContent = group.label;

    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';

    for (const item of group.items) {
      if (item.divider) {
        const divider = document.createElement('div');
        divider.className = 'menu-divider';
        dropdown.appendChild(divider);
        continue;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item';
      if (item.id) {
        btn.dataset.menuAction = item.id;
      }
      const disabled = isMenuItemDisabled(item.id);
      btn.disabled = disabled;
      if (disabled) {
        btn.classList.add('disabled');
      }

      const name = document.createElement('span');
      name.textContent = item.label;
      btn.appendChild(name);

      const shortcut = document.createElement('span');
      shortcut.className = 'menu-shortcut';
      if (item.submenu) {
        shortcut.classList.add('menu-chevron-icon');
      } else {
        shortcut.textContent = item.shortcut || '';
      }
      btn.appendChild(shortcut);

      if (item.submenu) {
        btn.classList.add('has-submenu');

        const submenuDropdown = document.createElement('div');
        submenuDropdown.className = 'menu-submenu-dropdown';

        for (const subItem of item.submenu) {
          if (subItem.divider) {
            const divider = document.createElement('div');
            divider.className = 'menu-divider';
            submenuDropdown.appendChild(divider);
            continue;
          }

          const subBtn = document.createElement('button');
          subBtn.type = 'button';
          subBtn.className = 'menu-item';

          const subName = document.createElement('span');
          subName.textContent = subItem.label;
          subBtn.appendChild(subName);

          const subShortcut = document.createElement('span');
          subShortcut.className = 'menu-shortcut';
          subShortcut.textContent = subItem.shortcut || '';
          subBtn.appendChild(subShortcut);

          subBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            try {
              await subItem.action();
            } catch (error) {
              alert(error.message);
            }
            root.classList.remove('open');
          });

          submenuDropdown.appendChild(subBtn);
        }

        btn.appendChild(submenuDropdown);
      } else {
        btn.addEventListener('click', async () => {
          if (btn.disabled) {
            return;
          }
          try {
            await item.action();
          } catch (error) {
            alert(error.message);
          }
          root.classList.remove('open');
        });
      }

      dropdown.appendChild(btn);
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = root.classList.contains('open');
      document.querySelectorAll('.menu-root.open').forEach((el) => el.classList.remove('open'));
      if (!isOpen) {
        root.classList.add('open');
      }
    });

    root.appendChild(trigger);
    root.appendChild(dropdown);
    appMenubar.appendChild(root);
  }

  const searchBar = createFileSearchBar();
  appMenubar.appendChild(searchBar);

  updateSaveMenuItemsState();

  if (!menuDocumentClickBound) {
    document.addEventListener('click', () => {
      document.querySelectorAll('.menu-root.open').forEach((el) => el.classList.remove('open'));
    });
    menuDocumentClickBound = true;
  }
}

function ensureHelpDialog() {
  if (helpOverlay) {
    return;
  }

  helpOverlay = document.createElement('div');
  helpOverlay.className = 'help-overlay hidden';

  const dialog = document.createElement('div');
  dialog.className = 'help-dialog';

  const header = document.createElement('div');
  header.className = 'help-header';

  helpTitle = document.createElement('h3');
  helpTitle.className = 'help-title';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'help-close';
  closeBtn.setAttribute('aria-label', 'Close help dialog');
  closeBtn.addEventListener('click', closeHelpDialog);

  header.appendChild(helpTitle);
  header.appendChild(closeBtn);

  helpBody = document.createElement('div');
  helpBody.className = 'help-body';

  dialog.appendChild(header);
  dialog.appendChild(helpBody);
  helpOverlay.appendChild(dialog);

  helpOverlay.addEventListener('click', (event) => {
    if (event.target === helpOverlay) {
      closeHelpDialog();
    }
  });

  document.body.appendChild(helpOverlay);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && helpOverlay && !helpOverlay.classList.contains('hidden')) {
      closeHelpDialog();
    }
  });
}

function openHelpDialog(title, htmlContent) {
  ensureHelpDialog();
  helpTitle.textContent = title;
  helpBody.innerHTML = htmlContent;
  helpOverlay.classList.remove('hidden');
}

function closeHelpDialog() {
  if (!helpOverlay) {
    return;
  }
  helpOverlay.classList.add('hidden');
}

function ensureConfirmDialog() {
  if (confirmOverlay) {
    return;
  }

  confirmOverlay = document.createElement('div');
  confirmOverlay.className = 'help-overlay hidden';

  const dialog = document.createElement('div');
  dialog.className = 'help-dialog confirm-dialog';

  const header = document.createElement('div');
  header.className = 'help-header';

  confirmTitle = document.createElement('h3');
  confirmTitle.className = 'help-title';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'help-close';
  closeBtn.setAttribute('aria-label', 'Close confirmation dialog');
  closeBtn.addEventListener('click', () => resolveConfirm(false));

  header.appendChild(confirmTitle);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'help-body';
  confirmMessage = document.createElement('p');
  confirmMessage.className = 'confirm-message';
  body.appendChild(confirmMessage);

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';

  confirmCancelBtn = document.createElement('button');
  confirmCancelBtn.type = 'button';
  confirmCancelBtn.className = 'confirm-btn secondary';
  confirmCancelBtn.textContent = 'Cancel';
  confirmCancelBtn.addEventListener('click', () => resolveConfirm(false));

  confirmPrimaryBtn = document.createElement('button');
  confirmPrimaryBtn.type = 'button';
  confirmPrimaryBtn.className = 'confirm-btn danger';
  confirmPrimaryBtn.textContent = 'Close';
  confirmPrimaryBtn.addEventListener('click', () => resolveConfirm(true));

  actions.appendChild(confirmCancelBtn);
  actions.appendChild(confirmPrimaryBtn);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(actions);
  confirmOverlay.appendChild(dialog);

  confirmOverlay.addEventListener('click', (event) => {
    if (event.target === confirmOverlay) {
      resolveConfirm(false);
    }
  });

  document.body.appendChild(confirmOverlay);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && confirmOverlay && !confirmOverlay.classList.contains('hidden')) {
      resolveConfirm(false);
    }
  });
}

function resolveConfirm(result) {
  if (confirmOverlay) {
    confirmOverlay.classList.add('hidden');
  }

  if (confirmResolver) {
    const resolver = confirmResolver;
    confirmResolver = null;
    resolver(result);
  }
}

function showConfirmDialog({ title, message, confirmLabel = 'Close', confirmStyle = 'danger' }) {
  ensureConfirmDialog();

  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmPrimaryBtn.textContent = confirmLabel;
  confirmPrimaryBtn.classList.remove('danger', 'primary');
  confirmPrimaryBtn.classList.add(confirmStyle === 'primary' ? 'primary' : 'danger');
  confirmOverlay.classList.remove('hidden');

  return new Promise((resolve) => {
    confirmResolver = resolve;
    requestAnimationFrame(() => confirmPrimaryBtn.focus());
  });
}

function ensureUnsavedDialog() {
  if (unsavedOverlay) {
    return;
  }

  unsavedOverlay = document.createElement('div');
  unsavedOverlay.className = 'help-overlay hidden';

  const dialog = document.createElement('div');
  dialog.className = 'help-dialog unsaved-dialog';

  const header = document.createElement('div');
  header.className = 'help-header';
  unsavedTitle = document.createElement('h3');
  unsavedTitle.className = 'help-title';
  header.appendChild(unsavedTitle);

  unsavedMessage = document.createElement('div');
  unsavedMessage.className = 'help-body unsaved-message';

  const actions = document.createElement('div');
  actions.className = 'unsaved-actions';

  const options = [
    { label: 'Save This File', value: 'save', className: 'primary' },
    { label: 'Save All Files', value: 'save-all', className: 'primary' },
    { label: 'Do Not Save This File', value: 'dont-save', className: 'danger' },
    { label: 'Do Not Save All Files', value: 'dont-save-all', className: 'danger' },
    { label: 'Cancel', value: 'cancel', className: 'secondary' }
  ];

  for (const option of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `confirm-btn ${option.className}`;
    btn.textContent = option.label;
    btn.addEventListener('click', () => resolveUnsavedChoice(option.value));
    actions.appendChild(btn);
  }

  dialog.appendChild(header);
  dialog.appendChild(unsavedMessage);
  dialog.appendChild(actions);
  unsavedOverlay.appendChild(dialog);

  unsavedOverlay.addEventListener('click', (event) => {
    if (event.target === unsavedOverlay) {
      resolveUnsavedChoice('cancel');
    }
  });

  document.body.appendChild(unsavedOverlay);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && unsavedOverlay && !unsavedOverlay.classList.contains('hidden')) {
      resolveUnsavedChoice('cancel');
    }
  });
}

function resolveUnsavedChoice(choice) {
  if (unsavedOverlay) {
    unsavedOverlay.classList.add('hidden');
  }

  if (unsavedResolver) {
    const resolver = unsavedResolver;
    unsavedResolver = null;
    resolver(choice);
  }
}

function showUnsavedFileDialog(filePath) {
  ensureUnsavedDialog();
  unsavedTitle.textContent = 'Unsaved Changes';
  unsavedMessage.innerHTML = `<p><strong>${getFileName(filePath)}</strong> has unsaved changes.</p><p>How would you like to proceed before closing?</p>`;
  unsavedOverlay.classList.remove('hidden');

  return new Promise((resolve) => {
    unsavedResolver = resolve;
  });
}

function getDirtyFilePaths() {
  const dirty = [];
  for (const [filePath, state] of openFiles) {
    if (state.model.getValue() !== state.savedContent) {
      dirty.push(filePath);
    }
  }
  return dirty;
}

async function saveFileByPath(filePath) {
  const fileState = openFiles.get(filePath);
  if (!fileState) {
    return;
  }

  const content = fileState.model.getValue();
  await api.writeFile({ filePath, content });
  fileState.savedContent = content;
}

async function handleWindowCloseWithUnsavedPrompts() {
  if (isCloseFlowRunning) {
    return false;
  }

  const dirtyPaths = getDirtyFilePaths();
  if (!dirtyPaths.length) {
    return true;
  }

  isCloseFlowRunning = true;
  let saveAll = false;
  let dontSaveAll = false;

  try {
    for (const filePath of dirtyPaths) {
      if (saveAll) {
        await saveFileByPath(filePath);
        continue;
      }

      if (dontSaveAll) {
        continue;
      }

      const choice = await showUnsavedFileDialog(filePath);
      if (choice === 'save') {
        await saveFileByPath(filePath);
      } else if (choice === 'save-all') {
        await saveFileByPath(filePath);
        saveAll = true;
      } else if (choice === 'dont-save') {
        continue;
      } else if (choice === 'dont-save-all') {
        dontSaveAll = true;
      } else {
        return false;
      }
    }

    updateEditorTitle();
    renderTabs();
    renderTree();
    return true;
  } finally {
    isCloseFlowRunning = false;
  }
}

function showLicenseDialog() {
  const mit = [
    'CC BY-NC-ND 4.0 License',
    '',
    'Copyright (c) 2026 Faraaz Jan',
    '',
    'https://creativecommons.org/licenses/by-nc-nd/4.0/'
  ].join('\n');

  openHelpDialog('License', `<pre class="help-license">${mit}</pre>`);
}

async function showAboutDialog() {
  const info = await api.getAppInfo();
  const html = `
    <div class="help-about">
      <p><strong>${info.name}</strong></p>
      <p>${info.description}</p>
      <p><strong>Version:</strong> ${info.version}</p>
      <p><strong>License:</strong> ${info.license}</p>
      <p><strong>Runtime:</strong> Electron ${info.electron}, Node ${info.node}, Chrome ${info.chrome}</p>
      <p><strong>Credits:</strong> Built by Faraaz Jan</p>
    </div>
  `;

  openHelpDialog('About QwaleCode', html);
}

function updateEditorTitle() {
  // File identity/dirty state is represented in tabs, so no separate title bar is used.
}

function detectMonacoLanguage(filePath) {
  const extension = (filePath.match(/\.([^.\\/]+)$/) || [])[1]?.toLowerCase();
  const langMap = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    py: 'python',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'cpp',
    rs: 'rust',
    go: 'go',
    php: 'php',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    ps1: 'powershell',
    sql: 'sql'
  };
  return langMap[extension] || 'plaintext';
}

function isDirty(filePath) {
  const state = openFiles.get(filePath);
  if (!state) {
    return false;
  }
  return state.model.getValue() !== state.savedContent;
}

function renderTabs() {
  editorTabs.innerHTML = '';

  for (const [filePath] of openFiles) {
    const tab = document.createElement('div');
    tab.className = `tab${filePath === currentFilePath ? ' active' : ''}`;
    const dirty = isDirty(filePath);

    const fileIcon = createFileTypeIconElement(filePath, 'tab-file-icon');
    const label = document.createElement('span');
    label.textContent = getFileName(filePath);

    const close = document.createElement('span');
    close.className = 'tab-close';
    const closeIcon = document.createElement('span');
    closeIcon.className = 'tab-close-icon';
    close.appendChild(closeIcon);

    tab.addEventListener('click', () => {
      switchToFile(filePath);
    });

    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(filePath);
    });

    tab.appendChild(fileIcon);
    tab.appendChild(label);
    if (dirty) {
      const dirtyDot = document.createElement('span');
      dirtyDot.className = 'tab-dirty-dot';
      dirtyDot.title = 'Unsaved changes';
      tab.appendChild(dirtyDot);
    }
    tab.appendChild(close);
    editorTabs.appendChild(tab);
  }

  updateSaveMenuItemsState();
}

function switchToFile(filePath) {
  const state = openFiles.get(filePath);
  if (!state || !monacoEditor) {
    return;
  }

  currentFilePath = filePath;
  monacoEditor.setModel(state.model);
  updateEditorStatusBar();
  updateEditorTitle();
  renderTabs();
}

async function closeTab(filePath) {
  const state = openFiles.get(filePath);
  if (!state) {
    return;
  }

  if (previewFilePath === filePath) {
    previewFilePath = null;
  }

  if (isDirty(filePath)) {
    const shouldClose = await showConfirmDialog({
      title: 'Unsaved Changes',
      message: `${getFileName(filePath)} has unsaved changes. Close tab anyway?`,
      confirmLabel: 'Close Tab',
      confirmStyle: 'danger'
    });
    if (!shouldClose) {
      return;
    }
  }

  const keys = [...openFiles.keys()];
  const idx = keys.indexOf(filePath);
  state.model.dispose();
  openFiles.delete(filePath);

  if (currentFilePath === filePath) {
    if (openFiles.size === 0) {
      currentFilePath = null;
      if (monacoEditor) {
        monacoEditor.setModel(null);
      }
      updateEditorStatusBar();
    } else {
      const fallback = keys[idx + 1] || keys[idx - 1];
      switchToFile(fallback);
    }
  }

  updateEditorTitle();
  renderTabs();
}

function initMonacoEditor() {
  return new Promise((resolve, reject) => {
    if (!window.require) {
      reject(new Error('Monaco loader is unavailable.'));
      return;
    }

    window.require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
    window.MonacoEnvironment = {
      getWorkerUrl: () => {
        const code = `self.MonacoEnvironment = { baseUrl: '../../node_modules/monaco-editor/min/' }; importScripts('../../node_modules/monaco-editor/min/vs/base/worker/workerMain.js');`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
      }
    };

    window.require(['vs/editor/editor.main'], () => {
      monacoEditor = window.monaco.editor.create(editor, {
        value: '',
        language: 'plaintext',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: 'Consolas, monospace',
        wordWrap: 'off'
      });

      monacoEditor.onDidChangeModelContent(() => {
        const state = currentFilePath ? openFiles.get(currentFilePath) : null;
        if (state) {
          state.encoding = inferEncodingFromText(state.model.getValue());
        }
        updateEditorStatusBar();
        updateEditorTitle();
        renderTabs();
        renderTree();
      });

      monacoEditor.onDidChangeCursorPosition(() => {
        updateEditorStatusBar();
      });

      resolve();
    });
  });
}

function buildTreeNode(node) {
  const item = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'tree-node';
  row.dataset.path = node.path;

  if (selectedNodePath === node.path) {
    row.classList.add('selected');
  }

  const icon = document.createElement('span');
  icon.className = 'node-icon';

  const label = document.createElement('span');
  label.className = 'tree-node-label';
  label.textContent = node.name;

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectedNodePath = node.path;
    renderTree();
    showExplorerContextMenu(event, node);
  });

  if (inlineEditState && inlineEditState.mode === 'rename' && inlineEditState.targetPath === node.path) {
    const input = document.createElement('input');
    input.className = 'tree-inline-input';
    input.type = 'text';
    input.value = inlineEditState.value || node.name;

    const commit = async () => {
      await commitInlineEdit(input.value);
    };

    input.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        await commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelInlineEdit();
      }
    });

    input.addEventListener('blur', async () => {
      await commit();
    });

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    item.appendChild(row);
    row.appendChild(icon);
    row.appendChild(input);

    if (node.type === 'folder' && expandedFolders.has(node.path)) {
      const children = document.createElement('ul');
      for (const child of node.children || []) {
        children.appendChild(buildTreeNode(child));
      }
      item.appendChild(children);
    }

    return item;
  }

  if (node.type === 'folder') {
    const isExpanded = expandedFolders.has(node.path);
    icon.classList.add('node-icon-folder');
    if (isExpanded) {
      icon.classList.add('expanded');
    }

    row.addEventListener('click', (event) => {
      event.stopPropagation();
      selectedNodePath = node.path;
      if (isExpanded) {
        expandedFolders.delete(node.path);
      } else {
        expandedFolders.add(node.path);
      }
      renderTree();
    });

    item.appendChild(row);
    row.appendChild(icon);
    row.appendChild(label);

    if (isExpanded) {
      const children = document.createElement('ul');
      for (const child of node.children || []) {
        children.appendChild(buildTreeNode(child));
      }

      if (inlineEditState && inlineEditState.mode === 'create' && inlineEditState.parentPath === node.path) {
        const createItem = document.createElement('li');
        const createRow = document.createElement('div');
        createRow.className = 'tree-node';

        const createIcon = document.createElement('span');
        createIcon.className = inlineEditState.targetType === 'folder'
          ? 'node-icon node-icon-folder expanded'
          : `file-type-icon ${getFileTypeIconClass('new.txt')}`;

        const createInput = document.createElement('input');
        createInput.className = 'tree-inline-input';
        createInput.type = 'text';
        createInput.placeholder = inlineEditState.targetType === 'folder' ? 'New folder name' : 'New file name';

        const commitCreate = async () => {
          await commitInlineEdit(createInput.value);
        };

        createInput.addEventListener('keydown', async (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            await commitCreate();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelInlineEdit();
          }
        });

        createInput.addEventListener('blur', async () => {
          await commitCreate();
        });

        createRow.appendChild(createIcon);
        createRow.appendChild(createInput);
        createItem.appendChild(createRow);
        children.appendChild(createItem);

        requestAnimationFrame(() => {
          createInput.focus();
        });
      }

      item.appendChild(children);
    }

    return item;
  }

  const fileIcon = createFileTypeIconElement(node.path, 'file-type-icon');
  icon.replaceWith(fileIcon);
  let singleClickTimer = null;

  row.addEventListener('click', (event) => {
    event.stopPropagation();
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
    }

    singleClickTimer = setTimeout(async () => {
      singleClickTimer = null;
      selectedNodePath = node.path;
      await openFile(node.path, { mode: 'preview' });
      renderTree();
    }, 220);
  });

  row.addEventListener('dblclick', async (event) => {
    event.stopPropagation();
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }

    selectedNodePath = node.path;
    await openFile(node.path, { mode: 'permanent' });
    renderTree();
  });

  item.appendChild(row);
  row.appendChild(fileIcon);
  row.appendChild(label);
  if (isDirty(node.path)) {
    const dirtyDot = document.createElement('span');
    dirtyDot.className = 'tree-dirty-dot';
    dirtyDot.title = 'Unsaved changes';
    row.appendChild(dirtyDot);
  }
  return item;
}

function renderTree() {
  treeRoot.innerHTML = '';

  treeRoot.oncontextmenu = (event) => {
    event.preventDefault();
    if (!event.target.closest('.tree-node')) {
      selectedNodePath = null;
      renderTree();
      showExplorerContextMenu(event, null);
    }
  };

  if (!project.rootPath) {
    treeRoot.innerHTML = '<p style="color:#9bb3cb;padding:8px;">Open a folder to get started.</p>';
    return;
  }

  const list = document.createElement('ul');
  for (const node of project.tree) {
    list.appendChild(buildTreeNode(node));
  }

  if (inlineEditState && inlineEditState.mode === 'create' && inlineEditState.parentPath === project.rootPath) {
    const createRow = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'tree-node';

    const icon = document.createElement('span');
    icon.className = inlineEditState.targetType === 'folder' ? 'node-icon node-icon-folder expanded' : `file-type-icon ${getFileTypeIconClass('new.txt')}`;

    const input = document.createElement('input');
    input.className = 'tree-inline-input';
    input.type = 'text';
    input.placeholder = inlineEditState.targetType === 'folder' ? 'New folder name' : 'New file name';

    const commit = async () => {
      await commitInlineEdit(input.value);
    };

    input.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        await commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelInlineEdit();
      }
    });
    input.addEventListener('blur', async () => {
      await commit();
    });

    row.appendChild(icon);
    row.appendChild(input);
    createRow.appendChild(row);
    list.appendChild(createRow);

    requestAnimationFrame(() => {
      input.focus();
    });
  }

  treeRoot.appendChild(list);
}

async function refreshProjectTree() {
  project = await api.refreshProject();
  projectInfo.textContent = project.rootPath ? `${project.rootName}  |  ${project.rootPath}` : 'No folder opened';

  if (project.rootPath && !expandedFolders.has(project.rootPath)) {
    expandedFolders.add(project.rootPath);
  }

  renderTree();
  refreshFileSearchIndex();
}

async function openFile(filePath, options = {}) {
  const mode = options.mode || 'permanent';
  const openAsPreview = mode === 'preview';

  if (openFiles.has(filePath)) {
    if (mode === 'permanent') {
      const existing = openFiles.get(filePath);
      existing.preview = false;
      if (previewFilePath === filePath) {
        previewFilePath = null;
      }
      renderTabs();
    }

    switchToFile(filePath);
    return;
  }

  if (openAsPreview && previewFilePath && previewFilePath !== filePath && openFiles.has(previewFilePath)) {
    const previousPreviewState = openFiles.get(previewFilePath);
    previousPreviewState.model.dispose();
    openFiles.delete(previewFilePath);

    if (currentFilePath === previewFilePath) {
      currentFilePath = null;
      if (monacoEditor) {
        monacoEditor.setModel(null);
      }
    }
  }

  const filePayload = await api.readFile(filePath);
  const content = typeof filePayload === 'string' ? filePayload : filePayload.content;
  const encoding = typeof filePayload === 'string'
    ? inferEncodingFromText(filePayload)
    : (filePayload.encoding || inferEncodingFromText(filePayload.content));
  const language = detectMonacoLanguage(filePath);
  const model = window.monaco.editor.createModel(content, language);

  openFiles.set(filePath, {
    model,
    savedContent: content,
    preview: openAsPreview,
    encoding
  });

  previewFilePath = openAsPreview ? filePath : null;

  switchToFile(filePath);
}

async function saveCurrentFile() {
  if (!canRunSaveActions()) {
    return;
  }

  if (!currentFilePath) {
    return;
  }

  const fileState = openFiles.get(currentFilePath);
  if (!fileState) {
    return;
  }

  const content = fileState.model.getValue();

  await api.writeFile({
    filePath: currentFilePath,
    content
  });

  fileState.savedContent = content;
  fileState.encoding = inferEncodingFromText(content);
  updateEditorStatusBar();
  updateEditorTitle();
  renderTabs();
  renderTree();
}

async function saveCurrentFileAs() {
  if (!canRunSaveActions()) {
    return;
  }

  if (!currentFilePath) {
    alert('Open a file first.');
    return;
  }

  const fileState = openFiles.get(currentFilePath);
  if (!fileState) {
    return;
  }

  const content = fileState.model.getValue();
  const result = await api.saveFileAs({
    currentPath: currentFilePath,
    content
  });

  if (!result || result.canceled || !result.filePath) {
    return;
  }

  const nextPath = result.filePath;
  const oldPath = currentFilePath;

  if (nextPath === oldPath) {
    fileState.savedContent = content;
    fileState.encoding = inferEncodingFromText(content);
    updateEditorStatusBar();
    updateEditorTitle();
    renderTabs();
    renderTree();
    await refreshProjectTree();
    return;
  }

  if (openFiles.has(nextPath)) {
    const existing = openFiles.get(nextPath);
    existing.model.setValue(content);
    existing.savedContent = content;
    existing.encoding = inferEncodingFromText(content);
    existing.preview = false;
    fileState.model.dispose();
    openFiles.delete(oldPath);
    if (previewFilePath === oldPath || previewFilePath === nextPath) {
      previewFilePath = null;
    }
    switchToFile(nextPath);
  } else {
    const language = detectMonacoLanguage(nextPath);
    window.monaco.editor.setModelLanguage(fileState.model, language);
    fileState.savedContent = content;
    fileState.encoding = inferEncodingFromText(content);
    openFiles.delete(oldPath);
    openFiles.set(nextPath, fileState);
    if (previewFilePath === oldPath) {
      previewFilePath = nextPath;
    }
    switchToFile(nextPath);
  }

  await refreshProjectTree();
}

async function saveAllFiles() {
  if (!canRunSaveActions()) {
    return;
  }

  let savedCount = 0;
  for (const [filePath, fileState] of openFiles) {
    const content = fileState.model.getValue();
    if (content === fileState.savedContent) {
      continue;
    }

    await api.writeFile({ filePath, content });
    fileState.savedContent = content;
    fileState.encoding = inferEncodingFromText(content);
    savedCount += 1;
  }

  updateEditorStatusBar();
  updateEditorTitle();
  renderTabs();
  renderTree();
  if (savedCount > 0) {
    await refreshProjectTree();
  }
}

function getTargetFolderPath() {
  if (!project.rootPath) {
    return null;
  }

  if (!selectedNodePath) {
    return project.rootPath;
  }

  const node = findNodeByPath(project.tree, selectedNodePath);
  if (!node) {
    return project.rootPath;
  }

  if (node.type === 'folder') {
    return node.path;
  }

  return node.path.replace(/[\\/][^\\/]+$/, '');
}

function findNodeByPath(nodes, targetPath) {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }

    if (node.type === 'folder') {
      const nested = findNodeByPath(node.children || [], targetPath);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

async function openProject() {
  const opened = await api.openProject();
  if (opened.canceled) {
    return;
  }

  await refreshRecentProjectsCache();
  renderMenuBar();
  await applyOpenedProject(opened);
}

async function openRecentProject(recentPath) {
  if (!recentPath) {
    return;
  }

  const opened = await api.openProjectByPath(recentPath);
  await refreshRecentProjectsCache();
  renderMenuBar();
  await applyOpenedProject(opened);
}

async function applyOpenedProject(opened) {
  if (!opened || opened.canceled || opened.openedInNewWindow) {
    return;
  }

  for (const [, state] of openFiles) {
    state.model.dispose();
  }
  openFiles.clear();
  previewFilePath = null;
  currentFilePath = null;
  updateEditorStatusBar();
  updateEditorTitle();
  renderTabs();

  project = opened;
  projectInfo.textContent = `${project.rootName}  |  ${project.rootPath}`;
  expandedFolders.clear();
  expandedFolders.add(project.rootPath);
  selectedNodePath = project.rootPath;
  renderTree();
  refreshFileSearchIndex();

  killAllTerminalSessions();
  await createTerminalSession('powershell');
}

async function closeFolder() {
  if (!project.rootPath) {
    return;
  }

  if (hasDirtyFiles()) {
    const shouldClose = await showConfirmDialog({
      title: 'Unsaved Changes',
      message: 'You have unsaved changes. Close folder anyway?',
      confirmLabel: 'Close Folder',
      confirmStyle: 'danger'
    });
    if (!shouldClose) {
      return;
    }
  }

  await api.closeProject();

  for (const [, state] of openFiles) {
    state.model.dispose();
  }
  openFiles.clear();
  previewFilePath = null;
  currentFilePath = null;
  selectedNodePath = null;
  updateEditorStatusBar();

  project = {
    rootPath: null,
    rootName: '',
    tree: []
  };

  projectInfo.textContent = 'No folder opened';
  renderTree();
  refreshFileSearchIndex();
  updateEditorTitle();
  renderTabs();

  killAllTerminalSessions();
  await createTerminalSession('powershell');
}

newTerminalBtn.addEventListener('click', async () => {
  try {
    await createTerminalSession('powershell');
  } catch (error) {
    alert(error.message);
  }
});

newTerminalTypeBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  terminalTypeMenu.classList.toggle('hidden');
});

document.addEventListener('click', (event) => {
  if (!terminalActions.contains(event.target)) {
    closeTerminalTypeMenu();
  }
});

async function createNewFile() {
  if (!project.rootPath) {
    alert('Open a project first.');
    return;
  }

  const parentPath = getTargetFolderPath();
  startInlineCreate('file', parentPath);
}

async function createNewFolder() {
  if (!project.rootPath) {
    alert('Open a project first.');
    return;
  }

  const parentPath = getTargetFolderPath();
  startInlineCreate('folder', parentPath);
}

if (api.onMenuAction) {
  api.onMenuAction(async ({ action, payload }) => {
    try {
      if (action === 'project:open') {
        await openProject();
      } else if (action === 'project:openRecent') {
        await openRecentProject(payload && payload.path ? payload.path : null);
      } else if (action === 'project:closeFolder') {
        await closeFolder();
      } else if (action === 'project:newFile') {
        await createNewFile();
      } else if (action === 'project:newFolder') {
        await createNewFolder();
      } else if (action === 'file:save') {
        await saveCurrentFile();
      } else if (action === 'file:saveAs') {
        await saveCurrentFileAs();
      } else if (action === 'file:saveAll') {
        await saveAllFiles();
      } else if (action === 'edit:find') {
        if (monacoEditor) {
          monacoEditor.trigger('menu', 'actions.find', null);
        }
      } else if (action === 'edit:replace') {
        if (monacoEditor) {
          monacoEditor.trigger('menu', 'editor.action.startFindReplaceAction', null);
        }
      } else if (action === 'project:recentCleared') {
        await refreshRecentProjectsCache();
        renderMenuBar();
      }
    } catch (error) {
      alert(error.message);
    }
  });
}

document.addEventListener('keydown', async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    try {
      await openProject();
    } catch (error) {
      alert(error.message);
    }
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    try {
      if (!canRunSaveActions()) {
        return;
      }

      if (event.shiftKey) {
        await saveCurrentFileAs();
      } else if (event.altKey) {
        await saveAllFiles();
      } else {
        await saveCurrentFile();
      }
    } catch (error) {
      alert(error.message);
    }
  }
});

let resizeState = null;

terminalResizeHandle.addEventListener('mousedown', (event) => {
  resizeState = {
    startY: event.clientY,
    startHeight: terminalPanel.offsetHeight
  };
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (event) => {
  if (!resizeState) {
    return;
  }

  const deltaY = resizeState.startY - event.clientY;
  const maxHeight = window.innerHeight - 180;
  const nextHeight = Math.min(maxHeight, Math.max(120, resizeState.startHeight + deltaY));

  terminalPanel.style.height = `${nextHeight}px`;
  fitAddon.fit();

  if (activeTerminalId) {
    api.resizeTerminal({ termId: activeTerminalId, cols: terminal.cols, rows: terminal.rows });
  }
});

document.addEventListener('mouseup', () => {
  resizeState = null;
  document.body.style.userSelect = '';
});

window.addEventListener('resize', () => {
  fitAddon.fit();
  if (activeTerminalId) {
    api.resizeTerminal({ termId: activeTerminalId, cols: terminal.cols, rows: terminal.rows });
  }
});

window.addEventListener('beforeunload', (event) => {
  if (isWindowCloseApproved || !hasDirtyFiles()) {
    return;
  }

  event.preventDefault();
  event.returnValue = false;

  if (isCloseFlowRunning) {
    return;
  }

  handleWindowCloseWithUnsavedPrompts().then(async (shouldClose) => {
    if (!shouldClose) {
      return;
    }

    isWindowCloseApproved = true;
    await api.dispatchAppCommand('window:close');
  });
});

Promise.all([refreshProjectTree(), initMonacoEditor(), refreshRecentProjectsCache()])
  .then(() => {
    renderMenuBar();
    return initTerminalSystem();
  })
  .catch((error) => {
    terminal.writeln(`\r\nInitialization error: ${error.message}`);
  });
