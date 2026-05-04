const { contextBridge, ipcRenderer } = require('electron');
const ignore = require('ignore');

contextBridge.exposeInMainWorld('qwaleApi', {
  openProject: () => ipcRenderer.invoke('project:open'),
  openProjectByPath: (folderPath) => ipcRenderer.invoke('project:openPath', folderPath),
  getRecentProjects: () => ipcRenderer.invoke('project:getRecent'),
  getInitialProject: () => ipcRenderer.invoke('project:getInitial'),
  closeProject: () => ipcRenderer.invoke('project:close'),
  clearRecentProjects: () => ipcRenderer.invoke('project:clearRecent'),
  refreshProject: () => ipcRenderer.invoke('project:refresh'),
  readFile: (payload) => ipcRenderer.invoke('file:read', payload),
  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),
  saveFileAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  createFile: (payload) => ipcRenderer.invoke('fs:createFile', payload),
  createFolder: (payload) => ipcRenderer.invoke('fs:createFolder', payload),
  renamePath: (payload) => ipcRenderer.invoke('fs:rename', payload),
  deletePath: (payload) => ipcRenderer.invoke('fs:delete', payload),
  copyPath: (payload) => ipcRenderer.invoke('fs:copy', payload),
  movePath: (payload) => ipcRenderer.invoke('fs:move', payload),
  openInExplorer: (payload) => ipcRenderer.invoke('fs:openInExplorer', payload),
  getGitOverview: () => ipcRenderer.invoke('git:getOverview'),
  gitInitRepo: () => ipcRenderer.invoke('git:initRepo'),
  gitCommit: (payload) => ipcRenderer.invoke('git:commit', payload),
  gitPublish: (payload) => ipcRenderer.invoke('git:publish', payload),
  gitPush: () => ipcRenderer.invoke('git:push'),
  gitFetch: () => ipcRenderer.invoke('git:fetch'),
  gitPull: () => ipcRenderer.invoke('git:pull'),
  gitCreateBranch: (payload) => ipcRenderer.invoke('git:createBranch', payload),
  gitSwitchBranch: (payload) => ipcRenderer.invoke('git:switchBranch', payload),
  gitMerge: (payload) => ipcRenderer.invoke('git:merge', payload),
  gitRebase: (payload) => ipcRenderer.invoke('git:rebase', payload),
  dispatchAppCommand: (command) => ipcRenderer.invoke('app:command', command),
  copyToClipboard: (text) => ipcRenderer.invoke('app:copyToClipboard', text),
  sendHttpRequest: (payload) => ipcRenderer.invoke('http:request', payload),
  setAppTheme: (mode) => ipcRenderer.invoke('app:setTheme', mode),
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  startCollabServer: (payload) => ipcRenderer.invoke('collab:startServer', payload),
  stopCollabServer: () => ipcRenderer.invoke('collab:stopServer'),
  getCollabServerInfo: () => ipcRenderer.invoke('collab:getServerInfo'),
  openCollabJoinWindow: (payload) => ipcRenderer.invoke('collab:openJoinWindow', payload),
  createIgnoreMatcher: () => ignore(),
  isGitignorePathIgnored: (patterns, relativePath) => {
    const matcher = ignore();
    matcher.add('.git/');
    matcher.add(String(patterns || ''));
    const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return matcher.ignores(rel) || matcher.ignores(`${rel}/`);
  },
  listCollabLocalFiles:    (payload) => ipcRenderer.invoke('collab:local:list',         payload),
  readCollabLocalFile:     (payload) => ipcRenderer.invoke('collab:local:read',         payload),
  writeCollabLocalFile:    (payload) => ipcRenderer.invoke('collab:local:write',        payload),
  deleteCollabLocalFile:   (payload) => ipcRenderer.invoke('collab:local:delete',       payload),
  renameCollabLocalFile:   (payload) => ipcRenderer.invoke('collab:local:rename',       payload),
  createCollabLocalFolder: (payload) => ipcRenderer.invoke('collab:local:createFolder', payload),
  getCollabSharedRoot:     (payload) => ipcRenderer.invoke('collab:shared:getRoot',     payload),
  resetCollabSharedWorkspace: (payload) => ipcRenderer.invoke('collab:shared:reset',    payload),
  ensureCollabSharedFolder: (payload) => ipcRenderer.invoke('collab:shared:ensureFolder', payload),
  writeCollabSharedFile:   (payload) => ipcRenderer.invoke('collab:shared:write',       payload),
  deleteCollabSharedPath:  (payload) => ipcRenderer.invoke('collab:shared:delete',      payload),
  renameCollabSharedPath:  (payload) => ipcRenderer.invoke('collab:shared:rename',      payload),
  readCollabSharedFile:    (payload) => ipcRenderer.invoke('collab:shared:read',        payload),
  startCollabSharedWatcher: (payload) => ipcRenderer.invoke('collab:shared:startWatcher', payload),
  stopCollabSharedWatcher:  () => ipcRenderer.invoke('collab:shared:stopWatcher'),
  runAiCommand: (payload) => ipcRenderer.invoke('ai:runCommand', payload),
  getTerminalProfiles: () => ipcRenderer.invoke('terminal:getProfiles'),
  createTerminal: (payload) => ipcRenderer.invoke('terminal:create', payload),
  sendTerminalInput: (payload) => ipcRenderer.send('terminal:input', payload),
  resizeTerminal: (payload) => ipcRenderer.send('terminal:resize', payload),
  killTerminal: (payload) => ipcRenderer.send('terminal:kill', payload),
  onTerminalData: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onMenuAction: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
  onProjectChanged: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('project:changed', listener);
    return () => ipcRenderer.removeListener('project:changed', listener);
  },
  onCollabEvent: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('collab:event', listener);
    return () => ipcRenderer.removeListener('collab:event', listener);
  }
});
