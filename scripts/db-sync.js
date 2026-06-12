import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Client } from 'ssh2';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.deploy');
const localEnvPath = path.resolve(__dirname, '../.env');

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

// Ensure .env.deploy exists
if (!fs.existsSync(envPath)) {
  log(`Error: .env.deploy file not found at ${envPath}`, colors.error);
  log(`Please create it by copying .env.deploy.example to .env.deploy`, colors.warn);
  process.exit(1);
}

// Load deployment environment configuration
const deployEnv = dotenv.parse(fs.readFileSync(envPath));

const host = deployEnv.DEPLOY_HOST;
const port = parseInt(deployEnv.DEPLOY_PORT || '22', 10);
const username = deployEnv.DEPLOY_USER || 'root';
const password = deployEnv.DEPLOY_PASSWORD;
const privateKeyPath = deployEnv.DEPLOY_KEY_PATH;
const remoteDbContainer = deployEnv.REMOTE_DB_CONTAINER;

if (!host) {
  log("Error: DEPLOY_HOST must be defined in .env.deploy", colors.error);
  process.exit(1);
}

const remoteDbUrl = deployEnv.PROD_DATABASE_URL;
if (!remoteDbUrl) {
  log("Error: PROD_DATABASE_URL must be defined in .env.deploy", colors.error);
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
    sshConfig.passphrase = password;
  }
} else if (password) {
  sshConfig.password = password;
} else {
  log("Error: Either DEPLOY_PASSWORD or DEPLOY_KEY_PATH must be provided in .env.deploy", colors.error);
  process.exit(1);
}

// Local Database dump configuration
const localDumpFile = path.resolve(__dirname, '../matchbuddy_backup.dump');
const remoteDumpFile = '/tmp/matchbuddy_backup.dump';

// Parse production DB connection URL
let parsedRemoteDb;
try {
  const url = new URL(remoteDbUrl);
  parsedRemoteDb = {
    user: url.username,
    pass: url.password,
    host: url.hostname,
    port: url.port || '5432',
    name: url.pathname.replace(/^\//, ''),
  };
} catch (err) {
  log(`Error parsing PROD_DATABASE_URL: ${err.message}`, colors.error);
  process.exit(1);
}

// Function to run remote commands via SSH2
function executeCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    log(`Running remote: ${cmd}`, colors.info);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      stream.on('close', (code, signal) => {
        if (code !== 0) {
          reject(new Error(`Remote command failed with code ${code}. Stderr: ${stderr.trim()}`));
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

// Function to upload a file via SFTP
function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    log(`Uploading local database backup to ${remotePath}...`, colors.info);
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, {}, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

// --- Step 1: Dump Local Database ---
function dumpLocalDatabase() {
  log('\n--- Step 1: Creating local database dump ---');

  // Check if docker is running and contains the postgis container
  let isLocalDocker = false;
  try {
    const check = execSync('docker ps --filter name=matchbuddy-postgis --format "{{.Names}}"', { stdio: 'pipe' }).toString().trim();
    if (check.includes('matchbuddy-postgis')) {
      isLocalDocker = true;
    }
  } catch (err) {
    // Docker command not available or container not running
  }

  try {
    if (isLocalDocker) {
      log('Detected local database running in Docker container: matchbuddy-postgis');
      // Use interactive redirect without TTY to prevent binary corruption (\r replacement)
      const dumpCmd = `docker exec -i matchbuddy-postgis pg_dump -U postgres -d matchbuddy -F c -b -v > "${localDumpFile}"`;
      log(`Running: ${dumpCmd}`);
      execSync(dumpCmd);
    } else {
      log('Using native local postgres connection from .env...');
      if (!fs.existsSync(localEnvPath)) {
        throw new Error('.env file containing DATABASE_URL was not found.');
      }
      dotenv.config({ path: localEnvPath });
      const localDbUrl = process.env.DATABASE_URL;
      if (!localDbUrl) {
        throw new Error('DATABASE_URL is missing in .env');
      }

      const url = new URL(localDbUrl);
      const localPass = url.password;
      const localUser = url.username;
      const localHost = url.hostname;
      const localPort = url.port || '5432';
      const localName = url.pathname.replace(/^\//, '');

      const dumpCmd = `PGPASSWORD="${localPass}" pg_dump -h "${localHost}" -p "${localPort}" -U "${localUser}" -d "${localName}" -F c -b -v -f "${localDumpFile}"`;
      log(`Running: pg_dump (host: ${localHost}:${localPort}, database: ${localName})`);
      execSync(dumpCmd);
    }

    const stats = fs.statSync(localDumpFile);
    log(`Database dump created successfully! (${(stats.size / 1024 / 1024).toFixed(2)} MB)`, colors.success);
  } catch (error) {
    log(`Failed to dump local database: ${error.message}`, colors.error);
    process.exit(1);
  }
}

// Run local dump immediately
dumpLocalDatabase();

// --- Step 2: Establish SSH connection and upload/restore dump ---
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
    // 2. Upload file via SFTP
    log('\n--- Step 2: Uploading database dump to remote server ---');
    await uploadFile(conn, localDumpFile, remoteDumpFile);
    log('Upload complete.', colors.success);

    // 3. Restore database
    log('\n--- Step 3: Restoring database on remote server ---');
    
    if (remoteDbContainer) {
      log(`Restoring database inside Docker container: ${remoteDbContainer}`);
      
      // Attempt to create database if it doesn't exist (ignores if database already exists)
      try {
        await executeCommand(conn, `docker exec -i ${remoteDbContainer} createdb -U postgres "${parsedRemoteDb.name}" 2>/dev/null || true`);
      } catch (e) {
        // Ignore failure in database creation if it already exists
      }

      // Restore schema and data
      // --clean drops database objects before recreating them
      // --no-owner and --no-privileges makes it clean for different DB roles
      const restoreCmd = `docker exec -i ${remoteDbContainer} pg_restore -U postgres -d "${parsedRemoteDb.name}" --clean --no-owner --no-privileges < "${remoteDumpFile}"`;
      await executeCommand(conn, restoreCmd);

    } else {
      log(`Restoring database on native host PostgreSQL...`);

      // Attempt to create database if it doesn't exist
      try {
        await executeCommand(conn, `PGPASSWORD="${parsedRemoteDb.pass}" createdb -h "${parsedRemoteDb.host}" -p "${parsedRemoteDb.port}" -U "${parsedRemoteDb.user}" "${parsedRemoteDb.name}" 2>/dev/null || true`);
      } catch (e) {
        // Ignore failure in database creation
      }

      const restoreCmd = `PGPASSWORD="${parsedRemoteDb.pass}" pg_restore -h "${parsedRemoteDb.host}" -p "${parsedRemoteDb.port}" -U "${parsedRemoteDb.user}" -d "${parsedRemoteDb.name}" --clean --no-owner --no-privileges < "${remoteDumpFile}"`;
      await executeCommand(conn, restoreCmd);
    }

    log('Database restored successfully!', colors.success);

    // 4. Cleanup remote dump file
    log('\n--- Step 4: Cleaning up temporary dump files ---');
    await executeCommand(conn, `rm -f "${remoteDumpFile}"`);
    log('Cleaned up remote backup file.', colors.success);

    // Cleanup local dump file
    fs.unlinkSync(localDumpFile);
    log('Cleaned up local backup file.', colors.success);

    log('\n=============================================');
    log('DATABASE SYNCED TO VPS SUCCESSFULLY!', colors.success);
    log('=============================================\n');

  } catch (error) {
    log(`\nDatabase synchronization failed: ${error.message}`, colors.error);
    
    // Attempt local file cleanup
    if (fs.existsSync(localDumpFile)) {
      try { fs.unlinkSync(localDumpFile); } catch (e) {}
    }
  } finally {
    conn.end();
  }
}).on('error', (err) => {
  log(`SSH connection error: ${err.message}`, colors.error);
  if (fs.existsSync(localDumpFile)) {
    try { fs.unlinkSync(localDumpFile); } catch (e) {}
  }
}).connect(sshConfig);
