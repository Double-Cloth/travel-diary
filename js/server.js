const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createRecordApi } = require('./record-store.js');
const { readAuthConfig } = require('./auth.js');

const CONFIG = {
  defaultPort: 9000,
  maxPortRetries: 100,
  defaultDir: '.',
  defaultLocal: true,
  defaultWriteMode: 'local'
};

function parseArgs(argv) {
  const args = {
    dir: CONFIG.defaultDir,
    port: CONFIG.defaultPort,
    local: CONFIG.defaultLocal,
    writeMode: CONFIG.defaultWriteMode
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--dir' && index + 1 < argv.length) {
      args.dir = argv[index + 1];
      index += 1;
    } else if (current.startsWith('--dir=')) {
      args.dir = current.slice('--dir='.length);
    } else if (current === '--port' && index + 1 < argv.length) {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (current.startsWith('--port=')) {
      args.port = Number(current.slice('--port='.length));
    } else if (current === '--local') {
      args.local = true;
    } else if (current === '--network') {
      args.local = false;
    } else if (current === '--write-mode' && index + 1 < argv.length) {
      args.writeMode = argv[index + 1];
      index += 1;
    } else if (current.startsWith('--write-mode=')) {
      args.writeMode = current.slice('--write-mode='.length);
    } else if (current === '--help' || current === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`未知参数或缺少参数值：${current}`);
    }
  }

  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。');
  }
  if (!args.dir.trim() || args.dir.startsWith('--')) {
    throw new Error('请指定有效的目录路径。');
  }
  if (!['local', 'remote'].includes(args.writeMode)) {
    throw new Error('写入模式必须是 local 或 remote。');
  }

  return args;
}

function printHelpAndExit() {
  const message = `
Travel Diary static server

Usage:
  node js/server.js [--dir PATH] [--port PORT] [--local|--network] [--write-mode=MODE]

Options:
  --dir PATH    Directory to serve (default: ${CONFIG.defaultDir})
  --port PORT   Starting port (default: ${CONFIG.defaultPort})
  --local       Bind to 127.0.0.1 only (default)
  --network     Bind to 0.0.0.0 for LAN access
  --write-mode  Write policy: local (default) or remote
  --help, -h    Show this help

Authentication:
  Run npm run auth:set before remote deployment. Remote mode refuses legacy weak credentials.

Examples:
  node js/server.js
  node js/server.js --dir . --port 9000
  node js/server.js --network
  npm run auth:set
  node js/server.js --network --write-mode=remote
`;

  process.stdout.write(message.trimStart() + '\n');
  process.exit(0);
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }

  return '127.0.0.1';
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;

  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', (error) => {
    console.warn(`无法自动打开浏览器，请手动访问 ${url}：${error.message}`);
  });
  child.unref();
}

function guessContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.mjs':
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function safeJoin(rootDir, requestPath) {
  const normalizedPath = requestPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalizedPath.includes('\0') || normalizedPath.includes(':')) return null;
  const resolvedPath = path.resolve(rootDir, normalizedPath);
  if (!isWithinRoot(rootDir, resolvedPath)) {
    return null;
  }

  return resolvedPath;
}

function isWithinRoot(rootDir, targetPath) {
  const relativePath = path.relative(rootDir, targetPath);
  return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function createHandler(rootDir, options = {}) {
  rootDir = fs.realpathSync(rootDir);
  const secretsRoot = path.join(rootDir, '.secrets');
  const recordApi = createRecordApi(rootDir, { writeMode: options.writeMode || CONFIG.defaultWriteMode });
  return async (req, res) => {
    if (['/api/travel-auth', '/api/travel-records', '/api/travel-data'].includes(req.url.split('?')[0])) {
      await recordApi(req, res);
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Requested-With, Content-Type'
      });
      res.end('ok');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET, HEAD, OPTIONS'
      });
      res.end('Method Not Allowed');
      return;
    }

    let requestUrl;
    let pathname;
    try {
      requestUrl = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const firstSegment = pathname.replace(/^\/+/, '').split('/')[0];
    if (firstSegment.startsWith('.')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const filePath = safeJoin(rootDir, pathname);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    try {
      let targetPath = await fs.promises.realpath(filePath);
      if (!isWithinRoot(rootDir, targetPath) || isWithinRoot(secretsRoot, targetPath)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      let stats = await fs.promises.stat(targetPath);
      if (stats.isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.writeHead(301, { Location: `${requestUrl.pathname}/${requestUrl.search}` });
          res.end();
          return;
        }
        targetPath = await fs.promises.realpath(path.join(targetPath, 'index.html'));
        stats = await fs.promises.stat(targetPath);
      }
      if (!isWithinRoot(rootDir, targetPath) || isWithinRoot(secretsRoot, targetPath)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      if (!stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': guessContentType(targetPath),
        'Content-Length': stats.size,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Requested-With, Content-Type'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(targetPath);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      const status = error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 404;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 403 ? 'Forbidden' : 'Not Found');
    }
  };
}

function listenWithRetries(rootDir, port, bindAll, options = {}) {
  const host = bindAll ? '0.0.0.0' : '127.0.0.1';
  let currentPort = port;

  return new Promise((resolve, reject) => {
    const tryListen = () => {
      const server = http.createServer(createHandler(rootDir, options));

      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          currentPort += 1;
          if (currentPort > 65535 || currentPort >= port + CONFIG.maxPortRetries) {
            reject(new Error(`Unable to find a free port between ${port} and ${currentPort}.`));
            return;
          }

          server.close(() => tryListen());
          return;
        }

        reject(error);
      });

      server.listen(currentPort, host, () => resolve({ server, port: currentPort }));
    };

    tryListen();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.dir);

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Directory does not exist: ${rootDir}`);
  }

  if (args.writeMode === 'remote') {
    await readAuthConfig(rootDir, { requireProduction: true });
  }

  const { server, port } = await listenWithRetries(rootDir, args.port, !args.local, { writeMode: args.writeMode });
  const localhostUrl = `http://localhost:${port}`;
  const networkUrl = args.local ? 'disabled (local only)' : `http://${getLocalIp()}:${port}`;

  console.log('='.repeat(60));
  console.log('Server started');
  console.log(`Root: ${rootDir}`);
  console.log(`Bind: ${args.local ? '127.0.0.1 (--local)' : '0.0.0.0 (--network)'}`);
  console.log(`Write mode: ${args.writeMode}`);
  console.log('Authentication: .secrets/auth.json (scrypt + server session)');
  console.log('-'.repeat(60));
  console.log(`Local: ${localhostUrl}`);
  if (!args.local) {
    console.log(`Network: ${networkUrl}`);
  }
  if (args.writeMode === 'remote') {
    console.log('-'.repeat(60));
    console.warn('WARNING: Remote writes are enabled for same-site requests.');
    console.warn('Protect public deployments with a reverse proxy, VPN, Zero Trust, or HTTP authentication.');
  }
  console.log('-'.repeat(60));
  console.log('Tip: refresh the page after file changes. Press Ctrl+C to stop.');
  console.log('='.repeat(60));

  setTimeout(() => {
    openBrowser(localhostUrl);
  }, 500);

  process.on('SIGINT', () => {
    console.log('\nStopping server...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createHandler, parseArgs, safeJoin, listenWithRetries };
