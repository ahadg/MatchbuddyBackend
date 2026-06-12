import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'ssh2';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.deploy');

// Colors for console logging
const colors = {
  reset: '\x1b[0m',
  info: '\x1b[36m', // Cyan
  success: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
};

function log(msg, color = colors.info) {
  console.log(`${color}${msg}${colors.reset}`);
}

if (!fs.existsSync(envPath)) {
  log(`Error: .env.deploy file not found at ${envPath}`, colors.error);
  log(`Please create it by copying .env.deploy.example to .env.deploy`, colors.warn);
  process.exit(1);
}

// Load deployment environment configurations
const deployEnv = dotenv.parse(fs.readFileSync(envPath));

const host = deployEnv.DEPLOY_HOST;
const port = parseInt(deployEnv.DEPLOY_PORT || '22', 10);
const username = deployEnv.DEPLOY_USER || 'root';
const password = deployEnv.DEPLOY_PASSWORD;
const privateKeyPath = deployEnv.DEPLOY_KEY_PATH;
const deployPath = deployEnv.DEPLOY_PATH;
const repoUrl = deployEnv.DEPLOY_REPO;
const branch = deployEnv.DEPLOY_BRANCH || 'main';

if (!host || !deployPath || !repoUrl) {
  log("Error: DEPLOY_HOST, DEPLOY_PATH, and DEPLOY_REPO must be defined in .env.deploy", colors.error);
  process.exit(1);
}

// Read private key if path is provided
let privateKey;
if (privateKeyPath) {
  try {
    const resolvedKeyPath = privateKeyPath.startsWith('~')
      ? path.join(process.env.HOME || '', privateKeyPath.slice(1))
      : path.resolve(__dirname, '..', privateKeyPath);
    privateKey = fs.readFileSync(resolvedKeyPath);
  } catch (err) {
    log(`Error reading private key at ${privateKeyPath}: ${err.message}`, colors.error);
    process.exit(1);
  }
}

// Setup SSH Connection Settings
const sshConfig = {
  host,
  port,
  username,
  tryKeyboard: true,
};

if (privateKey) {
  sshConfig.privateKey = privateKey;
  if (password) {
    sshConfig.passphrase = password; // use password as passphrase if encrypted key
  }
} else if (password) {
  sshConfig.password = password;
} else {
  log("Error: Either DEPLOY_PASSWORD or DEPLOY_KEY_PATH must be provided in .env.deploy", colors.error);
  process.exit(1);
}

// Function to run remote commands via SSH2
function executeCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    log(`Running: ${cmd}`, colors.info);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      stream.on('close', (code, signal) => {
        if (code !== 0) {
          reject(new Error(`Command failed with code ${code}`));
        } else {
          resolve({ stdout, stderr });
        }
      });

      stream.on('data', (data) => {
        const out = data.toString();
        stdout += out;
        process.stdout.write(out);
      });

      stream.stderr.on('data', (data) => {
        const err = data.toString();
        stderr += err;
        process.stderr.write(err);
      });
    });
  });
}

const conn = new Client();

conn.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
  if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
    finish([password]);
  } else {
    finish([]);
  }
});

conn.on('ready', async () => {
  log(`\nSuccessfully connected to VPS (${host}:${port}) as ${username}`, colors.success);
  
  try {
    // 1. Ensure deploy directory exists
    log('\n--- Checking deployment directory ---');
    await executeCommand(conn, `mkdir -p $(dirname "${deployPath}")`);
    
    // 2. Clone repository if it does not exist, otherwise checkout & pull
    log('\n--- Updating code repository ---');
    const { stdout: dirCheck } = await executeCommand(conn, `if [ -d "${deployPath}/.git" ]; then echo "exists"; else echo "empty"; fi`);
    
    if (dirCheck.includes('empty')) {
      log(`Cloning repository into ${deployPath}...`, colors.warn);
      await executeCommand(conn, `git clone -b "${branch}" "${repoUrl}" "${deployPath}"`);
    } else {
      log('Repository exists. Fetching latest changes...', colors.info);
      await executeCommand(conn, `cd "${deployPath}" && git fetch origin && git checkout "${branch}" && git pull origin "${branch}"`);
    }

    // 3. Construct and write the production .env file on VPS
    log('\n--- Writing production environment variables ---');
    const prodEnvLines = [];
    for (const [key, value] of Object.entries(deployEnv)) {
      if (key.startsWith('PROD_')) {
        const realKey = key.slice(5); // strip 'PROD_' prefix
        prodEnvLines.push(`${realKey}=${value}`);
      } else if (key === 'ADMIN_EMAILS') {
        prodEnvLines.push(`ADMIN_EMAILS=${value}`);
      }
    }
    const remoteEnvContent = prodEnvLines.join('\n');
    
    // Escape single quotes in env content safely
    const escapedEnvContent = remoteEnvContent.replace(/'/g, "'\\''");
    
    await executeCommand(conn, `cat << 'EOF' > "${deployPath}/.env"\n${escapedEnvContent}\nEOF`);
    log('Successfully wrote remote .env file', colors.success);

    // 4. Install npm dependencies
    log('\n--- Installing dependencies ---');
    await executeCommand(conn, `cd "${deployPath}" && npm install --omit=dev`);

    // 5. Run Database migrations
    log('\n--- Running database migrations ---');
    await executeCommand(conn, `cd "${deployPath}" && npm run migrate`);

    // 6. Start / Reload with PM2
    log('\n--- Starting / Reloading application in PM2 ---');
    await executeCommand(conn, `cd "${deployPath}" && pm2 startOrReload ecosystem.config.cjs`);

    // Save PM2 process list to persist across server reboots
    await executeCommand(conn, 'pm2 save');

    log('\n=============================================');
    log('MATCHBUDDY BACKEND DEPLOYED SUCCESSFULLY!', colors.success);
    log('=============================================\n');

  } catch (error) {
    log(`\nDeployment failed: ${error.message}`, colors.error);
  } finally {
    conn.end();
  }
}).on('error', (err) => {
  log(`SSH connection error: ${err.message}`, colors.error);
}).connect(sshConfig);
