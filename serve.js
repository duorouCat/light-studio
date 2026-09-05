// 光影实验室 · 零依赖静态服务器（供 file:// 无法运行 ES Module 时使用）
// 支持：自动选择空闲端口（候选列表 + PORT 环境变量优先）、绑定 127.0.0.1、
//       监听成功后自动用默认浏览器打开页面（设 OPEN_BROWSER=0 可关闭）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const CANDIDATE_PORTS = [8321, 8000, 8080, 3000, 5173];
const desiredPort = Number(process.env.PORT || 0);
const ports = desiredPort
  ? [desiredPort, ...CANDIDATE_PORTS.filter((p) => p !== desiredPort)]
  : CANDIDATE_PORTS;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function handler(req, res) {
  (async () => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = normalize(join(root, pathname));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const st = await stat(filePath);
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  })();
}

/** 启动单个打开命令；成功派发返回 true（以退出码/超时判断） */
function tryLaunch(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(true), 2000);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0 || code === null));
  });
}

/** 用系统默认浏览器打开页面：多策略依次兜底，任何失败都不影响服务器运行 */
async function openBrowser(url) {
  if (process.env.OPEN_BROWSER === '0') return;
  const strategies =
    process.platform === 'win32'
      ? [
          ['cmd', ['/d', '/s', '/c', 'start', '', url]],
          ['rundll32', ['url.dll,FileProtocolHandler', url]],
          ['explorer', [url]],
          ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`]],
        ]
      : process.platform === 'darwin'
        ? [['open', [url]]]
        : [['xdg-open', [url]]];
  for (const [bin, args] of strategies) {
    if (await tryLaunch(bin, args)) {
      console.log(`已在默认浏览器中打开：${url}`);
      return;
    }
  }
  console.log(`未能自动打开浏览器，请手动访问：${url}`);
}

function tryListen(i) {
  if (i >= ports.length) {
    console.error('所有候选端口均被占用，请关闭占用程序后重试。');
    process.exit(1);
  }
  const port = ports[i];
  const server = createServer(handler);
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.warn(`端口 ${port} 不可用（${err.code}），尝试下一个...`);
      tryListen(i + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`光影实验室 Light Studio → ${url}`);
    openBrowser(url);
  });
}

tryListen(0);
