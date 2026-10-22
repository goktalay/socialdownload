'use strict';

// Giriş ve ana pencere (yalıtılmış, sandbox; Node erişimi yok)
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  // arayüz dili (açılışta senkron alınır ki ilk çizim doğru dilde olsun)
  lang: ipcRenderer.sendSync('app:lang'),
  version: ipcRenderer.sendSync('app:version'),

  // Mastertool hesabı ve senkron
  accountState: () => ipcRenderer.invoke('account:state'),
  login: (email, password, remember) => ipcRenderer.invoke('account:login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('account:logout'),
  syncNow: () => ipcRenderer.invoke('account:syncNow'),
  setSyncEnabled: (on) => ipcRenderer.invoke('account:setSync', on),
  deleteRemoteLibrary: () => ipcRenderer.invoke('account:deleteRemote'),
  openWeb: (page) => ipcRenderer.invoke('account:openWeb', page), // 'forgot' | 'register' | 'account' | 'tool'
  onAccountStatus: on('account:status'),
  onUpdateAvailable: on('app:update'),
  openMastertool: () => ipcRenderer.invoke('app:openMastertool'),
  about: () => ipcRenderer.invoke('app:about'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openLicenses: () => ipcRenderer.invoke('app:openLicenses'),

  // ayarlar ve geçmiş
  getStore: () => ipcRenderer.invoke('store:get'),
  onStoreChanged: on('store:changed'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  acceptNotice: () => ipcRenderer.invoke('app:acceptNotice'),
  onHistoryChanged: on('history:changed'),
  removeHistory: (ids) => ipcRenderer.invoke('history:remove', ids),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // analiz
  analyze: (text, playlist) => ipcRenderer.invoke('analyze:run', { text, playlist }),
  cancelAnalyze: () => ipcRenderer.invoke('analyze:cancel'),
  onAnalyzeProgress: on('analyze:progress'),
  thumb: (url) => ipcRenderer.invoke('thumb:get', url),
  readClipboard: () => ipcRenderer.invoke('clip:read'),
  onClipboardOffer: on('clip:offer'),
  checkTemplate: (tpl) => ipcRenderer.invoke('template:check', tpl),

  // kuyruk
  getQueue: () => ipcRenderer.invoke('queue:get'),
  addToQueue: (entries, opts) => ipcRenderer.invoke('queue:add', { entries, opts }),
  queueOp: (op, ids) => ipcRenderer.invoke('queue:op', { op, ids }),
  queueMove: (id, delta) => ipcRenderer.invoke('queue:move', { id, delta }),
  pauseAll: () => ipcRenderer.invoke('queue:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('queue:resumeAll'),
  clearFinished: () => ipcRenderer.invoke('queue:clearFinished'),
  onQueueChanged: on('queue:changed'),
  onQueueProgress: on('queue:progress'),
  openFile: (id) => ipcRenderer.invoke('file:open', id),
  showFile: (id) => ipcRenderer.invoke('file:show', id),
  openDir: () => ipcRenderer.invoke('dir:open'),
  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  openSource: (url) => ipcRenderer.invoke('app:openSource', url),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),

  // motor (yt-dlp + ffmpeg)
  engineInfo: () => ipcRenderer.invoke('engine:info'),
  engineCheck: () => ipcRenderer.invoke('engine:check'),
  engineUpdate: () => ipcRenderer.invoke('engine:update'),
  engineReset: () => ipcRenderer.invoke('engine:reset'),
  engineLicenses: () => ipcRenderer.invoke('engine:openLicenses'),
  onEngineStep: on('engine:step'),
  onEngineStatus: on('engine:status'),
});
