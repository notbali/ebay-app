// Starts the ngrok tunnel and this app together, and automatically writes the tunnel's public
// URL into .env as PUBLIC_BASE_URL before starting the app - the one step that's easy to forget
// (and easy to get wrong) when running both by hand.
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const PORT = process.env.PORT || '3000';

// Override with NGROK_PATH in .env if "ngrok" isn't on your PATH (e.g. a fresh terminal wasn't
// opened after installing it). See README for the Microsoft Store install path on Windows.
const NGROK_CMD = process.env.NGROK_PATH || 'ngrok';

function updateEnvPublicBaseUrl(newUrl) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  content = /^PUBLIC_BASE_URL=/m.test(content)
    ? content.replace(/^PUBLIC_BASE_URL=.*/m, `PUBLIC_BASE_URL=${newUrl}`)
    : content + `\nPUBLIC_BASE_URL=${newUrl}\n`;
  fs.writeFileSync(ENV_PATH, content);
}

function waitForNgrokUrl(retriesLeft = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const tunnel = (parsed.tunnels || []).find((t) => t.proto === 'https');
            if (tunnel) return resolve(tunnel.public_url);
          } catch { /* ngrok API not ready yet - retry below */ }
          retry(n);
        });
      }).on('error', () => retry(n));
    };
    const retry = (n) => {
      if (n <= 0) return reject(new Error('Timed out waiting for ngrok to report its tunnel URL.'));
      setTimeout(() => attempt(n - 1), 500);
    };
    attempt(retriesLeft);
  });
}

let ngrokProc = null;
let appProc = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (appProc) appProc.kill();
  if (ngrokProc) ngrokProc.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  console.log(`Starting ngrok tunnel for port ${PORT}...`);
  ngrokProc = spawn(NGROK_CMD, ['http', PORT, '--log=stdout'], { stdio: 'inherit' });

  ngrokProc.on('error', (err) => {
    console.error(`Failed to start ngrok ("${NGROK_CMD}"): ${err.message}`);
    console.error('If ngrok is installed but not on PATH, set NGROK_PATH in .env to its full executable path.');
    shutdown(1);
  });
  ngrokProc.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`ngrok exited unexpectedly (code ${code})`);
      shutdown(code || 1);
    }
  });

  let publicUrl;
  try {
    publicUrl = await waitForNgrokUrl();
  } catch (err) {
    console.error(err.message);
    return shutdown(1);
  }

  console.log(`Tunnel ready: ${publicUrl}`);
  updateEnvPublicBaseUrl(publicUrl);
  console.log('Updated .env PUBLIC_BASE_URL to match.');

  console.log('Starting app...');
  appProc = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });

  appProc.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`App exited (code ${code})`);
      shutdown(code || 0);
    }
  });
})();
