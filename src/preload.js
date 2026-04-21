const { contextBridge, ipcRenderer } = require('electron');

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
