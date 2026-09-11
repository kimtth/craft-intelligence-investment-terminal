import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import { startGUI } from './gui-server.js';
import { createBackend } from './backend.js';
import { allowedJSONExport, allowedNavigation, desktopCopilot, desktopWebPreferences } from './desktop-policy.js';

app.setName('Intelligent Trading Terminal');
let window, server, stopping = false, startup;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show(); window?.focus();
  });
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void (async () => {
      try { await startup; await server?.close(); }
      catch { /* Public diagnostics never contain credentials or raw exception text. */ }
      finally { app.quit(); }
    })();
  });
  app.on('window-all-closed', () => app.quit());
  startup = app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const backend = createBackend();
    const copilot = desktopCopilot({ backend });
    try { server = await startGUI({ backend, copilot }); }
    catch (error) {
      try { await copilot.close(); } finally { await backend.close(); }
      throw error;
    }
    if (stopping) return;
    const isolated = session.fromPartition('itt-desktop'); // In-memory, no shared browser cookies.
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event, item, contents) => {
      const owned = window && !window.isDestroyed() && contents === window.webContents
        && !contents.isDestroyed();
      if (!allowedJSONExport({ url: item.getURL(), origin: server.origin,
        filename: item.getFilename(), mime: item.getMimeType(), bytes: item.getTotalBytes(),
        userGesture: item.hasUserGesture(), ownedContents: Boolean(owned),
        currentURL: owned ? contents.getURL() : '', urlChain: item.getURLChain() })) {
        event.preventDefault(); return;
      }
      // No setSavePath: retain Electron's native save prompt and cancellation.
      item.setSaveDialogOptions({ title: 'Save ITT JSON result',
        filters: [{ name: 'JSON result', extensions: ['json'] }],
        properties: ['showOverwriteConfirmation'] });
    });
    window = new BrowserWindow({
      title: 'Intelligent Trading Terminal', width: 1500, height: 1000,
      minWidth: 800, minHeight: 650, show: false, autoHideMenuBar: true,
      webPreferences: { ...desktopWebPreferences, session: isolated },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!allowedNavigation(url, server.origin)) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (!allowedNavigation(url, server.origin)) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => app.quit());
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = undefined; });
    await window.loadURL(server.url); // Ephemeral token is consumed by existing app.js.
  }).catch(() => {
    if (!stopping) dialog.showErrorBox('Unable to start ITT',
      'The local application could not start. Follow the developer guide setup instructions and check the repository .venv Python environment and UI dependencies.');
    app.quit();
  });
}