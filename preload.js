const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Memory & System
    getMemoryInfo: () => ipcRenderer.invoke('get-memory-info'),
    getProcessList: () => ipcRenderer.invoke('get-process-list'),
    getCpuUsage: () => ipcRenderer.invoke('get-cpu-usage'),

    // Optimization
    trimProcess: (pid) => ipcRenderer.invoke('trim-process', pid),
    optimizeAll: () => ipcRenderer.invoke('optimize-all'),

    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

    // History
    getHistory: (range) => ipcRenderer.invoke('get-history', range),

    // Startup Programs
    getStartupPrograms: () => ipcRenderer.invoke('get-startup-programs'),
    toggleStartup: (id, enable) => ipcRenderer.invoke('toggle-startup', id, enable),

    // Events from main process
    onMonitorData: (callback) => {
        ipcRenderer.on('monitor-data', (event, data) => callback(data));
    },
    onOptimizeComplete: (callback) => {
        ipcRenderer.on('optimize-complete', (event, report) => callback(report));
    },
    onSettingsUpdated: (callback) => {
        ipcRenderer.on('settings-updated', (event, settings) => callback(settings));
    },

    // Window controls
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close')
});
