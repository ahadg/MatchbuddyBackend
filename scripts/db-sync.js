import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client as SshClient } from 'ssh2';
import dotenv from 'dotenv';
import pg from 'pg';

const { Client: PgClient } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployEnvPath = path.resolve(__dirname, '../.env.deploy');
const localEnvPath = path.resolve(__dirname, '../.env');
const localDumpFile = path.resolve(__dirname, '../matchbuddy_backup.dump');
const localSqlFile = path.resolve(__dirname, '../matchbuddy_sync.sql');
const remoteDumpFile = '/tmp/matchbuddy_backup.dump';
const remoteSqlFile = '/tmp/matchbuddy_sync.sql';

const colors = {
  reset: '\x1b[0m',
  info: '\x1b[36m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function log(message, color = colors.info) {
  console.log(`${color}${message}${colors.reset}`);
}

function fail(message) {
  log(message, colors.error);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    mode: 'fixtures',
  };

  for (const arg of argv) {
    if (arg === '--full') {
      options.mode = 'full';
      continue;
    }

    if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length).trim().toLowerCase();
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  npm run db:sync
  npm run db:sync -- --mode=fixtures
  npm run db:sync -- --mode=catalog
  npm run db:sync -- --mode=full

Modes:
  fixtures  Upsert only fixtures from local DB into the live DB. Safe default.
  catalog   Upsert fixtures, profiles, and listings from local DB into the live DB.
  full      Full pg_dump/pg_restore from local DB into the live DB. Destructive.
`);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseConnectionStringManually(connectionString) {
  const schemeMatch = connectionString.match(/^postgres(?:ql)?:\/\//i);

  if (!schemeMatch) {
    return null;
  }

  const remainder = connectionString.slice(schemeMatch[0].length);
  const atIndex = remainder.lastIndexOf('@');

  if (atIndex === -1) {
    return null;
  }

  const credentialsPart = remainder.slice(0, atIndex);
  const hostAndDbPart = remainder.slice(atIndex + 1);
  const colonIndex = credentialsPart.indexOf(':');

  if (colonIndex === -1) {
    return null;
  }

  const user = credentialsPart.slice(0, colonIndex);
  const pass = credentialsPart.slice(colonIndex + 1);
  const slashIndex = hostAndDbPart.indexOf('/');

  if (slashIndex === -1) {
    return null;
  }

  const hostPortPart = hostAndDbPart.slice(0, slashIndex);
  const databaseName = hostAndDbPart.slice(slashIndex + 1).split('?')[0];
  const lastColonIndex = hostPortPart.lastIndexOf(':');

  if (lastColonIndex === -1) {
    return {
      url: connectionString,
      user: safeDecodeURIComponent(user),
      pass: safeDecodeURIComponent(pass),
      host: hostPortPart,
      port: '5432',
      name: databaseName,
    };
  }

  return {
    url: connectionString,
    user: safeDecodeURIComponent(user),
    pass: safeDecodeURIComponent(pass),
    host: hostPortPart.slice(0, lastColonIndex),
    port: hostPortPart.slice(lastColonIndex + 1),
    name: databaseName,
  };
}

function parseConnectionString(connectionString, label, fallback = null) {
  try {
    const url = new URL(connectionString);
    return {
      url: connectionString,
      user: safeDecodeURIComponent(url.username),
      pass: safeDecodeURIComponent(url.password),
      host: url.hostname,
      port: url.port || '5432',
      name: url.pathname.replace(/^\//, ''),
    };
  } catch (error) {
    const manualParse = parseConnectionStringManually(connectionString);

    if (manualParse) {
      log(
        `Warning: ${label} is not fully URL-encoded. Parsed it using a tolerant PostgreSQL URL parser.`,
        colors.warn,
      );
      return manualParse;
    }

    if (
      fallback?.user &&
      fallback?.host &&
      fallback?.port &&
      fallback?.name &&
      typeof fallback.pass === 'string'
    ) {
      log(
        `Warning: ${label} is not fully URL-encoded. Falling back to explicit database fields instead.`,
        colors.warn,
      );
      return {
        url: connectionString,
        ...fallback,
      };
    }

    fail(`Error parsing ${label}: ${error.message}`);
  }
}

function loadEnvFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`Error: ${label} file not found at ${filePath}`);
  }

  return dotenv.parse(fs.readFileSync(filePath));
}

function resolvePrivateKey(privateKeyPath) {
  if (!privateKeyPath) {
    return null;
  }

  try {
    const resolvedKeyPath = privateKeyPath.startsWith('~')
      ? path.join(process.env.HOME || '', privateKeyPath.slice(1))
      : path.resolve(__dirname, '..', privateKeyPath);

    return fs.readFileSync(resolvedKeyPath);
  } catch (error) {
    fail(`Error reading private key at ${privateKeyPath}: ${error.message}`);
  }
}

function buildSshConfig(deployEnv) {
  const privateKey = resolvePrivateKey(deployEnv.DEPLOY_KEY_PATH);
  const password = deployEnv.DEPLOY_PASSWORD;

  if (!privateKey && !password) {
    fail('Error: Either DEPLOY_PASSWORD or DEPLOY_KEY_PATH must be provided in .env.deploy');
  }

  const config = {
    host: deployEnv.DEPLOY_HOST,
    port: Number.parseInt(deployEnv.DEPLOY_PORT || '22', 10),
    username: deployEnv.DEPLOY_USER || 'root',
    tryKeyboard: true,
  };

  if (privateKey) {
    config.privateKey = privateKey;

    if (password) {
      config.passphrase = password;
    }
  } else {
    config.password = password;
  }

  return config;
}

function readDbFallback(env, prefix = 'POSTGRES') {
  const user = env[`${prefix}_USER`]?.trim();
  const pass = env[`${prefix}_PASSWORD`] ?? '';
  const port = env[`${prefix}_PORT`]?.trim();
  const name = env[`${prefix}_DB`]?.trim();
  const host = env[`${prefix}_HOST`]?.trim() || '127.0.0.1';

  if (!user || !port || !name) {
    return null;
  }

  return {
    user,
    pass,
    host,
    port,
    name,
  };
}

function executeRemoteCommand(conn, command) {
  return new Promise((resolve, reject) => {
    log(`Running remote: ${command}`);
    conn.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Remote command failed with code ${code}. Stderr: ${stderr.trim()}`));
          return;
        }

        resolve({ stdout, stderr });
      });

      stream.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        process.stdout.write(output);
      });

      stream.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        process.stderr.write(output);
      });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    log(`Uploading ${path.basename(localPath)} to ${remotePath}...`);

    conn.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      sftp.fastPut(localPath, remotePath, {}, (putError) => {
        if (putError) {
          reject(putError);
          return;
        }

        resolve();
      });
    });
  });
}

function quoteSqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function buildJsonRecordset(expression, columns) {
  return `jsonb_to_recordset(convert_from(decode('${encodePayload(expression)}', 'base64'), 'utf8')::jsonb) as x(${columns})`;
}

async function connectLocalDb() {
  const localEnv = loadEnvFile(localEnvPath, '.env');
  const localDbUrl = localEnv.DATABASE_URL?.trim();

  if (!localDbUrl) {
    fail('Error: DATABASE_URL must be defined in the local .env file');
  }

  const client = new PgClient({
    connectionString: localDbUrl,
  });

  await client.connect();
  return client;
}

async function fetchRows(client, query) {
  const { rows } = await client.query(query);
  return rows;
}

async function buildFixturesSql(client) {
  const fixtures = await fetchRows(
    client,
    `
      select
        id,
        slug,
        stage,
        kickoff_at,
        home_code,
        home_team,
        away_code,
        away_team,
        venue,
        host_city,
        highlight,
        created_at
      from fixtures
      order by kickoff_at asc, id asc
    `,
  );

  const fromFixtures = buildJsonRecordset(fixtures, `
    id uuid,
    slug text,
    stage text,
    kickoff_at timestamptz,
    home_code text,
    home_team text,
    away_code text,
    away_team text,
    venue text,
    host_city text,
    highlight text,
    created_at timestamptz
  `);

  return `
begin;

insert into fixtures (
  id,
  slug,
  stage,
  kickoff_at,
  home_code,
  home_team,
  away_code,
  away_team,
  venue,
  host_city,
  highlight,
  created_at
)
select
  id,
  slug,
  stage,
  kickoff_at,
  home_code,
  home_team,
  away_code,
  away_team,
  venue,
  host_city,
  highlight,
  created_at
from ${fromFixtures}
on conflict (id) do update
set slug = excluded.slug,
    stage = excluded.stage,
    kickoff_at = excluded.kickoff_at,
    home_code = excluded.home_code,
    home_team = excluded.home_team,
    away_code = excluded.away_code,
    away_team = excluded.away_team,
    venue = excluded.venue,
    host_city = excluded.host_city,
    highlight = excluded.highlight,
    created_at = excluded.created_at;

commit;
`;
}

async function buildCatalogSql(client) {
  const fixtures = await fetchRows(
    client,
    `
      select
        id,
        slug,
        stage,
        kickoff_at,
        home_code,
        home_team,
        away_code,
        away_team,
        venue,
        host_city,
        highlight,
        created_at
      from fixtures
      order by kickoff_at asc, id asc
    `,
  );

  const profiles = await fetchRows(
    client,
    `
      select
        id,
        auth_user_id,
        email,
        display_name,
        age,
        bio,
        neighborhood,
        city,
        vibe,
        favourite_teams,
        verified,
        rating,
        rating_count,
        wave_back_rate,
        host_wins,
        is_host,
        women_only,
        family_friendly,
        match_day_mode_fixture_id,
        setup,
        st_astext(geog::geometry) as geog_wkt,
        created_at,
        updated_at,
        avatar_path
      from profiles
      order by created_at asc, id asc
    `,
  );

  const listings = await fetchRows(
    client,
    `
      select
        id,
        slug,
        fixture_id,
        host_id,
        neighborhood,
        vibe,
        max_guests,
        approved_guests,
        extras,
        house_rules,
        join_message,
        price_note,
        is_open,
        st_astext(geog::geometry) as geog_wkt,
        created_at,
        updated_at
      from listings
      order by created_at asc, id asc
    `,
  );

  const fixturesRecordset = buildJsonRecordset(fixtures, `
    id uuid,
    slug text,
    stage text,
    kickoff_at timestamptz,
    home_code text,
    home_team text,
    away_code text,
    away_team text,
    venue text,
    host_city text,
    highlight text,
    created_at timestamptz
  `);

  const profilesRecordset = buildJsonRecordset(profiles, `
    id uuid,
    auth_user_id uuid,
    email text,
    display_name text,
    age integer,
    bio text,
    neighborhood text,
    city text,
    vibe text,
    favourite_teams text[],
    verified boolean,
    rating numeric,
    rating_count integer,
    wave_back_rate integer,
    host_wins integer,
    is_host boolean,
    women_only boolean,
    family_friendly boolean,
    match_day_mode_fixture_id uuid,
    setup jsonb,
    geog_wkt text,
    created_at timestamptz,
    updated_at timestamptz,
    avatar_path text
  `);

  const listingsRecordset = buildJsonRecordset(listings, `
    id uuid,
    slug text,
    fixture_id uuid,
    host_id uuid,
    neighborhood text,
    vibe text,
    max_guests integer,
    approved_guests integer,
    extras text[],
    house_rules text[],
    join_message text,
    price_note text,
    is_open boolean,
    geog_wkt text,
    created_at timestamptz,
    updated_at timestamptz
  `);

  return `
begin;

insert into fixtures (
  id,
  slug,
  stage,
  kickoff_at,
  home_code,
  home_team,
  away_code,
  away_team,
  venue,
  host_city,
  highlight,
  created_at
)
select
  id,
  slug,
  stage,
  kickoff_at,
  home_code,
  home_team,
  away_code,
  away_team,
  venue,
  host_city,
  highlight,
  created_at
from ${fixturesRecordset}
on conflict (id) do update
set slug = excluded.slug,
    stage = excluded.stage,
    kickoff_at = excluded.kickoff_at,
    home_code = excluded.home_code,
    home_team = excluded.home_team,
    away_code = excluded.away_code,
    away_team = excluded.away_team,
    venue = excluded.venue,
    host_city = excluded.host_city,
    highlight = excluded.highlight,
    created_at = excluded.created_at;

insert into profiles (
  id,
  auth_user_id,
  email,
  display_name,
  age,
  bio,
  neighborhood,
  city,
  vibe,
  favourite_teams,
  verified,
  rating,
  rating_count,
  wave_back_rate,
  host_wins,
  is_host,
  women_only,
  family_friendly,
  match_day_mode_fixture_id,
  setup,
  geog,
  created_at,
  updated_at,
  avatar_path
)
select
  id,
  auth_user_id,
  email,
  display_name,
  age,
  bio,
  neighborhood,
  city,
  vibe,
  favourite_teams,
  verified,
  rating,
  rating_count,
  wave_back_rate,
  host_wins,
  is_host,
  women_only,
  family_friendly,
  match_day_mode_fixture_id,
  setup,
  case when geog_wkt is null then null else st_geogfromtext(geog_wkt) end,
  created_at,
  updated_at,
  avatar_path
from ${profilesRecordset}
on conflict (id) do update
set auth_user_id = excluded.auth_user_id,
    email = excluded.email,
    display_name = excluded.display_name,
    age = excluded.age,
    bio = excluded.bio,
    neighborhood = excluded.neighborhood,
    city = excluded.city,
    vibe = excluded.vibe,
    favourite_teams = excluded.favourite_teams,
    verified = excluded.verified,
    rating = excluded.rating,
    rating_count = excluded.rating_count,
    wave_back_rate = excluded.wave_back_rate,
    host_wins = excluded.host_wins,
    is_host = excluded.is_host,
    women_only = excluded.women_only,
    family_friendly = excluded.family_friendly,
    match_day_mode_fixture_id = excluded.match_day_mode_fixture_id,
    setup = excluded.setup,
    geog = coalesce(excluded.geog, profiles.geog),
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    avatar_path = excluded.avatar_path;

insert into listings (
  id,
  slug,
  fixture_id,
  host_id,
  neighborhood,
  vibe,
  max_guests,
  approved_guests,
  extras,
  house_rules,
  join_message,
  price_note,
  is_open,
  geog,
  created_at,
  updated_at
)
select
  id,
  slug,
  fixture_id,
  host_id,
  neighborhood,
  vibe,
  max_guests,
  approved_guests,
  extras,
  house_rules,
  join_message,
  price_note,
  is_open,
  case when geog_wkt is null then null else st_geogfromtext(geog_wkt) end,
  created_at,
  updated_at
from ${listingsRecordset}
on conflict (id) do update
set slug = excluded.slug,
    fixture_id = excluded.fixture_id,
    host_id = excluded.host_id,
    neighborhood = excluded.neighborhood,
    vibe = excluded.vibe,
    max_guests = excluded.max_guests,
    approved_guests = excluded.approved_guests,
    extras = excluded.extras,
    house_rules = excluded.house_rules,
    join_message = excluded.join_message,
    price_note = excluded.price_note,
    is_open = excluded.is_open,
    geog = coalesce(excluded.geog, listings.geog),
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

commit;
`;
}

function detectLocalDockerDb() {
  try {
    const output = execSync(
      'docker ps --filter name=matchbuddy-postgis --format "{{.Names}}"',
      { stdio: 'pipe' },
    )
      .toString()
      .trim();

    return output.includes('matchbuddy-postgis');
  } catch {
    return false;
  }
}

function dumpLocalDatabase() {
  log('\n--- Step 1: Creating local database dump ---');

  try {
    if (detectLocalDockerDb()) {
      log('Detected local database running in Docker container: matchbuddy-postgis');
      const dumpCommand =
        `docker exec -i matchbuddy-postgis pg_dump -U postgres -d matchbuddy -F c -b -v > "${localDumpFile}"`;
      log(`Running: ${dumpCommand}`);
      execSync(dumpCommand);
    } else {
      const localEnv = loadEnvFile(localEnvPath, '.env');
      const localDbUrl = localEnv.DATABASE_URL?.trim();

      if (!localDbUrl) {
        fail('Error: DATABASE_URL is missing in .env');
      }

      const localDb = parseConnectionString(
        localDbUrl,
        'DATABASE_URL',
        readDbFallback(localEnv, 'POSTGRES'),
      );
      const dumpCommand = `PGPASSWORD="${localDb.pass}" pg_dump -h "${localDb.host}" -p "${localDb.port}" -U "${localDb.user}" -d "${localDb.name}" -F c -b -v -f "${localDumpFile}"`;
      log(`Running: pg_dump (host: ${localDb.host}:${localDb.port}, database: ${localDb.name})`);
      execSync(dumpCommand);
    }

    const stats = fs.statSync(localDumpFile);
    log(`Database dump created successfully! (${(stats.size / 1024 / 1024).toFixed(2)} MB)`, colors.success);
  } catch (error) {
    fail(`Failed to dump local database: ${error.message}`);
  }
}

async function buildSelectiveSyncSql(mode) {
  const client = await connectLocalDb();

  try {
    if (mode === 'fixtures') {
      const sql = await buildFixturesSql(client);
      const { rows } = await client.query('select count(*)::int as count from fixtures');
      return { sql, summary: `fixtures: ${rows[0].count}` };
    }

    if (mode === 'catalog') {
      const sql = await buildCatalogSql(client);
      const counts = await Promise.all([
        client.query('select count(*)::int as count from fixtures'),
        client.query('select count(*)::int as count from profiles'),
        client.query('select count(*)::int as count from listings'),
      ]);

      return {
        sql,
        summary: `fixtures: ${counts[0].rows[0].count}, profiles: ${counts[1].rows[0].count}, listings: ${counts[2].rows[0].count}`,
      };
    }

    fail(`Unsupported selective sync mode: ${mode}`);
  } finally {
    await client.end();
  }
}

async function runSelectiveSync(conn, deployEnv, remoteDb) {
  const { sql, summary } = await buildSelectiveSyncSql(options.mode);
  fs.writeFileSync(localSqlFile, sql, 'utf8');

  log(`\nPrepared selective sync payload (${summary}).`, colors.success);

  await uploadFile(conn, localSqlFile, remoteSqlFile);
  log('Selective sync SQL uploaded.', colors.success);

  if (deployEnv.REMOTE_DB_CONTAINER) {
    await executeRemoteCommand(
      conn,
      `docker exec -i ${deployEnv.REMOTE_DB_CONTAINER} psql -v ON_ERROR_STOP=1 -U ${quoteShell(remoteDb.user)} -d ${quoteShell(remoteDb.name)} < ${quoteShell(remoteSqlFile)}`,
    );
  } else {
    await executeRemoteCommand(
      conn,
      `PGPASSWORD=${quoteShell(remoteDb.pass)} psql -v ON_ERROR_STOP=1 -h ${quoteShell(remoteDb.host)} -p ${quoteShell(remoteDb.port)} -U ${quoteShell(remoteDb.user)} -d ${quoteShell(remoteDb.name)} -f ${quoteShell(remoteSqlFile)}`,
    );
  }
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runFullRestore(conn, deployEnv, remoteDb) {
  dumpLocalDatabase();

  log('\n--- Step 2: Uploading database dump to remote server ---');
  await uploadFile(conn, localDumpFile, remoteDumpFile);
  log('Upload complete.', colors.success);

  log('\n--- Step 3: Restoring database on remote server ---');

  if (deployEnv.REMOTE_DB_CONTAINER) {
    log(`Restoring database inside Docker container: ${deployEnv.REMOTE_DB_CONTAINER}`);

    try {
      await executeRemoteCommand(
        conn,
        `docker exec -i ${deployEnv.REMOTE_DB_CONTAINER} createdb -U ${quoteShell(remoteDb.user)} ${quoteShell(remoteDb.name)} 2>/dev/null || true`,
      );
    } catch {
      // Ignore create-db failures when the database already exists.
    }

    await executeRemoteCommand(
      conn,
      `docker exec -i ${deployEnv.REMOTE_DB_CONTAINER} pg_restore -U ${quoteShell(remoteDb.user)} -d ${quoteShell(remoteDb.name)} --clean --if-exists --no-owner --no-privileges < ${quoteShell(remoteDumpFile)}`,
    );
  } else {
    log('Restoring database on native host PostgreSQL...');

    try {
      await executeRemoteCommand(
        conn,
        `PGPASSWORD=${quoteShell(remoteDb.pass)} createdb -h ${quoteShell(remoteDb.host)} -p ${quoteShell(remoteDb.port)} -U ${quoteShell(remoteDb.user)} ${quoteShell(remoteDb.name)} 2>/dev/null || true`,
      );
    } catch {
      // Ignore create-db failures when the database already exists.
    }

    await executeRemoteCommand(
      conn,
      `PGPASSWORD=${quoteShell(remoteDb.pass)} pg_restore -h ${quoteShell(remoteDb.host)} -p ${quoteShell(remoteDb.port)} -U ${quoteShell(remoteDb.user)} -d ${quoteShell(remoteDb.name)} --clean --if-exists --no-owner --no-privileges < ${quoteShell(remoteDumpFile)}`,
    );
  }
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!['fixtures', 'catalog', 'full'].includes(options.mode)) {
  fail(`Unsupported sync mode "${options.mode}". Use fixtures, catalog, or full.`);
}

const deployEnv = loadEnvFile(deployEnvPath, '.env.deploy');

if (!deployEnv.DEPLOY_HOST) {
  fail('Error: DEPLOY_HOST must be defined in .env.deploy');
}

const remoteDbUrl = deployEnv.PROD_DATABASE_URL?.trim();

if (!remoteDbUrl) {
  fail('Error: PROD_DATABASE_URL must be defined in .env.deploy');
}

const remoteDb = parseConnectionString(
  remoteDbUrl,
  'PROD_DATABASE_URL',
  readDbFallback(deployEnv, 'PROD_POSTGRES'),
);
const sshConfig = buildSshConfig(deployEnv);
const conn = new SshClient();

conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
  if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
    finish([deployEnv.DEPLOY_PASSWORD]);
    return;
  }

  finish([]);
});

conn
  .on('ready', async () => {
    log(`\nSuccessfully connected to VPS (${sshConfig.host}:${sshConfig.port}) as ${sshConfig.username}`, colors.success);

    try {
      if (options.mode === 'full') {
        await runFullRestore(conn, deployEnv, remoteDb);
      } else {
        log(`\n--- Step 1: Building selective sync SQL (${options.mode}) ---`);
        await runSelectiveSync(conn, deployEnv, remoteDb);
      }

      log('\n=============================================', colors.success);
      log(`DATABASE SYNC COMPLETE (${options.mode.toUpperCase()})`, colors.success);
      log('=============================================\n', colors.success);
    } catch (error) {
      log(`\nDatabase sync failed: ${error.message}`, colors.error);
      process.exitCode = 1;
    } finally {
      try {
        fs.rmSync(localSqlFile, { force: true });
      } catch {
        // Ignore cleanup failures.
      }

      conn.end();
    }
  })
  .on('error', (error) => {
    fail(`SSH connection error: ${error.message}`);
  })
  .connect(sshConfig);
