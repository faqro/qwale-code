const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qwaleApi', {
  openProject: () => ipcRenderer.invoke('project:open'),
  openProjectByPath: (folderPath) => ipcRenderer.invoke('project:openPath', folderPath),
  getRecentProjects: () => ipcRenderer.invoke('project:getRecent'),
  closeProject: () => ipcRenderer.invoke('project:close'),
  clearRecentProjects: () => ipcRenderer.invoke('project:clearRecent'),
  refreshProject: () => ipcRenderer.invoke('project:refresh'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
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
  setAppTheme: (mode) => ipcRenderer.invoke('app:setTheme', mode),
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
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
  }
});
