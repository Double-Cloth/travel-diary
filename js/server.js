const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CONFIG = {
  defaultPort: 9000,
  maxPortRetries: 100,
  defaultDir: '.',
  defaultLocal: true
};

function parseArgs(argv) {
  const args = {
    dir: CONFIG.defaultDir,
    port: CONFIG.defaultPort,
    local: CONFIG.defaultLocal
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
    } else if (current === '--help' || current === '-h') {
      printHelpAndExit();
    }
  }

  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new Error('Port must be a positive integer.');
  }

  return args;
}

function printHelpAndExit() {
  const message = `
Travel Diary static server

Usage:
  node js/server.js [--dir PATH] [--port PORT] [--local|--network]

Options:
  --dir PATH    Directory to serve (default: ${CONFIG.defaultDir})
  --port PORT   Starting port (default: ${CONFIG.defaultPort})
  --local       Bind to 127.0.0.1 only (default)
  --network     Bind to 0.0.0.0 for LAN access
  --help, -h    Show this help

Examples:
  node js/server.js
  node js/server.js --dir . --port 9000
  node js/server.js --network
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

  const child = spawn(command, args, { stdio: 'ignore', detached: true });
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
  const normalizedPath = path.normalize(decodeURIComponent(requestPath)).replace(/^([/\\])+/, '');
  const resolvedPath = path.resolve(rootDir, normalizedPath);

  if (!resolvedPath.startsWith(rootDir)) {
    return null;
  }

  return resolvedPath;
}

function createHandler(rootDir) {
  return (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

    const requestUrl = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const filePath = safeJoin(rootDir, pathname);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (statError, stats) => {
      if (statError) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const targetPath = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;

      fs.readFile(targetPath, (readError, data) => {
        if (readError) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        res.writeHead(200, {
          'Content-Type': guessContentType(targetPath),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'X-Requested-With, Content-Type'
        });

        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        res.end(data);
      });
    });
  };
}

function listenWithRetries(rootDir, port, bindAll) {
  const host = bindAll ? '0.0.0.0' : '127.0.0.1';
  let currentPort = port;

  return new Promise((resolve, reject) => {
    const tryListen = () => {
      const server = http.createServer(createHandler(rootDir));

      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          currentPort += 1;
          if (currentPort >= port + CONFIG.maxPortRetries) {
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

  if (!fs.existsSync(rootDir)) {
    throw new Error(`Directory does not exist: ${rootDir}`);
  }

  const { server, port } = await listenWithRetries(rootDir, args.port, !args.local);
  const localhostUrl = `http://localhost:${port}`;
  const networkUrl = args.local ? 'disabled (local only)' : `http://${getLocalIp()}:${port}`;

  console.log('='.repeat(60));
  console.log('Server started');
  console.log(`Root: ${rootDir}`);
  console.log('-'.repeat(60));
  console.log(`Local: ${localhostUrl}`);
  if (!args.local) {
    console.log(`Network: ${networkUrl}`);
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

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
