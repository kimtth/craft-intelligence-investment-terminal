import { buildCopilotService } from './copilot.js';

// Renderer never receives Node, preload, filesystem or shell capabilities.
export const desktopWebPreferences = Object.freeze({
  nodeIntegration: false, contextIsolation: true, sandbox: true,
  webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  spellcheck: false,
});

export function allowedNavigation(target, origin) {
  try {
    const url = new URL(target);
    return url.origin === origin && url.pathname === '/' && !url.username && !url.password;
  } catch { return false; }
}

// Implementation limit, not a backend/result-size contract. Unknown size fails closed.
export const MAX_JSON_EXPORT_BYTES = 8 * 1024 * 1024;
const exportNames = new Set(['itt-correlation.json', 'itt-trigger.json',
  'itt-backtest.json', 'itt-portfolio.json']);

// Metadata gating is not JSON-content validation or proof of blob authenticity.
// Electron supplies gesture and originating webContents, never renderer assertions.
export function allowedJSONExport({ url, origin, filename, mime, bytes,
  userGesture, ownedContents, currentURL, urlChain }) {
  if (userGesture !== true || ownedContents !== true || !allowedNavigation(currentURL, origin)
    || !exportNames.has(filename) || !['application/json', 'text/json'].includes(mime)
    || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_JSON_EXPORT_BYTES
    || !Array.isArray(urlChain) || urlChain.length !== 1 || urlChain[0] !== url) return false;
  try {
    const local = new URL(origin);
    if (local.origin !== origin || local.protocol !== 'http:' || local.hostname !== '127.0.0.1'
      || local.username || local.password) return false;
    const prefix = `blob:${origin}/`;
    return typeof url === 'string' && url.startsWith(prefix)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(url.slice(prefix.length));
  } catch { return false; }
}

// Construction is lazy. Only explicit status checks load account/model metadata;
// explicit analyze/criteria requests authorize the selected public snapshot.
export function desktopCopilot(options = {}) {
  return buildCopilotService({ ...options, authOnly: false });
}