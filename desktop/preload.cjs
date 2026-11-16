const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cardhelper', {
  directory: () => ipcRenderer.invoke('workflow:directory'),
  directoryItems: (folder, relative) => ipcRenderer.invoke('workflow:directory-items', folder, relative),
  open: () => ipcRenderer.invoke('workflow:open'),
  save: workflow => ipcRenderer.invoke('workflow:save', workflow),
  listLibraryWorkflows: () => ipcRenderer.invoke('workflow-library:list'),
  openLibraryWorkflow: id => ipcRenderer.invoke('workflow-library:open', id),
  saveLibraryWorkflow: (name, workflow) => ipcRenderer.invoke('workflow-library:save', name, workflow),
  removeLibraryWorkflow: id => ipcRenderer.invoke('workflow-library:remove', id),
  preview: workflow => ipcRenderer.invoke('workflow:preview', workflow),
  execute: (id, verifyOnly) => ipcRenderer.invoke('workflow:execute', id, verifyOnly),
  removeTask: id => ipcRenderer.invoke('workflow:remove-task', id),
  cancel: () => ipcRenderer.invoke('workflow:cancel'),
  recover: () => ipcRenderer.invoke('workflow:recover'),
  clearRecovery: () => ipcRenderer.invoke('workflow:clear-recovery'),
  report: (id, format) => ipcRenderer.invoke('workflow:report', id, format),
  onProgress: callback => {
    const listener = (_, id, outcome) => callback(id, outcome);
    ipcRenderer.on('workflow:progress', listener);
    return () => ipcRenderer.removeListener('workflow:progress', listener);
  },
});
