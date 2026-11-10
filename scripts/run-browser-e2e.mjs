/* global document, getComputedStyle, window */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { assertSafeE2eEnvironment, validateE2eEnvironmentConfig } from './e2e-safety-guard.mjs';

const e2eMarker = process.env.TALENTLENS_E2E_ENV?.trim();
if (e2eMarker === 'local-isolated') {
  // Populate only missing defaults aligned with docker-compose.prod-test.yml;
  // never overwrite caller-supplied variables so invalid/production overrides are caught.
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??=
    'postgresql://talentlens:talentlens_local_only@127.0.0.1:5433/talentlens_scorecard_test';
  process.env.STORAGE_DRIVER ??= 's3';
  process.env.S3_BUCKET ??= 'talentlens-test-resumes';
  process.env.S3_ENDPOINT ??= 'http://127.0.0.1:9090';
  process.env.S3_REGION ??= 'us-east-1';
  process.env.S3_ACCESS_KEY_ID ??= 'test-key';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.S3_FORCE_PATH_STYLE ??= 'true';
  process.env.SCANNER_DRIVER ??= 'clamav';
  process.env.CLAMAV_HOST ??= '127.0.0.1';
  process.env.CLAMAV_PORT ??= '3310';
  process.env.SMTP_HOST ??= '127.0.0.1';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_REQUIRE_TLS ??= 'false';
  process.env.EMAIL_FROM ??= 'no-reply@talentlens.ai';
  process.env.APP_ORIGIN ??= 'http://localhost:8080';
  process.env.CONSENT_APPROVED_POLICY_VERSIONS ??= '2026-11-v1';
  process.env.ASSESSMENT_PROVIDER ??= 'fake';
  process.env.MAILPIT_URL ??= 'http://127.0.0.1:8025';
}

// Fail closed before loading database client or performing any destructive setup
const preflightConfig = validateE2eEnvironmentConfig(process.env);
const MAILPIT_URL = preflightConfig.mailpitOrigin;
const APP_ORIGIN = preflightConfig.appOrigin;
const S3_ENDPOINT = preflightConfig.s3.origin;
const S3_BUCKET = preflightConfig.s3.bucket;
const CLAMAV_HOST = preflightConfig.clamav.host;
const CLAMAV_PORT = Number(preflightConfig.clamav.port);

const { chromium } = await import('@playwright/test');
const { getDatabaseClient, disconnectDatabase } = await import('@talentlens/database');
const { hashPassword } = await import('../apps/api/dist/modules/auth/password.service.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function resolveArtifactDir(baseDir) {
  const override = process.env.TALENTLENS_ARTIFACT_DIR?.trim();
  const targetDir = override
    ? path.resolve(process.cwd(), override)
    : path.join(baseDir, 'artifacts', 'e2e');
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

function resolveBrowserExecutablePath(chromiumLauncher) {
  const override = process.env.CHROME_EXECUTABLE_PATH?.trim();
  if (override) {
    const resolvedOverride = path.resolve(process.cwd(), override);
    if (!fs.existsSync(resolvedOverride)) {
      throw new Error(
        `Configured CHROME_EXECUTABLE_PATH does not exist: ${resolvedOverride}. Provide a valid Chrome/Chromium binary path or unset CHROME_EXECUTABLE_PATH.`,
      );
    }
    return resolvedOverride;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES;
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const localAppData = process.env.LOCALAPPDATA;
    if (pf) {
      candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(pf, 'Chromium', 'Application', 'chrome.exe'));
      candidates.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (pf86) {
      candidates.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents/MacOS/Google Chrome'),
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }

  try {
    const playwrightBinary = chromiumLauncher.executablePath?.();
    if (playwrightBinary) {
      candidates.push(playwrightBinary);
    }
  } catch {
    // Playwright-managed browser may not be installed; continue probing OS paths.
  }

  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      'No supported Chrome or Chromium executable was found for Playwright. Install Playwright Chromium (`npx playwright install chromium`) or set CHROME_EXECUTABLE_PATH to a valid browser binary.',
    );
  }
  return found;
}

const artifactsDir = resolveArtifactDir(rootDir);

function log(step, msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`\x1b[36m[${ts}]\x1b[0m \x1b[32m[Step ${step}]\x1b[0m ${msg}`);
}

function logError(step, msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.error(`\x1b[36m[${ts}]\x1b[0m \x1b[31m[Step ${step} ERROR]\x1b[0m ${msg}`);
}

function createMinimalPdf(text) {
  const parts = ['%PDF-1.4'];
  const streamContent = `BT\n/F1 12 Tf\n(${text}) Tj\nET`;
  const streamDeflated = zlib.deflateSync(Buffer.from(streamContent, 'utf8'));
  parts.push(
    '3 0 obj << /Type /Pages /Kids [4 0 R] /Count 1 >> endobj',
    '4 0 obj << /Type /Page /Parent 3 0 R /Contents 5 0 R >> endobj',
    `5 0 obj << /Length ${streamDeflated.length} /Filter /FlateDecode >> stream\n`,
  );
  const prefix = Buffer.from(parts.join('\n'), 'latin1');
  const suffix = Buffer.from('\nendstream\nendobj\ntrailer << /Root 3 0 R >>\n%%EOF', 'latin1');
  return Buffer.concat([prefix, streamDeflated, suffix]);
}

function createMinimalDocx(xmlBody) {
  const xmlContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${xmlBody}</w:body>
</w:document>`;
  const deflatedXml = zlib.deflateRawSync(Buffer.from(xmlContent, 'utf8'));
  const filename = Buffer.from('word/document.xml', 'utf8');

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(deflatedXml.length, 18);
  header.writeUInt32LE(Buffer.byteLength(xmlContent), 22);
  header.writeUInt16LE(filename.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, filename, deflatedXml]);
}

async function waitForServer(url, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200 || res.status === 304) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timeout waiting for server at ${url} after ${timeoutMs}ms`);
}

async function waitForClamAv(host = '127.0.0.1', port = 3310, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pong = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      let response = '';
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
      socket.on('connect', () => {
        socket.write('zPING\0');
      });
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (response.includes('PONG')) {
          clearTimeout(timer);
          socket.end();
          resolve(true);
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
    });
    if (pong) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timeout waiting for ClamAV daemon at ${host}:${port} after ${timeoutMs}ms`);
}

async function clearMailpit() {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear Mailpit mailbox: HTTP ${res.status}`);
  }
}

async function waitForMailpitToken({ toEmail, subjectIncludes, urlPath, timeoutMs = 45000 }) {
  const escapedPath = urlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRegex = new RegExp(`${escapedPath}#token=([0-9a-f]+)`, 'i');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const listRes = await fetch(`${MAILPIT_URL}/api/v1/messages`);
      if (listRes.ok) {
        const listJson = await listRes.json();
        const messages = Array.isArray(listJson.messages) ? listJson.messages : [];
        const matching = messages.filter((msg) => {
          const recipients = Array.isArray(msg.To) ? msg.To : [];
          const hasRecipient = recipients.some(
            (r) =>
              typeof r.Address === 'string' && r.Address.toLowerCase() === toEmail.toLowerCase(),
          );
          const subjectMatches =
            !subjectIncludes ||
            (typeof msg.Subject === 'string' && msg.Subject.includes(subjectIncludes));
          return hasRecipient && subjectMatches;
        });

        for (const msg of matching) {
          const detailRes = await fetch(
            `${MAILPIT_URL}/api/v1/message/${encodeURIComponent(msg.ID)}`,
          );
          if (!detailRes.ok) continue;
          const detail = await detailRes.json();
          const haystack = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`;
          const match = tokenRegex.exec(haystack);
          if (match && match[1]) {
            return match[1];
          }
        }
      }
    } catch {
      // Retry until timeout
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Timeout waiting for Mailpit email to "${toEmail}" (subject: "${subjectIncludes ?? '*'}") containing ${urlPath}#token=...`,
  );
}

async function countMailpitMessages({ toEmail, subjectIncludes }) {
  try {
    const listRes = await fetch(`${MAILPIT_URL}/api/v1/messages`);
    if (!listRes.ok) return 0;
    const listJson = await listRes.json();
    const messages = Array.isArray(listJson.messages) ? listJson.messages : [];
    return messages.filter((msg) => {
      const recipients = Array.isArray(msg.To) ? msg.To : [];
      const hasRecipient = recipients.some(
        (r) => typeof r.Address === 'string' && r.Address.toLowerCase() === toEmail.toLowerCase(),
      );
      const subjectMatches =
        !subjectIncludes ||
        (typeof msg.Subject === 'string' && msg.Subject.includes(subjectIncludes));
      return hasRecipient && subjectMatches;
    }).length;
  } catch {
    return 0;
  }
}

async function waitForMailpitMessage({
  toEmail,
  subjectIncludes,
  textIncludes,
  minCount = 1,
  timeoutMs = 45000,
}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const listRes = await fetch(`${MAILPIT_URL}/api/v1/messages`);
      if (listRes.ok) {
        const listJson = await listRes.json();
        const messages = Array.isArray(listJson.messages) ? listJson.messages : [];
        const matching = messages.filter((msg) => {
          const recipients = Array.isArray(msg.To) ? msg.To : [];
          const hasRecipient = recipients.some(
            (r) =>
              typeof r.Address === 'string' && r.Address.toLowerCase() === toEmail.toLowerCase(),
          );
          const subjectMatches =
            !subjectIncludes ||
            (typeof msg.Subject === 'string' && msg.Subject.includes(subjectIncludes));
          return hasRecipient && subjectMatches;
        });

        const matchedDetails = [];
        for (const msg of matching) {
          if (!textIncludes) {
            matchedDetails.push(msg);
            continue;
          }
          const detailRes = await fetch(
            `${MAILPIT_URL}/api/v1/message/${encodeURIComponent(msg.ID)}`,
          );
          if (!detailRes.ok) continue;
          const detail = await detailRes.json();
          const haystack = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`;
          if (haystack.includes(textIncludes)) {
            matchedDetails.push(detail);
          }
        }

        if (matchedDetails.length >= minCount) {
          return { count: matchedDetails.length, latest: matchedDetails[0] };
        }
      }
    } catch {
      // Retry until timeout
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Timeout waiting for Mailpit email to "${toEmail}" (subject: "${subjectIncludes ?? '*'}", minCount: ${minCount}${textIncludes ? `, text: "${textIncludes}"` : ''})`,
  );
}

async function getJsonViaPage(page, apiPath) {
  return page.evaluate(async (targetPath) => {
    const res = await fetch(`/api/v1${targetPath}`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json };
  }, apiPath);
}

async function apiRequestWithCsrf(page, method, apiPath, body) {
  return page.evaluate(
    async ({ reqMethod, targetPath, payload }) => {
      const csrfRes = await fetch('/api/v1/auth/csrf', {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (!csrfRes.ok) {
        return {
          status: csrfRes.status,
          ok: false,
          json: { error: 'csrf_fetch_failed' },
        };
      }
      const csrfData = await csrfRes.json();
      const headers = {
        'x-csrf-token': csrfData.csrfToken,
      };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`/api/v1${targetPath}`, {
        method: reqMethod,
        credentials: 'same-origin',
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, ok: res.ok, json };
    },
    { reqMethod: method, targetPath: apiPath, payload: body },
  );
}

async function waitForCondition(fn, description, timeoutMs = 45000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

async function assertResponsiveInterviewPage(
  page,
  expectedViewTestId,
  hiddenViewTestId,
  screenshotPath,
) {
  await page.waitForSelector(`[data-testid="${expectedViewTestId}"]`, {
    state: 'visible',
    timeout: 15000,
  });
  await page.waitForSelector(`[data-testid="${expectedViewTestId}"] button:has-text("Accept")`, {
    state: 'visible',
    timeout: 10000,
  });

  const layoutCheck = await page.evaluate(
    ({ expectedId, hiddenId }) => {
      const expectedEl = document.querySelector(`[data-testid="${expectedId}"]`);
      const hiddenEl = document.querySelector(`[data-testid="${hiddenId}"]`);
      const expectedVisible =
        expectedEl !== null && getComputedStyle(expectedEl).display !== 'none';
      const hiddenIsHidden = hiddenEl === null || getComputedStyle(hiddenEl).display === 'none';

      const docOverflow =
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;

      const actionButtons = Array.from(expectedEl?.querySelectorAll('button') ?? []).map((btn) => {
        const rect = btn.getBoundingClientRect();
        return {
          text: btn.textContent?.trim() ?? '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          clipped: rect.right > window.innerWidth + 1 || rect.left < -1,
        };
      });

      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        expectedVisible,
        hiddenIsHidden,
        docOverflow,
        actionButtons,
      };
    },
    { expectedId: expectedViewTestId, hiddenId: hiddenViewTestId },
  );

  if (!layoutCheck.expectedVisible || !layoutCheck.hiddenIsHidden) {
    throw new Error(
      `Interview responsive view mismatch at width ${layoutCheck.innerWidth}: ${JSON.stringify(layoutCheck)}`,
    );
  }
  if (layoutCheck.docOverflow) {
    throw new Error(
      `Horizontal overflow detected on /interviews at width ${layoutCheck.innerWidth}: scrollWidth=${layoutCheck.scrollWidth}, clientWidth=${layoutCheck.clientWidth}`,
    );
  }
  const clippedBtn = layoutCheck.actionButtons.find((b) => b.clipped);
  if (clippedBtn) {
    throw new Error(
      `Action button clipped on /interviews at width ${layoutCheck.innerWidth}: ${JSON.stringify(clippedBtn)}`,
    );
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });
}

async function run() {
  log('INIT', 'Validating isolated E2E environment safety guard...');
  const safeTarget = await assertSafeE2eEnvironment({ env: process.env });
  log(
    'INIT',
    `E2E guard verified isolated targets: db=${safeTarget.verifiedDatabase}@${safeTarget.database.host}:${safeTarget.database.port}, mailpit=${safeTarget.mailpitOrigin} (${safeTarget.verifiedMailpitVersion}), s3=${safeTarget.s3.origin}/${safeTarget.s3.bucket}, origin=${safeTarget.appOrigin}`,
  );

  log('INIT', 'Starting TalentLens AI Phase C Production Container Topology Browser E2E...');

  const db = getDatabaseClient();

  // Ensure S3Mock bucket exists cleanly once container boots
  await waitForCondition(
    async () => {
      try {
        const s3Check = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}`, {
          method: 'HEAD',
        });
        if (s3Check.status === 404) {
          const putRes = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}`, {
            method: 'PUT',
          });
          if (putRes.ok || putRes.status === 200 || putRes.status === 409) {
            log('INIT', `Created S3Mock test bucket "${S3_BUCKET}"`);
            return true;
          }
          return false;
        }
        return s3Check.ok || s3Check.status === 200;
      } catch {
        return false;
      }
    },
    'S3Mock bucket readiness',
    45000,
    1000,
  );

  // 1. Verify Production Topology: Nginx web container, API proxy, ClamAV, and Mailpit
  log(1, 'Verifying production Nginx web container, API proxy, ClamAV, and Mailpit readiness...');
  await waitForServer(`${APP_ORIGIN}/`, 25000);
  await waitForServer(`${APP_ORIGIN}/api/v1/health/ready`, 25000);
  await waitForClamAv(CLAMAV_HOST, CLAMAV_PORT, 90000);
  await waitForServer(`${MAILPIT_URL}/api/v1/messages`, 25000);
  await clearMailpit();
  log(
    1,
    `Verified: Nginx (${APP_ORIGIN}), API (/api/v1/health/ready), ClamAV (${CLAMAV_HOST}:${CLAMAV_PORT} PONG), and cleared Mailpit (${MAILPIT_URL}).`,
  );

  // 2. Bootstrap primary tenant and users in database
  const runId = Date.now().toString(36);
  const orgName = `Acme Enterprise ${runId}`;
  const normalizedOrgName = orgName.toLowerCase();
  const recruiterEmail = `recruiter.${runId}@acme.com`;
  const normalizedRecruiterEmail = recruiterEmail.toLowerCase();
  const recruiterPassword = 'RecruiterPassword123!';
  const recruiterPasswordHash = await hashPassword(recruiterPassword);

  log(2, `Bootstrapping primary tenant: ${orgName} (${recruiterEmail})`);
  const org = await db.organization.create({
    data: {
      name: orgName,
      normalizedName: normalizedOrgName,
    },
  });

  await db.user.create({
    data: {
      organizationId: org.id,
      email: recruiterEmail,
      normalizedEmail: normalizedRecruiterEmail,
      passwordHash: recruiterPasswordHash,
      role: 'RECRUITER',
      status: 'ACTIVE',
    },
  });

  const clientManagerEmail = `manager.${runId}@initech.com`;
  const clientManagerPassword = 'ClientPassword123!';
  const clientManagerHash = await hashPassword(clientManagerPassword);

  const clientUser = await db.user.create({
    data: {
      organizationId: org.id,
      email: clientManagerEmail,
      normalizedEmail: clientManagerEmail.toLowerCase(),
      passwordHash: clientManagerHash,
      role: 'CLIENT_HIRING_MANAGER',
      status: 'ACTIVE',
    },
  });

  // Second tenant for cross-tenant isolation testing
  const tenant2Name = `Beta Systems ${runId}`;
  const tenant2RecruiterEmail = `recruiter.${runId}@beta.com`;
  const tenant2Password = 'BetaPassword123!';
  const tenant2Hash = await hashPassword(tenant2Password);

  const org2 = await db.organization.create({
    data: {
      name: tenant2Name,
      normalizedName: tenant2Name.toLowerCase(),
    },
  });

  await db.user.create({
    data: {
      organizationId: org2.id,
      email: tenant2RecruiterEmail,
      normalizedEmail: tenant2RecruiterEmail.toLowerCase(),
      passwordHash: tenant2Hash,
      role: 'RECRUITER',
      status: 'ACTIVE',
    },
  });

  log(2, 'Database tenant seeds completed.');

  // 3. Launch Playwright Chrome/Chromium
  const executablePath = resolveBrowserExecutablePath(chromium);
  log(3, `Launching Playwright browser (${executablePath})...`);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  let e2eSuccess = false;
  const tempPdfPath = path.join(rootDir, 'temp-alex-mercer-resume.pdf');
  const tempDocxPath = path.join(rootDir, 'temp-sarah-connor-resume.docx');

  try {
    const recruiterContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await recruiterContext.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error(`[BROWSER CONSOLE ERROR] ${msg.text()}`);
      }
    });

    // STEP 4: Recruiter Login
    log(4, `Navigating to Login page on production Nginx container (${APP_ORIGIN}/login)...`);
    await page.goto(`${APP_ORIGIN}/login`);
    await page.waitForSelector('form');

    log(4, 'Submitting recruiter login credentials...');
    await page.fill('input[name="organization"]', orgName);
    await page.fill('input[name="email"]', recruiterEmail);
    await page.fill('input[name="password"]', recruiterPassword);
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard', { timeout: 10000 });
    await page.waitForSelector('text=Dashboard', { timeout: 5000 });
    log(4, 'Recruiter successfully logged in and landed on Dashboard.');
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-01-recruiter-dashboard.png'),
      fullPage: true,
    });

    // STEP 5: Client Management — Create Client
    log(5, 'Navigating to Clients page...');
    await page.goto(`${APP_ORIGIN}/clients`);
    await page.waitForSelector('text=Add client');
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-02-clients-page.png'),
      fullPage: true,
    });

    log(5, 'Opening Add Client modal...');
    await page.click('button:has-text("Add client")');
    await page.waitForSelector('input[name="name"]');

    const clientName = `Initech Systems ${runId}`;
    log(5, `Creating client: ${clientName}`);
    await page.fill('input[name="name"]', clientName);
    await page.click('dialog button[type="submit"]');

    await page.waitForSelector(`text=${clientName}`, { timeout: 8000 });
    log(5, `Client "${clientName}" confirmed in directory.`);
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-03-client-created.png'),
      fullPage: true,
    });

    const clientRecord = await db.client.findFirst({
      where: { organizationId: org.id, name: clientName },
    });
    if (!clientRecord) throw new Error('Client record not found in database');

    await db.clientMembership.create({
      data: {
        organizationId: org.id,
        clientId: clientRecord.id,
        userId: clientUser.id,
        role: 'CLIENT_HIRING_MANAGER',
        status: 'ACTIVE',
      },
    });

    // STEP 6: Requisition Management — Create Requisition
    log(6, 'Navigating to Requisitions page...');
    await page.goto(`${APP_ORIGIN}/requisitions`);
    await page.waitForSelector('text=Create requisition');

    log(6, 'Opening Create Requisition modal...');
    await page.click('button:has-text("Create requisition")');
    await page.waitForSelector('input[name="title"]');

    const reqTitle = `Lead Cloud Architect ${runId}`;
    const jdText = `We are seeking an experienced Lead Cloud Architect with deep expertise in TypeScript, Node.js microservices, PostgreSQL database performance tuning, and AWS/OCI cloud architecture. Must have at least 8 years of software engineering experience and proven leadership of distributed systems.`;

    log(6, `Filling requisition: ${reqTitle}`);
    await page.selectOption('select', clientRecord.id);
    await page.fill('input[name="title"]', reqTitle);
    await page.fill('textarea', jdText);
    await page.click('dialog button[type="submit"]');

    await page.waitForSelector(`text=${reqTitle}`, { timeout: 10000 });
    log(6, `Requisition "${reqTitle}" created in directory. Navigating to detail page...`);
    await page.click(`text=${reqTitle}`);

    await page.waitForURL(/\/requisitions\/[0-9a-f-]+/, { timeout: 10000 });
    log(6, `Requisition detail page loaded: ${reqTitle}`);
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-04-requisition-detail.png'),
      fullPage: true,
    });

    const reqUrl = page.url();
    const reqIdMatch = reqUrl.match(/\/requisitions\/([0-9a-f-]+)/);
    const requisitionId = reqIdMatch[1];

    // STEP 7: Scorecard Management — Create & Approve Scorecard
    log(7, 'Navigating to Scorecards for requisition...');
    await page.click('button:has-text("Scorecards")');
    await page.waitForURL(new RegExp(`/requisitions/${requisitionId}/scorecards`));
    await page.waitForSelector('text=Scorecard Workspace');

    log(7, 'Opening Scorecard Creation modal...');
    await page.click(
      'button:has-text("Create first scorecard"), button:has-text("Create scorecard version")',
    );
    await page.waitForSelector('text=Manual Draft');

    await page.click('text=Manual Draft');
    await page.click('button:has-text("Create empty draft")');

    await page.waitForURL(/\/scorecards\/[0-9a-f-]+/, { timeout: 10000 });
    log(7, 'Scorecard draft created. Adding verified screening criteria...');

    // Add Criterion 1 (50% weight)
    await page.click('button:has-text("Add criterion"), button:has-text("Add requirement")');
    await page.waitForSelector('input[placeholder*="Distributed Systems"]');
    await page.fill(
      'input[placeholder*="Distributed Systems"]',
      'TypeScript & Node.js Microservices',
    );
    await page.fill('input[type="number"]', '50');
    await page.fill(
      'textarea[placeholder*="backend architectures"]',
      'deep expertise in TypeScript, Node.js microservices',
    );
    await page.click('dialog button[type="submit"]');
    await page.waitForTimeout(600);

    // Add Criterion 2 (50% weight)
    await page.click('button:has-text("Add criterion"), button:has-text("Add requirement")');
    await page.waitForSelector('input[placeholder*="Distributed Systems"]');
    await page.fill('input[placeholder*="Distributed Systems"]', 'PostgreSQL Database Tuning');
    await page.fill('input[type="number"]', '50');
    await page.fill(
      'textarea[placeholder*="backend architectures"]',
      'PostgreSQL database performance tuning',
    );
    await page.click('dialog button[type="submit"]');
    await page.waitForTimeout(600);

    // Verify source quotes against JD
    const verifyButtons = await page.$$('button:has-text("Verify source quote")');
    for (const btn of verifyButtons) {
      await btn.click();
      await page.waitForTimeout(400);
    }

    log(7, 'Saving and approving scorecard version...');
    await page.click('button:has-text("Save draft")');
    await page.waitForTimeout(1000);

    await page.click('button:has-text("Approve scorecard")');
    await page.waitForSelector('button:has-text("Approve and Lock Version 1")');
    await page.click('button:has-text("Approve and Lock Version 1")');

    await page.waitForSelector('text=APPROVED', { timeout: 10000 });
    log(7, 'Scorecard successfully approved and locked!');
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-05-scorecard-approved.png'),
      fullPage: true,
    });

    // STEP 8: Dual Resume Upload (PDF & DOCX) with ClamAV Scanning & S3 Storage
    log(8, 'Generating synthetic PDF and DOCX resumes...');
    const pdfContent =
      'Alex Mercer - Lead Cloud Architect with 10 years experience in TypeScript, Node.js microservices, and PostgreSQL database performance tuning.';
    const pdfBuffer = createMinimalPdf(pdfContent);
    fs.writeFileSync(tempPdfPath, pdfBuffer);

    const docxBody =
      '<w:p><w:r><w:t>Sarah Connor - Senior Cloud Engineer with 8 years in TypeScript and distributed systems architecture.</w:t></w:r></w:p>';
    const docxBuffer = createMinimalDocx(docxBody);
    fs.writeFileSync(tempDocxPath, docxBuffer);

    log(8, 'Navigating to Candidates directory to upload both resumes...');
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates`);
    await page.waitForSelector('button:has-text("Upload resumes")');

    await page.click('button:has-text("Upload resumes")');
    await page.waitForSelector('input[type="file"]');

    log(8, 'Uploading both PDF and DOCX resumes simultaneously...');
    await page.setInputFiles('input[type="file"]', [tempPdfPath, tempDocxPath]);
    await page.waitForSelector('button:has-text("Upload 2 files")');
    await page.click('button:has-text("Upload 2 files")');

    await page.waitForSelector('text=Upload complete', { timeout: 25000 });
    await page.waitForSelector('text=Batch finalized for processing.', { timeout: 25000 });
    log(
      8,
      'SUCCESS: Both PDF and DOCX uploaded, ClamAV scanned CLEAN, batch finalized, and stored in S3Mock!',
    );
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-06-resume-uploaded.png'),
      fullPage: true,
    });

    await page.click('button:has-text("Close")');
    await page.waitForTimeout(1000);

    // Retrieve both candidate records from database
    const candidates = await db.candidate.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length < 2) {
      throw new Error(`Expected at least 2 candidates in database, found ${candidates.length}`);
    }

    const candidate1 = candidates[0]; // Candidate 1 (Accept flow)
    const candidate2 = candidates[1]; // Candidate 2 (Decline flow)
    log(
      8,
      `Registered Candidates: [1] ${candidate1.candidateCode} (PDF), [2] ${candidate2.candidateCode} (DOCX)`,
    );

    // STEP 9: Consent Invitation & Candidate 1 Acceptance Flow (via Worker Outbox -> Mailpit)
    log(9, `Navigating into Candidate 1 (${candidate1.candidateCode}) inspection view...`);
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate1.id}`);
    await page.waitForSelector(
      'button[title="Click to send invitation"], button:has-text("Send invitation")',
      { timeout: 15000 },
    );

    log(9, 'Generating Consent Invitation for Candidate 1...');
    await page.click(
      'button[title="Click to send invitation"], button:has-text("Send invitation")',
    );
    await page.waitForSelector('input[type="email"], input[placeholder*="@"]');

    const candidate1Email = `alex.mercer.${runId}@example.com`;
    await page.fill('input[type="email"], input[placeholder*="@"]', candidate1Email);
    await page.click('button:has-text("Generate Invitation")');

    await page.waitForSelector('text=Email Invitation Dispatched', { timeout: 10000 });
    log(9, 'Candidate 1 consent invitation queued for outbox delivery.');
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-07-consent-invitation-modal.png'),
      fullPage: true,
    });
    await page.click('button:has-text("Done")');

    log(
      9,
      'Waiting for containerized worker outbox dispatcher to deliver Candidate 1 email to Mailpit...',
    );
    const token1 = await waitForMailpitToken({
      toEmail: candidate1Email,
      subjectIncludes: 'Action Required: Consent Authorization',
      urlPath: '/consent',
      timeoutMs: 45000,
    });
    log(9, 'Candidate 1 consent invitation email verified in Mailpit and token extracted.');

    // Open Candidate 1 Portal and Accept Consent
    log(9, 'Candidate 1 opening consent portal to ACCEPT consent...');
    const candidate1Context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const candidate1Page = await candidate1Context.newPage();
    await candidate1Page.goto(`${APP_ORIGIN}/consent#token=${token1}`);
    await candidate1Page.waitForSelector('text=Consent for AI-Assisted Resume Screening', {
      timeout: 10000,
    });
    await candidate1Page.screenshot({
      path: path.join(artifactsDir, 'e2e-08-candidate-consent-portal.png'),
      fullPage: true,
    });

    await candidate1Page.fill('input[placeholder="e.g. Alex Morgan"]', 'Alex Mercer');
    await candidate1Page.click('button:has-text("Accept & Authorize Screening")');
    await candidate1Page.waitForSelector('text=Consent Recorded Successfully', { timeout: 10000 });
    log(9, 'Candidate 1 accepted consent!');
    await candidate1Page.screenshot({
      path: path.join(artifactsDir, 'e2e-09-candidate-consent-accepted.png'),
      fullPage: true,
    });
    await candidate1Context.close();

    // STEP 10: Consent Invitation & Candidate 2 Decline Flow (via Worker Outbox -> Mailpit)
    log(10, `Navigating into Candidate 2 (${candidate2.candidateCode}) inspection view...`);
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate2.id}`);
    await page.waitForSelector(
      'button[title="Click to send invitation"], button:has-text("Send invitation")',
      { timeout: 15000 },
    );

    log(10, 'Generating Consent Invitation for Candidate 2...');
    await page.click(
      'button[title="Click to send invitation"], button:has-text("Send invitation")',
    );
    await page.waitForSelector('input[type="email"], input[placeholder*="@"]');

    const candidate2Email = `sarah.connor.${runId}@example.com`;
    await page.fill('input[type="email"], input[placeholder*="@"]', candidate2Email);
    await page.click('button:has-text("Generate Invitation")');

    await page.waitForSelector('text=Email Invitation Dispatched', { timeout: 10000 });
    await page.click('button:has-text("Done")');

    log(
      10,
      'Waiting for containerized worker outbox dispatcher to deliver Candidate 2 email to Mailpit...',
    );
    const token2 = await waitForMailpitToken({
      toEmail: candidate2Email,
      subjectIncludes: 'Action Required: Consent Authorization',
      urlPath: '/consent',
      timeoutMs: 45000,
    });
    log(10, 'Candidate 2 consent invitation email verified in Mailpit and token extracted.');

    // Candidate 2 opens portal and DECLINES consent
    log(10, 'Candidate 2 opening consent portal to DECLINE consent...');
    const candidate2Context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const candidate2Page = await candidate2Context.newPage();
    await candidate2Page.goto(`${APP_ORIGIN}/consent#token=${token2}`);
    await candidate2Page.waitForSelector('text=Consent for AI-Assisted Resume Screening', {
      timeout: 10000,
    });

    log(10, 'Candidate 2 clicking Decline Screening and entering reason...');
    await candidate2Page.click('button:has-text("Decline Screening")');
    await candidate2Page.waitForSelector('button:has-text("Confirm Decline")');
    await candidate2Page.fill(
      'textarea',
      'Accepted another competing offer. Please pause evaluation.',
    );
    await candidate2Page.click('button:has-text("Confirm Decline")');

    await candidate2Page.waitForSelector('text=Consent Declined', { timeout: 10000 });
    log(10, 'SUCCESS: Candidate 2 decline recorded with reason!');
    await candidate2Page.screenshot({
      path: path.join(artifactsDir, 'e2e-10-candidate-consent-declined.png'),
      fullPage: true,
    });
    await candidate2Context.close();

    // Verify Candidate 2 status in recruiter view: processing blocked
    log(10, 'Verifying Candidate 2 processing restriction in recruiter view...');
    await page.reload();
    await page.waitForSelector('text=Held for Consent', { timeout: 10000 });
    log(10, 'Verified: Recruiter view shows "Held for Consent". Automated processing restricted.');

    // STEP 11: Containerized Worker Processing & Assessment for Candidate 1
    log(11, 'Waiting for containerized worker to complete EXTRACT_TEXT for Candidate 1...');
    const parsedDoc1 = await waitForCondition(
      async () => {
        const doc = await db.resumeDocument.findFirst({
          where: { candidateId: candidate1.id, organizationId: org.id },
        });
        return doc?.parseStatus === 'PARSED' ? doc : null;
      },
      'Candidate 1 resume parseStatus === PARSED',
      45000,
      500,
    );
    log(11, `Containerized worker parsed Candidate 1 resume (${parsedDoc1.id}).`);

    // Trigger AI Assessment on Candidate 1
    log(11, 'Opening Candidate 1 inspection page and Criteria & Assessment tab...');
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate1.id}`);
    await page.waitForSelector('text=Consent active', { timeout: 10000 });
    await page.waitForSelector('text=Extraction Complete', { timeout: 10000 });
    await page.waitForSelector('text=Alex Mercer', { timeout: 10000 });

    await page.click('button[role="tab"]:has-text("Criteria & Assessment")');
    await Promise.race([
      page.waitForSelector('button:has-text("Run Scorecard Assessment")', { timeout: 10000 }),
      page.waitForSelector('text=Evaluation Status:', { timeout: 10000 }),
    ]);
    const runAssessmentBtn = await page.$('button:has-text("Run Scorecard Assessment")');
    if (runAssessmentBtn) {
      await runAssessmentBtn.click();
    }

    log(11, 'Waiting for containerized worker to execute ASSESS_CANDIDATE...');
    const assessmentRecord = await waitForCondition(
      async () => {
        const assessment = await db.candidateAssessment.findFirst({
          where: { candidateId: candidate1.id, organizationId: org.id },
        });
        return assessment &&
          (assessment.status === 'COMPLETE' || assessment.status === 'NEEDS_REVIEW')
          ? assessment
          : null;
      },
      'Candidate 1 assessment completion',
      45000,
      500,
    );
    log(11, `Worker executed ASSESS_CANDIDATE job (status: ${assessmentRecord.status}).`);

    await page.reload();
    await page.waitForSelector('text=Consent active', { timeout: 10000 });
    await page.waitForSelector('text=Score:', { timeout: 10000 });
    log(11, 'Candidate 1 assessment complete and rendered in UI!');

    // STEP 12: Recruiter Review & Client Submission
    log(12, 'Recruiter inspecting original CV to satisfy human compliance check...');
    const inspectBtn = await page.$('button:has-text("Inspect Original CV")');
    if (inspectBtn) {
      await inspectBtn.click();
      await page.waitForSelector('text=Recruiter inspection verified:', { timeout: 10000 });
    }

    log(12, 'Recording positive review decision...');
    await page.click('button:has-text("Reviewed")');
    await page.waitForSelector('button:has-text("Shortlist Candidate"):not([disabled])', {
      timeout: 10000,
    });

    log(12, 'Shortlisting candidate...');
    await page.click('button:has-text("Shortlist Candidate")');
    await page.waitForSelector('button:has-text("Submit to "):not([disabled])', {
      timeout: 10000,
    });

    log(12, `Submitting candidate to client "${clientName}"...`);
    await page.click('button:has-text("Submit to ")');
    await page.waitForSelector('text=With client', { timeout: 10000 });
    log(12, 'Candidate 1 submitted to client ("With client")!');
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-12-candidate-submitted-to-client.png'),
      fullPage: true,
    });

    // STEP 13: Client Hiring Manager Portal — Shortlist, Decline with Reason & Propose Interview
    log(13, 'Client Hiring Manager logging into Client Portal...');
    const clientContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const clientPage = await clientContext.newPage();

    await clientPage.goto(`${APP_ORIGIN}/login`);
    await clientPage.fill('input[name="organization"]', orgName);
    await clientPage.fill('input[name="email"]', clientManagerEmail);
    await clientPage.fill('input[name="password"]', clientManagerPassword);
    await clientPage.click('button[type="submit"]');

    await clientPage.waitForURL('**/client-portal', { timeout: 10000 });
    await clientPage.waitForSelector('text=Client Portal');
    log(13, 'Client landed on Client Portal. Inspecting masked candidate directory...');
    await clientPage.screenshot({
      path: path.join(artifactsDir, 'e2e-13-client-portal-directory.png'),
      fullPage: true,
    });

    // Open review modal
    await clientPage.click('button:has-text("Review Candidate")');
    await clientPage.waitForSelector('text=Candidate Submission Review');

    // Test decline validation: reason < 3 chars must fail
    log(13, 'Testing client decline mandatory reason validation (< 3 chars)...');
    await clientPage.click('button:has-text("Decline Candidate")');
    await clientPage.fill('textarea#client-reason', 'no');
    await clientPage.click('button[type="submit"]:has-text("Confirm Decline")');
    await clientPage.waitForSelector(
      'text=A specific decline reason of at least 3 characters is required',
      { timeout: 5000 },
    );
    log(13, 'Client decline mandatory reason validation enforced (rejected reason < 3 chars)!');
    await clientPage.screenshot({
      path: path.join(artifactsDir, 'e2e-14-client-decline-mandatory-reason.png'),
      fullPage: true,
    });

    // Propose an interview
    log(13, 'Client proposing interview slot for candidate...');
    const recruiterInitialNotifyBefore = await countMailpitMessages({
      toEmail: recruiterEmail,
      subjectIncludes: `Interview Update: ${candidate1.candidateCode}`,
    });
    await clientPage.click('button:has-text("Propose Interview Slot")');
    await clientPage.waitForSelector('input[type="datetime-local"]');
    await clientPage.click('button:has-text("Submit Proposal")');

    await clientPage.waitForSelector('text=Interview proposal submitted to recruiter', {
      timeout: 10000,
    });
    log(13, 'Interview proposal successfully recorded!');
    await clientPage.screenshot({
      path: path.join(artifactsDir, 'e2e-15-client-interview-proposed.png'),
      fullPage: true,
    });

    await waitForMailpitMessage({
      toEmail: recruiterEmail,
      subjectIncludes: `Interview Update: ${candidate1.candidateCode}`,
      textIncludes: 'Format:',
      minCount: recruiterInitialNotifyBefore + 1,
      timeoutMs: 45000,
    });
    log(13, 'Verified: Initial interview proposal notification delivered to recruiter in Mailpit.');

    const candidate1Submission = await db.candidateSubmission.findFirst({
      where: {
        organizationId: org.id,
        requisitionId,
        candidateId: candidate1.id,
        status: { not: 'WITHDRAWN' },
      },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    if (!candidate1Submission) {
      throw new Error(`Expected active candidateSubmission for ${candidate1.candidateCode}`);
    }
    const maskedClientCandidateRef = `CAND-SUB-${candidate1Submission.id.slice(0, 8).toUpperCase()}`;

    const clientListRes = await getJsonViaPage(clientPage, '/interviews');
    if (!clientListRes.ok || !Array.isArray(clientListRes.json?.items)) {
      throw new Error(`Client GET /interviews failed: HTTP ${clientListRes.status}`);
    }
    const clientProposal = clientListRes.json.items.find(
      (item) => item.submissionId === candidate1Submission.id && item.status === 'PROPOSED',
    );
    if (!clientProposal) {
      throw new Error(
        `Proposed interview for submission ${candidate1Submission.id} (${maskedClientCandidateRef}) not found in client GET /interviews response`,
      );
    }
    if (
      clientProposal.candidateCode !== maskedClientCandidateRef ||
      clientProposal.candidateCode === candidate1.candidateCode
    ) {
      throw new Error(
        `Expected client-masked interview reference "${maskedClientCandidateRef}" (not internal "${candidate1.candidateCode}"), got "${clientProposal.candidateCode}"`,
      );
    }
    if (
      clientProposal.canAccept ||
      clientProposal.canReject ||
      clientProposal.canReschedule ||
      clientProposal.canComplete
    ) {
      throw new Error(
        `Client self-proposal action flags should all be false: ${JSON.stringify(clientProposal)}`,
      );
    }
    const submissionId = clientProposal.submissionId;

    const clientSelfAcceptRes = await apiRequestWithCsrf(
      clientPage,
      'POST',
      `/clients/${clientRecord.id}/submissions/${submissionId}/interviews/${clientProposal.id}/accept`,
      {},
    );
    if (clientSelfAcceptRes.status !== 400) {
      throw new Error(
        `Expected HTTP 400 when client attempts to self-accept own proposal, got ${clientSelfAcceptRes.status}`,
      );
    }
    log(13, 'Verified: Client cannot self-accept its own interview proposal (HTTP 400).');
    await clientPage.click('button[aria-label="Close review dialog"]');

    // STEP 14: Complete End-to-End Interview Lifecycle, Tenant Isolation & Post-Interview Outcome (P2-03)
    log(14, 'Recruiter inspecting updated interview proposal state...');
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate1.id}`);
    await page.waitForSelector('text=Interview proposed', { timeout: 10000 });
    log(14, 'Recruiter confirmed updated status: "Interview proposed".');
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-16-recruiter-updated-state.png'),
      fullPage: true,
    });

    log(
      14,
      'Verifying responsive /interviews layout across desktop (1440x900), tablet (768x1024), and mobile (390x844)...',
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${APP_ORIGIN}/interviews`);
    await assertResponsiveInterviewPage(
      page,
      'interviews-desktop-table',
      'interviews-mobile-list',
      path.join(artifactsDir, 'e2e-17a-interviews-desktop-1440x900.png'),
    );

    await page.setViewportSize({ width: 768, height: 1024 });
    await assertResponsiveInterviewPage(
      page,
      'interviews-mobile-list',
      'interviews-desktop-table',
      path.join(artifactsDir, 'e2e-17b-interviews-tablet-768x1024.png'),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await assertResponsiveInterviewPage(
      page,
      'interviews-mobile-list',
      'interviews-desktop-table',
      path.join(artifactsDir, 'e2e-17c-interviews-mobile-390x844.png'),
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    log(
      14,
      'Verified: Responsive /interviews renders desktop table at 1440x900 and card views at 768x1024 and 390x844 with zero horizontal overflow or button clipping.',
    );

    // Negative interview validation & invalid transition checks (Recruiter)
    log(14, 'Validating interview rejection length (< 3 chars) and premature completion checks...');
    const recruiterShortRejectRes = await apiRequestWithCsrf(
      page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${clientProposal.id}/reject`,
      { reason: 'no' },
    );
    if (recruiterShortRejectRes.status !== 400) {
      throw new Error(
        `Expected HTTP 400 for short interview decline reason, got ${recruiterShortRejectRes.status}`,
      );
    }

    const prematureCompleteRes = await apiRequestWithCsrf(
      page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${clientProposal.id}/complete`,
      {},
    );
    if (prematureCompleteRes.status !== 400) {
      throw new Error(
        `Expected HTTP 400 when completing PROPOSED (non-ACCEPTED) interview, got ${prematureCompleteRes.status}`,
      );
    }
    log(
      14,
      'Verified: Short rejection reason and premature PROPOSED->COMPLETED rejected (HTTP 400).',
    );

    // Cross-tenant isolation verification on interviews & submissions (login Beta Systems once and reuse in Step 16)
    log(14, 'Verifying cross-tenant interview & submission isolation as Beta Systems recruiter...');
    const tenant2Context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const tenant2Page = await tenant2Context.newPage();

    await tenant2Page.goto(`${APP_ORIGIN}/login`);
    await tenant2Page.fill('input[name="organization"]', tenant2Name);
    await tenant2Page.fill('input[name="email"]', tenant2RecruiterEmail);
    await tenant2Page.fill('input[name="password"]', tenant2Password);
    await tenant2Page.click('button[type="submit"]');
    await tenant2Page.waitForURL('**/dashboard', { timeout: 10000 });

    const tenant2InterviewsRes = await getJsonViaPage(tenant2Page, '/interviews');
    if (!tenant2InterviewsRes.ok || !Array.isArray(tenant2InterviewsRes.json?.items)) {
      throw new Error(`Tenant2 GET /interviews failed: HTTP ${tenant2InterviewsRes.status}`);
    }
    const leakedInterview = tenant2InterviewsRes.json.items.find(
      (i) => i.id === clientProposal.id || i.candidateCode === candidate1.candidateCode,
    );
    if (leakedInterview) {
      throw new Error(`Cross-tenant interview leak detected: ${JSON.stringify(leakedInterview)}`);
    }

    const crossTenantAcceptRes = await apiRequestWithCsrf(
      tenant2Page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${clientProposal.id}/accept`,
      {},
    );
    if (crossTenantAcceptRes.status !== 403 && crossTenantAcceptRes.status !== 404) {
      throw new Error(
        `Expected 403/404 for cross-tenant interview accept, got ${crossTenantAcceptRes.status}`,
      );
    }

    const crossTenantCompleteRes = await apiRequestWithCsrf(
      tenant2Page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${clientProposal.id}/complete`,
      {},
    );
    if (crossTenantCompleteRes.status !== 403 && crossTenantCompleteRes.status !== 404) {
      throw new Error(
        `Expected 403/404 for cross-tenant interview complete, got ${crossTenantCompleteRes.status}`,
      );
    }

    const crossTenantSubmissionRes = await getJsonViaPage(
      tenant2Page,
      `/requisitions/${requisitionId}/submissions/${submissionId}`,
    );
    if (crossTenantSubmissionRes.status !== 403 && crossTenantSubmissionRes.status !== 404) {
      throw new Error(
        `Expected 403/404 for cross-tenant submission read, got ${crossTenantSubmissionRes.status}`,
      );
    }
    log(
      14,
      'Verified: Cross-tenant GET /interviews hides Acme records and cross-tenant interview mutations return 403/404.',
    );

    // Recruiter counter-proposes alternative interview window via /interviews UI
    log(14, 'Recruiter proposing alternative interview window via /interviews UI...');
    const clientNotifyBefore = await countMailpitMessages({
      toEmail: clientManagerEmail,
      subjectIncludes: `Interview Update: ${maskedClientCandidateRef}`,
    });
    const altDate = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

    await page.click('[data-testid="interviews-desktop-table"] button:has-text("Propose Alt")');
    await page.waitForSelector('#reschedule-date', { timeout: 5000 });
    await page.fill('#reschedule-date', altDate);
    await page.fill('#reschedule-start', '14:00');
    await page.fill('#reschedule-end', '15:00');
    await page.fill('#reschedule-tz', 'UTC');
    await page.selectOption('#reschedule-format', 'VIDEO');
    await page.click('button:has-text("Propose Window")');

    await page.waitForSelector(
      `[role="alert"]:has-text("Alternative interview window proposed for ${candidate1.candidateCode}.")`,
      { timeout: 10000 },
    );
    await page.waitForSelector('[data-testid="interviews-desktop-table"] >> text=Rescheduled', {
      timeout: 10000,
    });
    await page.waitForSelector(
      '[data-testid="interviews-desktop-table"] >> text=Awaiting response',
      { timeout: 10000 },
    );

    const afterCounterList = await getJsonViaPage(page, '/interviews');
    const counterProposal = afterCounterList.json?.items?.find(
      (i) => i.status === 'PROPOSED' && i.id !== clientProposal.id,
    );
    if (
      !counterProposal ||
      counterProposal.proposerRole !== 'RECRUITER' ||
      counterProposal.canAccept ||
      counterProposal.canReject
    ) {
      throw new Error(
        `Unexpected counter-proposal state after recruiter reschedule: ${JSON.stringify(counterProposal)}`,
      );
    }

    await waitForMailpitMessage({
      toEmail: clientManagerEmail,
      subjectIncludes: `Interview Update: ${maskedClientCandidateRef}`,
      textIncludes: 'Format: VIDEO',
      minCount: clientNotifyBefore + 1,
      timeoutMs: 45000,
    });
    log(
      14,
      `Verified: Counter-proposal (${counterProposal.id}) recorded, old slot marked Rescheduled, and client notified via Mailpit.`,
    );

    // Client Hiring Manager accepts counter-proposed interview via /interviews UI
    log(14, 'Client Hiring Manager accepting counter-proposed interview via /interviews UI...');
    const recruiterAcceptNotifyBefore = await countMailpitMessages({
      toEmail: recruiterEmail,
      subjectIncludes: `Interview Update: ${candidate1.candidateCode}`,
    });

    await clientPage.goto(`${APP_ORIGIN}/interviews`);
    await clientPage.waitForSelector(
      '[data-testid="interviews-desktop-table"] button:has-text("Accept")',
      { timeout: 15000 },
    );
    await clientPage.click('[data-testid="interviews-desktop-table"] button:has-text("Accept")');

    await clientPage.waitForSelector(
      `[role="alert"]:has-text("Interview proposal for ${maskedClientCandidateRef} confirmed successfully.")`,
      { timeout: 10000 },
    );
    await clientPage.waitForSelector('[data-testid="interviews-desktop-table"] >> text=Confirmed', {
      timeout: 10000,
    });

    const clientAfterAcceptList = await getJsonViaPage(clientPage, '/interviews');
    const acceptedItem = clientAfterAcceptList.json?.items?.find(
      (i) => i.id === counterProposal.id,
    );
    if (
      !acceptedItem ||
      acceptedItem.status !== 'ACCEPTED' ||
      clientAfterAcceptList.json?.counts?.upcoming !== 1
    ) {
      throw new Error(
        `Unexpected client interview state after accept: ${JSON.stringify(clientAfterAcceptList.json)}`,
      );
    }
    await clientPage.screenshot({
      path: path.join(artifactsDir, 'e2e-17d-client-interview-accepted.png'),
      fullPage: true,
    });

    const rejectAfterAcceptRes = await apiRequestWithCsrf(
      clientPage,
      'POST',
      `/clients/${clientRecord.id}/submissions/${submissionId}/interviews/${counterProposal.id}/reject`,
      { reason: 'Attempting invalid decline after interview was accepted' },
    );
    if (rejectAfterAcceptRes.status !== 400) {
      throw new Error(
        `Expected HTTP 400 when client tries to reject ACCEPTED interview, got ${rejectAfterAcceptRes.status}`,
      );
    }

    await waitForMailpitMessage({
      toEmail: recruiterEmail,
      subjectIncludes: `Interview Update: ${candidate1.candidateCode}`,
      textIncludes: 'Format: VIDEO',
      minCount: recruiterAcceptNotifyBefore + 1,
      timeoutMs: 45000,
    });
    log(
      14,
      'Verified: Client accepted counter-proposal (Confirmed), post-accept reject denied (HTTP 400), and recruiter notified in Mailpit.',
    );

    // Recruiter marks accepted interview as COMPLETED via /interviews UI
    log(14, 'Recruiter marking accepted interview as completed via /interviews UI...');
    await page.click('button:has-text("Refresh")');
    await page.waitForSelector(
      '[data-testid="interviews-desktop-table"] button:has-text("Mark Complete")',
      { timeout: 15000 },
    );
    await page.click('[data-testid="interviews-desktop-table"] button:has-text("Mark Complete")');

    await page.waitForSelector(
      `[role="alert"]:has-text("Interview for ${candidate1.candidateCode} marked as completed.")`,
      { timeout: 10000 },
    );
    await page.waitForSelector('[data-testid="interviews-desktop-table"] >> text=Completed', {
      timeout: 10000,
    });

    const recruiterAfterCompleteList = await getJsonViaPage(page, '/interviews');
    const completedItem = recruiterAfterCompleteList.json?.items?.find(
      (i) => i.id === counterProposal.id,
    );
    if (
      !completedItem ||
      completedItem.status !== 'COMPLETED' ||
      recruiterAfterCompleteList.json?.counts?.completed !== 1 ||
      completedItem.canAccept ||
      completedItem.canReject ||
      completedItem.canReschedule ||
      completedItem.canComplete
    ) {
      throw new Error(
        `Unexpected interview state after completion: ${JSON.stringify(recruiterAfterCompleteList.json)}`,
      );
    }
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-17e-interviews-completed.png'),
      fullPage: true,
    });

    // Terminal COMPLETED transition guards
    const doubleCompleteRes = await apiRequestWithCsrf(
      page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${counterProposal.id}/complete`,
      {},
    );
    const acceptCompletedRes = await apiRequestWithCsrf(
      page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${counterProposal.id}/accept`,
      {},
    );
    const rejectCompletedRes = await apiRequestWithCsrf(
      page,
      'POST',
      `/requisitions/${requisitionId}/submissions/${submissionId}/interviews/${counterProposal.id}/reject`,
      { reason: 'Late decline attempt after completion' },
    );
    if (
      doubleCompleteRes.status !== 400 ||
      acceptCompletedRes.status !== 400 ||
      rejectCompletedRes.status !== 400
    ) {
      throw new Error(
        `Expected HTTP 400 on terminal COMPLETED interview mutations, got complete=${doubleCompleteRes.status}, accept=${acceptCompletedRes.status}, reject=${rejectCompletedRes.status}`,
      );
    }
    log(
      14,
      'Verified: Interview completed via UI (Completed KPI=1) and duplicate complete/accept/reject rejected (HTTP 400).',
    );

    // Post-interview Client Hiring Decision via Client Portal UI (/client-portal)
    log(
      14,
      'Exercising post-interview client hiring decision (UI decline validation & SHORTLIST outcome)...',
    );
    const recruiterDecisionNotifyBefore = await countMailpitMessages({
      toEmail: recruiterEmail,
      subjectIncludes: `Client Feedback Received: ${candidate1.candidateCode} (Shortlisted)`,
    });

    await clientPage.goto(`${APP_ORIGIN}/client-portal`);
    await clientPage.waitForSelector('button:has-text("Review & Decide")', { timeout: 15000 });
    await clientPage.click('button:has-text("Review & Decide")');

    const postInterviewDialog = clientPage.locator('[role="dialog"]');
    await postInterviewDialog.waitFor({ state: 'visible', timeout: 10000 });
    await postInterviewDialog
      .locator('text=Candidate Submission Review')
      .waitFor({ timeout: 5000 });
    await postInterviewDialog
      .locator(
        'text=Interview has completed. Record your final decision to shortlist or decline this candidate.',
      )
      .waitFor({ timeout: 5000 });
    await postInterviewDialog.getByText('COMPLETED', { exact: true }).waitFor({ timeout: 5000 });
    await postInterviewDialog.locator('h3:has-text("Record Hiring Decision")').waitFor({
      timeout: 5000,
    });

    // Verify UI mandatory decline reason (< 3 chars) in post-interview state
    await postInterviewDialog.locator('button:has-text("Decline Candidate")').click();
    await postInterviewDialog.locator('textarea#client-reason').fill('no');
    await postInterviewDialog.locator('button[type="submit"]:has-text("Confirm Decline")').click();
    await postInterviewDialog
      .locator('text=A specific decline reason of at least 3 characters is required')
      .waitFor({ timeout: 5000 });

    // Record genuine post-interview SHORTLIST decision through UI
    await postInterviewDialog.locator('button:has-text("Shortlist Candidate")').click();
    await postInterviewDialog
      .locator('textarea#client-reason')
      .fill('Strong technical interview across distributed systems and PostgreSQL architecture.');
    await postInterviewDialog
      .locator('button[type="submit"]:has-text("Confirm Shortlist")')
      .click();

    await postInterviewDialog
      .locator(
        '[role="status"]:has-text("Your feedback has been successfully recorded and shared with the recruiter.")',
      )
      .waitFor({ timeout: 10000 });
    await postInterviewDialog.locator('text=Final Hiring Decision Recorded:').waitFor({
      timeout: 10000,
    });
    if ((await postInterviewDialog.locator('button[type="submit"]').count()) !== 0) {
      throw new Error(
        'Expected Record Hiring Decision submit form to be hidden once status transitions to CLIENT_SHORTLISTED',
      );
    }

    await clientPage.screenshot({
      path: path.join(artifactsDir, 'e2e-16a-client-post-interview-decision-ui.png'),
      fullPage: true,
    });

    // Close modal and verify directory row updated to Shortlisted / View Decision
    await clientPage.click('button[aria-label="Close review dialog"]');
    await clientPage.waitForSelector('button:has-text("View Decision")', { timeout: 10000 });
    if ((await clientPage.locator('button:has-text("Review & Decide")').count()) !== 0) {
      throw new Error(
        'Expected Review & Decide button to be replaced by View Decision after shortlist',
      );
    }
    await clientContext.close();

    await waitForMailpitMessage({
      toEmail: recruiterEmail,
      subjectIncludes: `Client Feedback Received: ${candidate1.candidateCode} (Shortlisted)`,
      textIncludes: 'Decision: Shortlisted',
      minCount: recruiterDecisionNotifyBefore + 1,
      timeoutMs: 45000,
    });
    log(
      14,
      'Verified: Post-interview client SHORTLIST recorded through /client-portal UI (screenshot e2e-16a-client-post-interview-decision-ui.png) and notification delivered in Mailpit.',
    );

    // Recruiter verifies completed interview, client shortlisted state, and audit timeline
    log(
      14,
      'Recruiter verifying completed interview, Client shortlisted state & audit timeline...',
    );
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate1.id}`);
    await page.waitForSelector('text=Client shortlisted', { timeout: 10000 });
    await page.waitForSelector('text=Client Shortlisted', { timeout: 10000 });
    await page.waitForSelector('text=COMPLETED', { timeout: 10000 });
    await page.click('button[role="tab"]:has-text("Consent & Audit")');
    await page.waitForSelector('text=Candidate Pipeline Timeline & Audit History', {
      timeout: 10000,
    });
    await page.click('button:has-text("Refresh Timeline")');
    await page.waitForSelector('text=INTERVIEW_COMPLETED', { timeout: 10000 });
    await page.waitForSelector('text=CLIENT_SHORTLISTED', { timeout: 10000 });
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-16b-recruiter-interview-completed-shortlisted.png'),
      fullPage: true,
    });
    log(
      14,
      'Verified: Recruiter Candidate Detail shows COMPLETED interview, Client shortlisted status, and INTERVIEW_COMPLETED -> CLIENT_SHORTLISTED audit timeline!',
    );

    // STEP 15: End-to-End Consent Withdrawal Request & Confirmation Flow (/consent/withdraw)
    log(
      15,
      'Candidate submitting consent withdrawal verification request via /consent/withdraw...',
    );
    const withdrawContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const withdrawPage = await withdrawContext.newPage();
    await withdrawPage.goto(`${APP_ORIGIN}/consent/withdraw`);
    await withdrawPage.waitForSelector('input[type="email"]', { timeout: 10000 });
    await withdrawPage.fill('input[type="email"]', candidate1Email);
    await withdrawPage.fill('input[placeholder="e.g. CAN-0042"]', candidate1.candidateCode);
    await withdrawPage.click('button:has-text("Send Withdrawal Verification Link")');
    await withdrawPage.waitForSelector('text=Verification Request Sent', { timeout: 10000 });

    log(15, 'Waiting for worker outbox dispatcher to deliver withdrawal email to Mailpit...');
    const withdrawalToken = await waitForMailpitToken({
      toEmail: candidate1Email,
      subjectIncludes: 'Confirm Consent Withdrawal',
      urlPath: '/consent/withdraw',
      timeoutMs: 45000,
    });
    log(15, 'Withdrawal verification email verified in Mailpit and hash fragment token extracted.');

    await withdrawPage.goto(`${APP_ORIGIN}/consent/withdraw#token=${withdrawalToken}`);
    await withdrawPage.waitForSelector('text=Confirm Consent Withdrawal', { timeout: 10000 });

    log(15, 'Clicking Confirm Withdrawal of Consent...');
    await withdrawPage.click('button:has-text("Confirm Withdrawal of Consent")');
    await withdrawPage.waitForSelector('text=Consent Withdrawn Successfully', { timeout: 10000 });
    log(15, 'SUCCESS: Candidate consent permanently withdrawn via /consent/withdraw verification!');
    await withdrawPage.screenshot({
      path: path.join(artifactsDir, 'e2e-11-candidate-consent-withdrawn.png'),
      fullPage: true,
    });
    await withdrawContext.close();

    // Verify recruiter view reflects WITHDRAWN / Held for Consent
    log(15, 'Verifying recruiter view reflects WITHDRAWN consent status...');
    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate1.id}`);
    await page.waitForSelector('text=Consent withdrawn', { timeout: 10000 });
    await page.waitForSelector('text=Held for Consent', { timeout: 10000 });
    log(
      15,
      'Verified: Recruiter view shows "Consent withdrawn" and "Held for Consent". Processing halted.',
    );

    // STEP 16: Cross-Tenant Isolation Enforcement (UI Requisition + Stored Resume File)
    log(16, 'Verifying cross-tenant UI requisition & file isolation as Beta Systems recruiter...');

    // Direct navigation to Acme requisition must fail
    await tenant2Page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}`);
    await tenant2Page.waitForSelector('text=Requisition not found', { timeout: 8000 });
    log(
      16,
      'Verified: Direct navigation to foreign tenant requisition displays "Requisition not found".',
    );

    // Retrieve actual Acme resume document ID
    const resumeDoc1 = await db.resumeDocument.findFirst({
      where: { candidateId: candidate1.id },
    });

    // API direct fetch to foreign resume document must return 404
    const apiFileDenial = await tenant2Page.evaluate(
      async ({ reqId, resId }) => {
        const res = await fetch(`/api/v1/requisitions/${reqId}/resumes/${resId}/file`);
        return { status: res.status, ok: res.ok };
      },
      { reqId: requisitionId, resId: resumeDoc1?.id || 'nonexistent' },
    );
    if (apiFileDenial.status !== 404 && apiFileDenial.status !== 403) {
      throw new Error(
        `Expected 404/403 for cross-tenant API file retrieval, got ${apiFileDenial.status}`,
      );
    }
    log(
      16,
      `SUCCESS: Cross-tenant resume file fetch for actual stored object rejected with HTTP ${apiFileDenial.status} (0 bytes leaked).`,
    );
    await tenant2Page.screenshot({
      path: path.join(artifactsDir, 'e2e-17-tenant-isolation-enforced.png'),
      fullPage: true,
    });
    await tenant2Context.close();

    // STEP 17: Candidate Self-Deletion Request & Confirmation Flow (/consent/deletion)
    log(
      17,
      'Candidate submitting permanent data deletion verification request via /consent/deletion...',
    );
    const deletionContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const deletionPage = await deletionContext.newPage();
    await deletionPage.goto(`${APP_ORIGIN}/consent/deletion`);
    await deletionPage.waitForSelector('input[type="email"]', { timeout: 10000 });
    await deletionPage.fill('input[type="email"]', candidate1Email);
    await deletionPage.fill('input[placeholder="CAND-00123"]', candidate1.candidateCode);
    await deletionPage.click('button:has-text("Send Deletion Verification Link")');
    await deletionPage.waitForSelector('text=Verification Email Sent', { timeout: 10000 });

    log(17, 'Waiting for worker outbox dispatcher to deliver deletion email to Mailpit...');
    const deletionToken = await waitForMailpitToken({
      toEmail: candidate1Email,
      subjectIncludes: 'Confirm Permanent Data Deletion',
      urlPath: '/consent/deletion',
      timeoutMs: 45000,
    });
    log(17, 'Deletion verification email verified in Mailpit and token extracted.');

    await deletionPage.goto(`${APP_ORIGIN}/consent/deletion#token=${deletionToken}`);
    await deletionPage.waitForSelector('text=Confirm Permanent Candidate Erasure', {
      timeout: 10000,
    });
    const sanitizedDeletionUrl = deletionPage.url();
    if (sanitizedDeletionUrl.includes('#token=') || sanitizedDeletionUrl.includes('token=')) {
      throw new Error(
        `Expected /consent/deletion URL to scrub token fragment on mount, got: ${sanitizedDeletionUrl}`,
      );
    }

    await deletionPage.check('#confirm-ack');
    await deletionPage.click('button:has-text("Permanently Delete My Data")');
    await deletionPage.waitForSelector('text=Your Data Has Been Permanently Erased', {
      timeout: 15000,
    });
    await deletionPage.screenshot({
      path: path.join(artifactsDir, 'e2e-20-candidate-self-deletion-completed.png'),
      fullPage: true,
    });
    await deletionContext.close();

    const deletedCandidate = await db.candidate.findUnique({
      where: { id: candidate1.id },
      select: { recordStatus: true },
    });
    const remainingResumes = await db.resumeDocument.count({
      where: { candidateId: candidate1.id, organizationId: org.id },
    });
    const remainingConsents = await db.candidateConsent.count({
      where: { candidateId: candidate1.id, organizationId: org.id },
    });
    const remainingVerifications = await db.candidateDeletionVerification.count({
      where: { candidateId: candidate1.id, organizationId: org.id },
    });
    if (
      deletedCandidate?.recordStatus !== 'DELETED' ||
      remainingResumes !== 0 ||
      remainingConsents !== 0 ||
      remainingVerifications !== 0
    ) {
      throw new Error(
        `Candidate self-deletion incomplete: status=${deletedCandidate?.recordStatus}, resumes=${remainingResumes}, consents=${remainingConsents}, verifications=${remainingVerifications}`,
      );
    }
    if (resumeDoc1?.objectKey) {
      const s3AfterDelete = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/${resumeDoc1.objectKey}`, {
        method: 'HEAD',
      });
      if (s3AfterDelete.status !== 404) {
        throw new Error(
          `Expected deleted candidate S3 object "${resumeDoc1.objectKey}" to return 404, got HTTP ${s3AfterDelete.status}`,
        );
      }
    }
    log(
      17,
      'Verified: Candidate 1 marked DELETED in DB, resumes/consents/verifications purged, and S3 object deleted.',
    );

    // STEP 18: Responsive Mobile Viewport Verification (390x844)
    log(18, 'Verifying mobile viewport responsiveness (390x844)...');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${APP_ORIGIN}/dashboard`);
    await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-18-mobile-dashboard-390x844.png'),
      fullPage: true,
    });

    await page.goto(`${APP_ORIGIN}/requisitions/${requisitionId}/candidates/${candidate2.id}`);
    await page.waitForSelector('h1:has-text("Candidate Inspection")', { timeout: 15000 });
    await page.screenshot({
      path: path.join(artifactsDir, 'e2e-19-mobile-candidate-inspection-390x844.png'),
      fullPage: true,
    });
    log(18, 'Mobile viewports captured cleanly without overflow.');

    await recruiterContext.close();

    e2eSuccess = true;
    log('FINISH', 'ALL EXTENDED PRODUCTION-TOPOLOGY E2E MILESTONES COMPLETED WITH 100% SUCCESS!');
  } catch (err) {
    logError('FAILURE', `E2E run failed: ${err.message}\n${err.stack}`);
  } finally {
    if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
    if (fs.existsSync(tempDocxPath)) fs.unlinkSync(tempDocxPath);
    await browser.close();
    await disconnectDatabase();
  }

  if (!e2eSuccess) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
