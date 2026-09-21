const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createRecordApi, normalizeAllowedOrigins } = require('./record-store.js');
const { readAuthConfig } = require('./auth.js');

const CONFIG = {
  defaultPort: 9000,
  maxPortRetries: 100,
  defaultDir: '.',
  defaultLocal: true,
  defaultWriteMode: 'local'
};

const STATIC_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function parseArgs(argv) {
  const args = {
    dir: CONFIG.defaultDir,
    port: CONFIG.defaultPort,
    local: CONFIG.defaultLocal,
    writeMode: CONFIG.defaultWriteMode,
    allowedOrigins: []
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
    } else if (current === '--allowed-origin' && index + 1 < argv.length) {
      args.allowedOrigins.push(argv[index + 1]);
      index += 1;
    } else if (current.startsWith('--allowed-origin=')) {
      args.allowedOrigins.push(current.slice('--allowed-origin='.length));
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
  args.allowedOrigins = normalizeAllowedOrigins(args.allowedOrigins);
  if (args.writeMode === 'remote' && !args.allowedOrigins.length) {
    throw new Error('remote write mode 必须通过 --allowed-origin 指定至少一个 HTTPS 站点来源。');
  }
  if (args.writeMode === 'local' && args.allowedOrigins.length) {
    throw new Error('--allowed-origin 仅能与 --write-mode=remote 同时使用。');
  }

  return args;
}

function printHelpAndExit() {
  const message = `
Travel Diary static server

Usage:
  node js/server.js [--dir PATH] [--port PORT] [--local|--network] [--write-mode=MODE] [--allowed-origin=ORIGIN]

Options:
  --dir PATH    Directory to serve (default: ${CONFIG.defaultDir})
  --port PORT   Starting port (default: ${CONFIG.defaultPort})
  --local       Bind to 127.0.0.1 only (default)
  --network     Bind to 0.0.0.0 for LAN access
  --write-mode  Write policy: local (default) or remote
  --allowed-origin  Exact HTTPS Origin allowed in remote mode (repeatable)
  --help, -h    Show this help

Authentication:
  On first local write, create and confirm the 6-digit password in the browser.
  Run npm run auth:set only to repair or forcibly reset a damaged password configuration.

Examples:
  node js/server.js
  node js/server.js --dir . --port 9000
  node js/server.js --network
  node js/server.js --local --write-mode=remote --allowed-origin=https://diary.example.com
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
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.ogv':
    case '.ogg':
      return 'video/ogg';
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

function parseByteRange(value, size) {
  if (typeof value !== 'string' || !value.startsWith('bytes=') || value.includes(',') || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
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

async function ensureDataStructure(rootDir) {
  const resolvedRoot = await fs.promises.realpath(rootDir);
  const directories = ['.secrets', 'data', 'data/travel-diary', 'data/photos', 'data/videos', 'data/profile'];
  let secretsCreated = false;

  for (const relativePath of directories) {
    const directory = path.join(resolvedRoot, ...relativePath.split('/'));
    let created = false;
    try {
      await fs.promises.mkdir(directory);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (relativePath === '.secrets') secretsCreated = created;
    const stats = await fs.promises.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${relativePath} 必须是项目内的普通目录。`);
    }
    const realDirectory = await fs.promises.realpath(directory);
    if (!isWithinRoot(resolvedRoot, realDirectory)) {
      throw new Error(`${relativePath} 不能指向项目目录之外。`);
    }
  }

  const initialFiles = [
    {
      path: path.join(resolvedRoot, 'data', 'travel_data.json'),
      content: Buffer.from('[]\n', 'utf8'),
      label: 'data/travel_data.json'
    },
    {
      path: path.join(resolvedRoot, 'data', 'profile', 'profile-picture.png'),
      content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64'),
      label: 'data/profile/profile-picture.png'
    }
  ];

  for (const file of initialFiles) {
    let handle;
    let created = false;
    try {
      handle = await fs.promises.open(file.path, 'wx');
      created = true;
      await handle.writeFile(file.content);
      await handle.sync();
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (handle) await handle.close().catch(() => {});
        if (created) await fs.promises.unlink(file.path).catch(() => {});
        throw error;
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
    }

    const stats = await fs.promises.lstat(file.path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${file.label} 必须是项目内的普通文件。`);
    }
  }

  const authFile = path.join(resolvedRoot, '.secrets', 'auth.json');
  let authConfigured = false;
  try {
    const authStat = await fs.promises.lstat(authFile);
    if (authStat.isSymbolicLink() || !authStat.isFile()) {
      throw new Error('.secrets/auth.json 必须是项目内的普通文件。');
    }
    authConfigured = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { authConfigured, secretsCreated };
}

function createHandler(rootDir, options = {}) {
  rootDir = fs.realpathSync(rootDir);
  const secretsRoot = path.join(rootDir, '.secrets');
  const recordApi = createRecordApi(rootDir, {
    writeMode: options.writeMode || CONFIG.defaultWriteMode,
    allowedOrigins: options.allowedOrigins || []
  });
  return async (req, res) => {
    if (['/api/travel-auth', '/api/travel-auth/setup', '/api/travel-records', '/api/travel-data', '/api/travel-profile'].includes(req.url.split('?')[0])) {
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

      const requestedRange = req.headers.range;
      const range = requestedRange ? parseByteRange(requestedRange, stats.size) : null;
      if (requestedRange && !range) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stats.size}`,
          'Accept-Ranges': 'bytes',
          ...STATIC_SECURITY_HEADERS
        });
        res.end();
        return;
      }
      const responseStatus = range ? 206 : 200;
      const contentLength = range ? range.end - range.start + 1 : stats.size;
      res.writeHead(responseStatus, {
        'Content-Type': guessContentType(targetPath),
        'Content-Length': contentLength,
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}` } : {}),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Requested-With, Content-Type',
        ...STATIC_SECURITY_HEADERS
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(targetPath, range ? { start: range.start, end: range.end } : undefined);
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

async function listenWithRetries(rootDir, port, bindAll, options = {}) {
  await ensureDataStructure(rootDir);
  const host = bindAll ? '0.0.0.0' : '127.0.0.1';
  let currentPort = port;

  return new Promise((resolve, reject) => {
    const tryListen = () => {
      const server = http.createServer(createHandler(rootDir, options));
      server.requestTimeout = 120_000;
      server.headersTimeout = 15_000;
      server.keepAliveTimeout = 5_000;
      server.maxHeadersCount = 100;

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

  const structure = await ensureDataStructure(rootDir);
  if (args.writeMode === 'remote') {
    await readAuthConfig(rootDir, { requireProduction: true });
  }

  const { server, port } = await listenWithRetries(rootDir, args.port, !args.local, {
    writeMode: args.writeMode,
    allowedOrigins: args.allowedOrigins
  });
  const localhostUrl = `http://localhost:${port}`;
  const networkUrl = args.local ? 'disabled (local only)' : `http://${getLocalIp()}:${port}`;

  console.log('='.repeat(60));
  console.log('Server started');
  console.log(`Root: ${rootDir}`);
  console.log(`Bind: ${args.local ? '127.0.0.1 (--local)' : '0.0.0.0 (--network)'}`);
  console.log(`Write mode: ${args.writeMode}`);
  if (args.writeMode === 'remote') console.log(`Allowed origins: ${args.allowedOrigins.join(', ')}`);
  console.log('Authentication: .secrets/auth.json (scrypt + server session)');
  if (!structure.authConfigured) {
    console.warn(structure.secretsCreated
      ? '未发现 .secrets，已自动创建该目录；首次执行写入操作时可在页面创建访问密码。'
      : '尚未创建 .secrets/auth.json；首次执行写入操作时可在页面创建访问密码。');
  }
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

  // setTimeout(() => {
  //   openBrowser(localhostUrl);
  // }, 500);

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

module.exports = { createHandler, ensureDataStructure, parseArgs, safeJoin, listenWithRetries, parseByteRange };
