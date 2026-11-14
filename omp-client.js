// Minimal client for `omp --mode rpc` (JSONL over stdio, LF-only framing, protocol v2 chunking).
'use strict';
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { EventEmitter } = require('events');

class OmpClient extends EventEmitter {
  constructor({ command, args, cwd, env }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map(); // request id -> { resolve, reject }
    this.chunks = new Map();  // v2 chunkId -> base64 parts
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Split on "\n" only. Node readline also splits on U+2028/2029, which is
    // valid inside JSON strings and would corrupt records.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { this.emit('stderr', line + '\n'); continue; }
        this.handle(rec);
      }
    });
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this.proc.on('error', (err) => this.onExit({ error: err }));
    this.proc.on('exit', (code, signal) => this.onExit({ code, signal }));
    // v2 splits frames over 1 MiB (e.g. get_available_models) into rpc_chunk records.
    this.send({ type: 'negotiate_protocol', protocolVersion: 2 });
  }

  handle(rec) {
    if (rec.type === 'rpc_chunk') {
      const parts = this.chunks.get(rec.chunkId) || [];
      parts[rec.index] = rec.data;
      this.chunks.set(rec.chunkId, parts);
      if (parts.filter(Boolean).length < rec.count) return;
      this.chunks.delete(rec.chunkId);
      rec = JSON.parse(Buffer.concat(parts.map((p) => Buffer.from(p, 'base64'))).toString('utf8'));
    }
    if (rec.type === 'response' && this.pending.has(rec.id)) {
      const { resolve, reject } = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      return rec.success === false ? reject(new Error(rec.error || `${rec.command} failed`)) : resolve(rec.data);
    }
    if (rec.type === 'response' && rec.command === 'negotiate_protocol') return;
    this.emit('record', rec);
  }

  onExit(info) {
    this.proc = null;
    for (const { reject } of this.pending.values()) reject(new Error('omp exited'));
    this.pending.clear();
    this.emit('exit', info);
  }

  send(cmd) {
    if (!this.proc) this.start();
    const id = cmd.id || 'req_' + ++this.seq;
    this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
    return id;
  }

  // Send a command and resolve with its response data (rejects on success: false).
  request(cmd) {
    if (!this.proc) return Promise.reject(new Error('omp is not running'));
    return new Promise((resolve, reject) => {
      const id = 'req_' + ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.send({ ...cmd, id });
    });
  }

  prompt(message, streamingBehavior, images) {
    const cmd = { type: 'prompt', message };
    if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
    if (images?.length) cmd.images = images; // [{ type: 'image', data: base64, mimeType }]
    return this.send(cmd);
  }

  abort() {
    if (this.proc) this.send({ type: 'abort' });
  }

  dispose() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    const p = this.proc;
    setTimeout(() => { try { p.kill(); } catch {} }, 1500);
    this.proc = null;
  }
}

module.exports = { OmpClient };
