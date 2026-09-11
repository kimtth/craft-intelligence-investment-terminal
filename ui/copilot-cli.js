import { pathToFileURL } from 'node:url';
import { createBackend } from './backend.js';
import { buildCopilotService, validateCopilotRequest, copilotError } from './copilot.js';

// Explicit headless interface, not the terminal workbench and never a GUI launcher.
export function parseCopilotArgs(args) {
  const invalid = () => validateCopilotRequest('invalid', {});
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) return invalid();
  if (args.length === 1 && args[0] === 'status') return validateCopilotRequest('copilot.status', {});
  if (!['analyze', 'criteria'].includes(args[0])) return invalid();
  const names = { '--symbol': 'symbol', '--timestamp': 'timestamp', '--archive-id': 'archiveId',
    '--model': 'model', '--question': 'question' };
  const params = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--consent') {
      if (Object.hasOwn(params, 'consent')) return invalid();
      params.consent = true;
      continue;
    }
    if (!Object.hasOwn(names, flag) || Object.hasOwn(params, names[flag]) ||
        i + 1 >= args.length || args[i + 1].startsWith('--')) return invalid();
    const value = args[++i];
    if (flag === '--timestamp' && !/^\d+$/.test(value)) return invalid();
    params[names[flag]] = flag === '--timestamp' ? Number(value) : value;
  }
  return validateCopilotRequest(`copilot.${args[0]}`, params);
}

// Factories and writer are injected only by tests, never by CLI flags.
export async function runCopilotCLI(args, {
  backendFactory = createBackend, serviceFactory = buildCopilotService,
  write = text => process.stdout.write(text),
} = {}) {
  let call;
  try { call = parseCopilotArgs(args); }
  catch (error) {
    write(JSON.stringify({ ok: false, error: copilotError(error) }) + '\n');
    return 2;
  }
  let backend, service, envelope, exitCode = 0;
  try {
    // Status needs only SDK metadata; do not require Python just to check login.
    const lazyBackend = { request(...values) { backend ??= backendFactory(); return backend.request(...values); } };
    service = serviceFactory({ backend: lazyBackend });
    const result = call.method === 'copilot.status' ? await service.status()
      : call.method === 'copilot.criteria' ? await service.criteria(call.params) : await service.analyze(call.params);
    envelope = { ok: true, result };
    if (call.method === 'copilot.status' && !['ready', 'connected'].includes(result.status)) exitCode = 1;
  } catch (error) {
    envelope = { ok: false, error: copilotError(error) };
    exitCode = 1;
  } finally {
    let cleanupFailed = false;
    try { await service?.close(); } catch { cleanupFailed = true; }
    try { await backend?.close(); } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      envelope = { ok: false, error: { code: 'cleanup_failed', message: 'Copilot resource cleanup could not be confirmed.' } };
      exitCode = 1;
    }
  }
  write(JSON.stringify(envelope) + '\n');
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCopilotCLI(process.argv.slice(2));
}