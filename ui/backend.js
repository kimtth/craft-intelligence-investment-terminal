import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const messages = {
  missing_interpreter: 'Repository .venv interpreter missing; install the repository environment first.',
  spawn_failed: 'Cannot start repository Python; check .venv and its installed itt package.',
  exited: 'Research process exited. Pending operations were not retried; inspect saved runs before repeating writes.',
  closed: 'Research connection closed; an in-flight write may already have completed.',
  protocol_error: 'Invalid RPC response; connection stopped. No operation was retried.',
  write_failed: 'RPC input failed; outcome unknown. No operation was retried.',
  invalid_json: 'Invalid JSON request.', invalid_request: 'Invalid request envelope.',
  invalid_params: 'Invalid method parameters.', method_not_found: 'Method is not supported.',
  schema_rejected: 'Input schema was rejected.', input_rejected: 'Input was rejected.',
  invalid_encoding: 'Input file is not valid UTF-8.', io_failure: 'Cannot access a required local file.',
  internal_error: 'Operation failed.', worker_failed: 'Research worker stopped without a valid result.',
  storage_failed: 'Unable to save the research run.', busy: 'A research job is already running.',
  job_not_found: 'No matching current job.', too_late: 'The job can no longer be cancelled.',
};
// Never expose exception text, stderr, request payloads or unknown server error codes.
export function safeError(error) {
  return Object.hasOwn(messages, error?.code) ? messages[error.code] : 'Operation failed (details redacted).';
}
export const safeErrorCode = error => Object.hasOwn(messages, error?.code) ? error.code : 'internal_error';
const fault = code => Object.assign(new Error(safeError({ code })), { code });

export function interpreterPath(root = ROOT, platform = process.platform, exists = existsSync) {
  const executable = path.join(root, '.venv', ...(platform === 'win32'
    ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  if (!exists(executable)) throw fault('missing_interpreter');
  return executable;
}

// Separate stream adapter permits deterministic tests without starting any process.
export function connectChild(child, { graceMs = 4000 } = {}) {
  const api = new EventEmitter(), pending = new Map(), decoder = new StringDecoder('utf8');
  let sequence = 0, buffer = '', stopped = false, closing = false, ended = false, timer;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  function fail(code) {
    if (stopped) return;
    stopped = true;
    const error = fault(code);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    if (!closing) api.emit('failure', error);
  }
  function close() {
    if (closing) return done;
    closing = true;
    fail('closed');
    if (!ended) {
      // EOF gives the RPC parent time to reap its research worker. Only kill our child.
      timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, graceMs);
      try { child.stdin.end(); } catch { /* The owned-process timer still applies. */ }
    }
    return done;
  }
  function broken(code) { fail(code); void close(); }
  child.stdout.on('data', chunk => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1 && !stopped) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        if (response?.event === 'progress') {
          const waiter = pending.get(response.id);
          const point = response.data;
          if (!waiter?.onProgress || !['strategy', 'benchmark'].includes(point?.phase)
              || !Number.isSafeInteger(point.completed) || !Number.isSafeInteger(point.total)
              || point.completed < 1 || point.completed > point.total) throw fault('protocol_error');
          waiter.onProgress(point);
          continue;
        }
        if (!response || !pending.has(response.id) || typeof response.ok !== 'boolean'
            || (response.ok ? !Object.hasOwn(response, 'result') : !response.error)) {
          throw fault('protocol_error');
        }
        const waiter = pending.get(response.id);
        pending.delete(response.id);
        if (response.ok) waiter.resolve(response.result);
        else waiter.reject(fault(Object.hasOwn(messages, response.error.code)
          ? response.error.code : 'internal_error'));
      } catch { broken('protocol_error'); }
    }
  });
  child.stdout.on('end', () => {
    buffer += decoder.end();
    if (!closing) broken(buffer.trim() ? 'protocol_error' : 'exited');
  });
  child.stdout.on('error', () => broken('protocol_error'));
  child.stderr.on('error', () => {});
  child.stderr.resume(); // Drain without recording or forwarding potentially sensitive diagnostics.
  child.stdin.on('error', () => broken('write_failed'));
  child.on('error', () => broken('spawn_failed'));
  child.on('exit', () => fail('exited'));
  child.on('close', () => {
    ended = true;
    clearTimeout(timer);
    fail('exited');
    finish();
  });
  api.request = (method, params = {}, { onProgress } = {}) => new Promise((resolve, reject) => {
    if (stopped || closing) { reject(fault('closed')); return; }
    const id = `ui-${++sequence}`;
    let line;
    try { line = JSON.stringify({ id, method, params }) + '\n'; }
    catch { reject(fault('invalid_request')); return; }
    pending.set(id, { resolve, reject, onProgress });
    try { child.stdin.write(line, error => { if (error) broken('write_failed'); }); }
    catch { broken('write_failed'); }
  });
  api.close = close;
  return api;
}

export function createBackend({ root = ROOT, platform = process.platform, exists = existsSync,
  spawn = spawnProcess, graceMs = 4000 } = {}) {
  const executable = interpreterPath(root, platform, exists);
  let child;
  try {
    child = spawn(executable, ['-m', 'itt.rpc'], {
      cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw fault('spawn_failed'); }
  return connectChild(child, { graceMs });
}