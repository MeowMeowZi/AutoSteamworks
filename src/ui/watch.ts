// 变化通知：网页的 SSE 连接，以及本地文件变了（AI 或编辑器改的）就通知网页刷新。文件不多，直接轮询 mtime。
import type { ServerResponse } from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, loadConfig } from '../config.js';
import { listProjects } from '../projects.js';

export interface WatchOptions {
  /** 返回 true 时不轮询（任务进行中，文件会连续变化，任务结束时自己会通知） */
  paused: () => boolean;
  /** 轮询间隔，默认 1000ms */
  intervalMs?: number;
}

/** 所有项目里网页会显示的文件的 路径 + mtime + 大小 */
function signature() {
  const parts: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const s = statSync(p);
    if (!s.isDirectory()) { parts.push(p + s.mtimeMs + ':' + s.size); return; }
    for (const f of readdirSync(p)) walk(join(p, f));
  };
  walk(join(appHome(), 'projects.json'));
  for (const { config } of listProjects()) {
    try {
      walk(config);
      walk(join(config, '..', 'STEAM_RULES.md'));
      if (!existsSync(config)) continue;
      const c = loadConfig(config);
      for (const a of c.apps) {
        walk(a.storeDir); walk(a.assets.dir);
        for (const d of ['snapshots', 'assets', 'remote']) walk(join(c.stateDir, d, a.key + '.json'));
      }
    } catch (e) {
      parts.push('error:' + e);
    }
  }
  return parts.join('|');
}

export function createWatch({ paused, intervalMs = 1000 }: WatchOptions) {
  const clients = new Set<ServerResponse>();

  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  let lastSig = signature();
  const timer = setInterval(() => {
    if (!clients.size || paused()) return;
    const s = signature();
    if (s !== lastSig) { lastSig = s; send('changed', null); }
  }, intervalMs);

  return {
    send,
    /** 接上一个 GET /api/events 请求 */
    attach(res: ServerResponse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    /** 接口自己改了文件：马上通知，并记下新状态，免得轮询再通知一次 */
    touched() { lastSig = signature(); send('changed', null); },
    close() {
      clearInterval(timer);
      for (const c of clients) c.end();
    },
  };
}
