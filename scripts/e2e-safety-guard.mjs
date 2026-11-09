const APPROVED_E2E_DATABASES = Object.freeze(['talentlens_scorecard_test']);
const APPROVED_E2E_S3_BUCKETS = Object.freeze(['talentlens-test-resumes']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_COMPOSE_TOPOLOGY_MARKER = 'docker-compose.prod-test';

const TOPOLOGY_CONFIG = Object.freeze({
  'local-isolated': Object.freeze({
    dbHosts: LOCAL_HOSTS,
    dbPort: '5433',
    mailpitHosts: LOCAL_HOSTS,
    mailpitPort: '8025',
    smtpHosts: LOCAL_HOSTS,
    smtpPort: '1025',
    s3Hosts: LOCAL_HOSTS,
    s3Port: '9090',
    appHosts: LOCAL_HOSTS,
    appPort: '8080',
    clamavHosts: LOCAL_HOSTS,
    clamavPort: '3310',
  }),
  'compose-isolated': Object.freeze({
    dbHosts: new Set(['postgres', '127.0.0.1', 'localhost']),
    dbPortByHost: Object.freeze({
      postgres: '5432',
      '127.0.0.1': '5433',
      localhost: '5433',
    }),
    mailpitHosts: new Set(['mailpit', '127.0.0.1', 'localhost']),
    mailpitPort: '8025',
    smtpHosts: new Set(['mailpit', '127.0.0.1', 'localhost']),
    smtpPort: '1025',
    s3Hosts: new Set(['s3mock', '127.0.0.1', 'localhost']),
    s3Port: '9090',
    appHosts: new Set(['web', 'localhost', '127.0.0.1']),
    appPort: '8080',
    clamavHosts: new Set(['clamav', '127.0.0.1', 'localhost']),
    clamavPort: '3310',
  }),
});

export class E2eSafetyError extends Error {
  /**
   * @param {string} category
   * @param {string} message
   */
  constructor(category, message) {
    super(`[E2E GUARD FAIL][${category}] ${message}`);
    this.name = 'E2eSafetyError';
    this.category = category;
  }
}

/**
 * Safely parse a URL without ever echoing credentials or full secret-bearing URLs.
 * @param {string | undefined} rawValue
 * @param {string} category
 * @param {string} fieldName
 */
function parseUrlSafe(rawValue, category, fieldName) {
  if (!rawValue || typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new E2eSafetyError(category, `${fieldName} is required and must not be empty.`);
  }
  try {
    return new URL(rawValue.trim());
  } catch {
    throw new E2eSafetyError(
      category,
      `${fieldName} is not a syntactically valid URL (value redacted).`,
    );
  }
}

/**
 * Validate environment variables positively identifying the isolated E2E test topology.
 * Never logs credentials or full URLs.
 *
 * @param {Record<string, string | undefined>} env
 */
export function validateE2eEnvironmentConfig(env) {
  const marker = env.TALENTLENS_E2E_ENV?.trim();
  if (!marker || !Object.prototype.hasOwnProperty.call(TOPOLOGY_CONFIG, marker)) {
    throw new E2eSafetyError(
      'environment-marker',
      'Missing or invalid TALENTLENS_E2E_ENV marker. Expected "local-isolated" or "compose-isolated".',
    );
  }

  if (marker === 'compose-isolated') {
    const composeMarker = env.TALENTLENS_E2E_TOPOLOGY?.trim();
    if (composeMarker !== ALLOWED_COMPOSE_TOPOLOGY_MARKER) {
      throw new E2eSafetyError(
        'environment-marker',
        `compose-isolated mode requires TALENTLENS_E2E_TOPOLOGY="${ALLOWED_COMPOSE_TOPOLOGY_MARKER}".`,
      );
    }
  }

  if (env.NODE_ENV !== 'test') {
    throw new E2eSafetyError(
      'environment-config',
      `NODE_ENV must be strictly "test" for E2E execution (received "${env.NODE_ENV ?? 'unset'}").`,
    );
  }

  if (env.ASSESSMENT_PROVIDER !== 'fake') {
    throw new E2eSafetyError(
      'environment-config',
      `ASSESSMENT_PROVIDER must be "fake" for deterministic isolated E2E runs (received "${env.ASSESSMENT_PROVIDER ?? 'unset'}").`,
    );
  }

  const topology = TOPOLOGY_CONFIG[marker];

  // 1. Database target safeguards
  const dbUrl = parseUrlSafe(env.DATABASE_URL, 'database', 'DATABASE_URL');
  if (dbUrl.protocol !== 'postgresql:' && dbUrl.protocol !== 'postgres:') {
    throw new E2eSafetyError(
      'database',
      `DATABASE_URL protocol must be postgresql: or postgres: (got "${dbUrl.protocol}").`,
    );
  }
  if (dbUrl.search || dbUrl.hash) {
    // Allow harmless standard options only if no conflicting schema/host ambiguity, reject suspicious overrides
    const schemaParam = dbUrl.searchParams.get('schema');
    if (schemaParam && schemaParam !== 'public') {
      throw new E2eSafetyError(
        'database',
        `DATABASE_URL schema override "${schemaParam}" is not allowed in E2E runs.`,
      );
    }
  }

  const dbHost = dbUrl.hostname.toLowerCase();
  if (!topology.dbHosts.has(dbHost)) {
    throw new E2eSafetyError(
      'database',
      `Refusing non-isolated PostgreSQL host "${dbHost}" for topology "${marker}".`,
    );
  }

  const expectedDbPort =
    marker === 'compose-isolated' ? topology.dbPortByHost[dbHost] : topology.dbPort;
  const dbPort = dbUrl.port || '5432';
  if (dbPort !== expectedDbPort) {
    throw new E2eSafetyError(
      'database',
      `Refusing PostgreSQL port "${dbPort}" for host "${dbHost}" in "${marker}" mode (expected port "${expectedDbPort}").`,
    );
  }

  const rawDbPath = dbUrl.pathname.replace(/^\/+/, '');
  if (!rawDbPath || rawDbPath.includes('/')) {
    throw new E2eSafetyError(
      'database',
      'DATABASE_URL must specify an explicit single database name.',
    );
  }
  if (!APPROVED_E2E_DATABASES.includes(rawDbPath)) {
    throw new E2eSafetyError(
      'database',
      `Refusing unapproved or protected database "${rawDbPath}". Approved E2E databases: ${APPROVED_E2E_DATABASES.join(', ')}.`,
    );
  }
  if (env.POSTGRES_DB && env.POSTGRES_DB.trim() !== rawDbPath) {
    throw new E2eSafetyError(
      'database',
      `POSTGRES_DB ("${env.POSTGRES_DB.trim()}") does not match DATABASE_URL database ("${rawDbPath}").`,
    );
  }

  // 2. Mailpit API & SMTP safeguards
  const mailpitUrl = parseUrlSafe(env.MAILPIT_URL, 'mailpit', 'MAILPIT_URL');
  if (mailpitUrl.protocol !== 'http:') {
    throw new E2eSafetyError(
      'mailpit',
      `MAILPIT_URL must use http: in isolated E2E mode (got "${mailpitUrl.protocol}").`,
    );
  }
  if (mailpitUrl.username || mailpitUrl.password) {
    throw new E2eSafetyError('mailpit', 'MAILPIT_URL must not carry credentials.');
  }
  if (mailpitUrl.pathname && mailpitUrl.pathname !== '/') {
    throw new E2eSafetyError('mailpit', 'MAILPIT_URL must be an origin without a custom path.');
  }
  const mailpitHost = mailpitUrl.hostname.toLowerCase();
  if (!topology.mailpitHosts.has(mailpitHost)) {
    throw new E2eSafetyError(
      'mailpit',
      `Refusing non-isolated Mailpit host "${mailpitHost}" for topology "${marker}".`,
    );
  }
  if ((mailpitUrl.port || '80') !== topology.mailpitPort) {
    throw new E2eSafetyError(
      'mailpit',
      `Refusing Mailpit port "${mailpitUrl.port || 'default'}" (expected "${topology.mailpitPort}").`,
    );
  }

  const smtpHost = env.SMTP_HOST?.trim().toLowerCase();
  if (!smtpHost || !topology.smtpHosts.has(smtpHost)) {
    throw new E2eSafetyError(
      'smtp',
      `Refusing non-isolated SMTP_HOST "${smtpHost || 'unset'}" for topology "${marker}".`,
    );
  }
  const smtpPort = env.SMTP_PORT?.trim();
  if (smtpPort !== topology.smtpPort) {
    throw new E2eSafetyError(
      'smtp',
      `Refusing SMTP_PORT "${smtpPort ?? 'unset'}" (expected Mailpit SMTP port "${topology.smtpPort}").`,
    );
  }
  if (env.SMTP_USER?.trim() || env.SMTP_PASS?.trim()) {
    throw new E2eSafetyError(
      'smtp',
      'SMTP_USER and SMTP_PASS must be unset in isolated E2E Mailpit mode to prevent real MTA relay.',
    );
  }
  if (env.SMTP_REQUIRE_TLS !== 'false') {
    throw new E2eSafetyError(
      'smtp',
      `SMTP_REQUIRE_TLS must be "false" for local Mailpit testing (received "${env.SMTP_REQUIRE_TLS ?? 'unset'}").`,
    );
  }

  // 3. S3 Object Storage safeguards
  if (env.STORAGE_DRIVER !== 's3') {
    throw new E2eSafetyError(
      'storage',
      `STORAGE_DRIVER must be "s3" for E2E verification (received "${env.STORAGE_DRIVER ?? 'unset'}").`,
    );
  }
  if (env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === 'true') {
    throw new E2eSafetyError('storage', 'ALLOW_LOCAL_STORAGE_IN_PRODUCTION must not be "true".');
  }
  const s3Bucket = env.S3_BUCKET?.trim();
  if (!s3Bucket || !APPROVED_E2E_S3_BUCKETS.includes(s3Bucket)) {
    throw new E2eSafetyError(
      'storage',
      `Refusing unapproved S3_BUCKET "${s3Bucket ?? 'unset'}". Expected: ${APPROVED_E2E_S3_BUCKETS.join(', ')}.`,
    );
  }
  if (env.S3_FORCE_PATH_STYLE !== 'true') {
    throw new E2eSafetyError('storage', 'S3_FORCE_PATH_STYLE must be "true" for S3Mock.');
  }
  const s3Url = parseUrlSafe(env.S3_ENDPOINT, 'storage', 'S3_ENDPOINT');
  if (s3Url.protocol !== 'http:') {
    throw new E2eSafetyError(
      'storage',
      `S3_ENDPOINT must use http: in isolated S3Mock mode (got "${s3Url.protocol}").`,
    );
  }
  const s3Host = s3Url.hostname.toLowerCase();
  if (!topology.s3Hosts.has(s3Host)) {
    throw new E2eSafetyError(
      'storage',
      `Refusing non-isolated S3_ENDPOINT host "${s3Host}" for topology "${marker}".`,
    );
  }
  if ((s3Url.port || '80') !== topology.s3Port) {
    throw new E2eSafetyError(
      'storage',
      `Refusing S3_ENDPOINT port "${s3Url.port || 'default'}" (expected "${topology.s3Port}").`,
    );
  }

  // 4. ClamAV safeguards
  if (env.SCANNER_DRIVER !== 'clamav') {
    throw new E2eSafetyError(
      'scanner',
      `SCANNER_DRIVER must be "clamav" (received "${env.SCANNER_DRIVER ?? 'unset'}").`,
    );
  }
  const clamavHost = env.CLAMAV_HOST?.trim().toLowerCase();
  if (!clamavHost || !topology.clamavHosts.has(clamavHost)) {
    throw new E2eSafetyError(
      'scanner',
      `Refusing non-isolated CLAMAV_HOST "${clamavHost || 'unset'}" for topology "${marker}".`,
    );
  }
  if (env.CLAMAV_PORT?.trim() !== topology.clamavPort) {
    throw new E2eSafetyError(
      'scanner',
      `Refusing CLAMAV_PORT "${env.CLAMAV_PORT ?? 'unset'}" (expected "${topology.clamavPort}").`,
    );
  }

  // 5. Application / API ingress safeguards
  const appOriginUrl = parseUrlSafe(env.APP_ORIGIN, 'app-origin', 'APP_ORIGIN');
  if (appOriginUrl.protocol !== 'http:') {
    throw new E2eSafetyError(
      'app-origin',
      `APP_ORIGIN must use http: in isolated E2E mode (got "${appOriginUrl.protocol}").`,
    );
  }
  if (appOriginUrl.pathname && appOriginUrl.pathname !== '/') {
    throw new E2eSafetyError('app-origin', 'APP_ORIGIN must not include a path suffix.');
  }
  const appHost = appOriginUrl.hostname.toLowerCase();
  if (!topology.appHosts.has(appHost)) {
    throw new E2eSafetyError(
      'app-origin',
      `Refusing non-isolated APP_ORIGIN host "${appHost}" for topology "${marker}".`,
    );
  }
  if ((appOriginUrl.port || '80') !== topology.appPort) {
    throw new E2eSafetyError(
      'app-origin',
      `Refusing APP_ORIGIN port "${appOriginUrl.port || 'default'}" (expected "${topology.appPort}").`,
    );
  }

  return Object.freeze({
    marker,
    database: {
      host: dbHost,
      port: dbPort,
      name: rawDbPath,
    },
    mailpitOrigin: `${mailpitUrl.protocol}//${mailpitHost}:${topology.mailpitPort}`,
    smtp: {
      host: smtpHost,
      port: smtpPort,
    },
    s3: {
      origin: `${s3Url.protocol}//${s3Host}:${topology.s3Port}`,
      bucket: s3Bucket,
    },
    clamav: {
      host: clamavHost,
      port: topology.clamavPort,
    },
    appOrigin: `${appOriginUrl.protocol}//${appHost}:${topology.appPort}`,
  });
}

/**
 * Default read-only PostgreSQL identity probe using Prisma's read-only $queryRawUnsafe.
 * Only executes SELECT current_database(), to_regclass('public._prisma_migrations').
 */
async function defaultProbeDatabaseIdentity(expectedDbName) {
  const { getDatabaseClient } = await import('@talentlens/database');
  const db = getDatabaseClient();
  const rows = await db.$queryRawUnsafe(
    `SELECT current_database() AS database_name, to_regclass('public._prisma_migrations')::text AS migrations_table`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || row.database_name !== expectedDbName) {
    throw new E2eSafetyError(
      'database-identity',
      `Connected PostgreSQL database mismatch: expected "${expectedDbName}", server reported "${row?.database_name ?? 'unknown'}".`,
    );
  }
  if (!row.migrations_table) {
    throw new E2eSafetyError(
      'database-identity',
      `Target database "${expectedDbName}" does not have "_prisma_migrations" initialized.`,
    );
  }
  return {
    databaseName: row.database_name,
    migrationsTable: row.migrations_table,
  };
}

/**
 * Default harmless GET probe confirming Mailpit API readiness without mutating messages.
 * @param {string} mailpitOrigin
 */
async function defaultProbeMailpit(mailpitOrigin) {
  let response;
  try {
    response = await fetch(`${mailpitOrigin}/api/v1/info`);
  } catch (error) {
    throw new E2eSafetyError(
      'mailpit-readiness',
      `Unable to reach Mailpit at ${mailpitOrigin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new E2eSafetyError(
      'mailpit-readiness',
      `Mailpit readiness probe returned HTTP ${response.status} from ${mailpitOrigin}.`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new E2eSafetyError(
      'mailpit-readiness',
      `Endpoint at ${mailpitOrigin}/api/v1/info did not return valid Mailpit JSON.`,
    );
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.Version !== 'string' ||
    typeof payload.RuntimeStats !== 'object'
  ) {
    throw new E2eSafetyError(
      'mailpit-readiness',
      `Target at ${mailpitOrigin} did not identify itself as a Mailpit server.`,
    );
  }
  return { version: payload.Version };
}

/**
 * Execute full E2E safety guard before any setup, cleanup, seed, delete, email, or browser action.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(expectedDbName: string, config: ReturnType<typeof validateE2eEnvironmentConfig>) => Promise<{databaseName: string; migrationsTable?: string}>} [options.probeDatabaseIdentity]
 * @param {(mailpitOrigin: string, config: ReturnType<typeof validateE2eEnvironmentConfig>) => Promise<{version: string}>} [options.probeMailpit]
 */
export async function assertSafeE2eEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const validated = validateE2eEnvironmentConfig(env);

  const probeDb = options.probeDatabaseIdentity ?? defaultProbeDatabaseIdentity;
  const dbIdentity = await probeDb(validated.database.name, validated);
  if (!dbIdentity || dbIdentity.databaseName !== validated.database.name) {
    throw new E2eSafetyError(
      'database-identity',
      `Read-only identity verification failed for database "${validated.database.name}".`,
    );
  }

  const probeMailpit = options.probeMailpit ?? defaultProbeMailpit;
  const mailpitIdentity = await probeMailpit(validated.mailpitOrigin, validated);

  return Object.freeze({
    ...validated,
    verifiedDatabase: dbIdentity.databaseName,
    verifiedMailpitVersion: mailpitIdentity?.version ?? 'verified',
  });
}
