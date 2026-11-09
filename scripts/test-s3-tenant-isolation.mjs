import { randomUUID } from 'node:crypto';
import { getDatabaseClient } from '@talentlens/database';
import {
  S3DocumentStorageService,
  StoragePathTraversalError,
} from '../apps/api/dist/modules/resumes/resume.storage.js';
import {
  createResumeService,
  ResumeNotFoundError,
} from '../apps/api/dist/modules/resumes/resume.service.js';
import { createResumeRepository } from '../apps/api/dist/modules/resumes/resume.repository.js';
import { ClamAvScanner } from '../apps/api/dist/modules/resumes/resume.scanner.js';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://talentlens:talentlens_local_only@127.0.0.1:5432/talentlens_scorecard_test';

const db = getDatabaseClient();

async function runS3TenantIsolationTest() {
  console.log(
    '\x1b[36m================================================================================\x1b[0m',
  );
  console.log('\x1b[36mTALENTLENS AI — S3 TENANT ISOLATION & OBJECT BOUNDARY VERIFICATION\x1b[0m');
  console.log(
    '\x1b[36m================================================================================\x1b[0m',
  );

  const s3Config = {
    bucket: 'talentlens-test-resumes',
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:9090',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    forcePathStyle: true,
  };

  const s3Storage = new S3DocumentStorageService(s3Config);
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 3310, failClosed: true });
  const repository = createResumeRepository(db);
  const service = createResumeService({
    repository,
    storageService: s3Storage,
    scannerService: scanner,
    publishWorkerJob: async () => {},
  });

  const runId = Date.now().toString(36);
  const secretContent = `CONFIDENTIAL CANDIDATE RESUME FOR ORG A: Alice Smith. Secret Token: ORG_A_SECRET_${runId}. Expected: $250k. SSN: 000-11-2222.`;
  const secretBuffer = Buffer.from(secretContent, 'utf8');

  let orgA, orgB, userA, userB, clientA, clientB, reqA, reqB, batchRecordA;
  const storageKeyA = s3Storage.generateKey('pdf');

  try {
    // 1. Write actual secret object directly to S3Mock
    console.log(`[1] Storing real confidential object in S3Mock at key '${storageKeyA}'...`);
    const saved = await s3Storage.save(storageKeyA, secretBuffer);
    if (!saved || saved.sizeBytes !== secretBuffer.length) {
      throw new Error(
        `Failed to save object to S3. Expected ${secretBuffer.length} bytes, got ${saved?.sizeBytes}`,
      );
    }

    // Verify S3 contains the object
    const readBack = await s3Storage.read(storageKeyA);
    if (readBack.toString('utf8') !== secretContent) {
      throw new Error('S3 read back content mismatch!');
    }
    console.log(
      `\x1b[32m[PASS]\x1b[0m Real object written and verified in S3Mock (${readBack.length} bytes).`,
    );

    // 2. Setup Organizations and Users in database
    console.log('[2] Creating Organization A and Organization B in database...');
    orgA = await db.organization.create({
      data: { name: `Org A Isolation ${runId}`, normalizedName: `org_a_isolation_${runId}` },
    });
    orgB = await db.organization.create({
      data: { name: `Org B Isolation ${runId}`, normalizedName: `org_b_isolation_${runId}` },
    });

    userA = await db.user.create({
      data: {
        organizationId: orgA.id,
        email: `recruiter.a.${runId}@orga.com`,
        normalizedEmail: `recruiter.a.${runId}@orga.com`,
        passwordHash: 'dummyhash',
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
    });

    userB = await db.user.create({
      data: {
        organizationId: orgB.id,
        email: `recruiter.b.${runId}@orgb.com`,
        normalizedEmail: `recruiter.b.${runId}@orgb.com`,
        passwordHash: 'dummyhash',
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
    });

    clientA = await db.client.create({
      data: {
        organizationId: orgA.id,
        name: `Client A ${runId}`,
        normalizedName: `client_a_${runId}`,
      },
    });
    clientB = await db.client.create({
      data: {
        organizationId: orgB.id,
        name: `Client B ${runId}`,
        normalizedName: `client_b_${runId}`,
      },
    });

    reqA = await db.requisition.create({
      data: {
        organizationId: orgA.id,
        clientId: clientA.id,
        title: `Senior Engineer A ${runId}`,
        jdText: 'Job description for Senior Engineer A',
        status: 'OPEN',
        createdById: userA.id,
        assignedRecruiterId: userA.id,
      },
    });

    reqB = await db.requisition.create({
      data: {
        organizationId: orgB.id,
        clientId: clientB.id,
        title: `Senior Engineer B ${runId}`,
        jdText: 'Job description for Senior Engineer B',
        status: 'OPEN',
        createdById: userB.id,
        assignedRecruiterId: userB.id,
      },
    });

    const principalA = {
      userId: userA.id,
      organizationId: orgA.id,
      role: 'RECRUITER',
      status: 'ACTIVE',
      sessionId: randomUUID(),
      sessionCreatedAt: new Date(),
    };

    const principalB = {
      userId: userB.id,
      organizationId: orgB.id,
      role: 'RECRUITER',
      status: 'ACTIVE',
      sessionId: randomUUID(),
      sessionCreatedAt: new Date(),
    };

    // Ingest resume document under Org A using repository transaction
    batchRecordA = await repository.createResumeBatch(
      principalA,
      reqA.id,
      [
        {
          originalFileName: 'alice_smith_resume.pdf',
          fileType: 'PDF',
          mimeType: 'application/pdf',
          sizeBytes: secretBuffer.length,
          sha256: 'a'.repeat(64),
          storageKey: storageKeyA,
          scanStatus: 'CLEAN',
        },
      ],
      { totalUploaded: 1, duplicates: 0, rejected: 0 },
    );

    const resumeDocIdA = batchRecordA.accepted[0].resumeDocumentId;
    console.log(`\x1b[32m[PASS]\x1b[0m Ingested Org A ResumeDocument ID: ${resumeDocIdA}`);

    // 3. Authorized access check (Org A retrieving Org A's resume)
    console.log('[3] Testing authorized retrieval as Organization A recruiter...');
    const authFile = await service.getResumeFile(principalA, reqA.id, resumeDocIdA);
    if (!authFile || authFile.buffer.toString('utf8') !== secretContent) {
      throw new Error('Authorized user failed to retrieve resume content!');
    }
    console.log(
      `\x1b[32m[PASS]\x1b[0m Authorized retrieval successful. Exact bytes verified (${authFile.buffer.length} bytes).`,
    );

    // 4. Unauthorized cross-tenant retrieval (Org B attempting to access Org A's resume)
    console.log('[4] Testing UNAUTHORIZED cross-tenant retrieval as Organization B recruiter...');
    let leakedBytes = null;
    let caughtError = null;

    try {
      leakedBytes = await service.getResumeFile(principalB, reqA.id, resumeDocIdA);
    } catch (err) {
      caughtError = err;
    }

    if (leakedBytes !== null) {
      throw new Error(
        `CRITICAL SECURITY LEAK: Org B retrieved Org A resume bytes! Content: ${leakedBytes.buffer.toString('utf8')}`,
      );
    }
    if (!(caughtError instanceof ResumeNotFoundError)) {
      throw new Error(`Expected ResumeNotFoundError (404), got: ${caughtError}`);
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Cross-tenant getResumeFile REJECTED: ResumeNotFoundError (404), 0 bytes returned.',
    );

    // 5. Unauthorized cross-tenant metadata inspection
    console.log('[5] Testing cross-tenant metadata inspection (getResumeDetails)...');
    let leakedDetails = null;
    let caughtDetailsError = null;

    try {
      leakedDetails = await service.getResumeDetails(principalB, reqA.id, resumeDocIdA);
    } catch (err) {
      caughtDetailsError = err;
    }

    if (leakedDetails !== null) {
      throw new Error(
        `CRITICAL SECURITY LEAK: Org B retrieved Org A details! ${JSON.stringify(leakedDetails)}`,
      );
    }
    if (!(caughtDetailsError instanceof ResumeNotFoundError)) {
      throw new Error(`Expected ResumeNotFoundError, got: ${caughtDetailsError}`);
    }
    console.log('\x1b[32m[PASS]\x1b[0m Cross-tenant getResumeDetails REJECTED: 0 metadata leaked.');

    // 6. Parameter tampering: Splicing Org B requisition with Org A resume ID
    console.log('[6] Testing parameter tampering: Org B requisition ID with Org A resume ID...');
    let tamperedResult = null;
    let tamperedError = null;

    try {
      tamperedResult = await service.getResumeFile(principalB, reqB.id, resumeDocIdA);
    } catch (err) {
      tamperedError = err;
    }

    if (tamperedResult !== null) {
      throw new Error('CRITICAL SECURITY LEAK: Tampered requisition/resume pair succeeded!');
    }
    if (!(tamperedError instanceof ResumeNotFoundError)) {
      throw new Error(`Expected ResumeNotFoundError, got: ${tamperedError}`);
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Tampered requisition/resume access REJECTED: 0 bytes returned.',
    );

    // 7. Storage Key Path Traversal & Crafting Attacks
    console.log('[7] Testing storage key path traversal and cross-tenant key crafting attacks...');
    const maliciousKeys = [
      `../${storageKeyA}`,
      `../../org-a/${storageKeyA}`,
      `/${storageKeyA}`,
      `${storageKeyA}/`,
      `2026-11/../secret.pdf`,
      `2026-11/..\\secret.pdf`,
      `2026-11/foo/../../../etc/passwd`,
      `2026-11/\0secret.pdf`,
      `2026-11/foo;rm -rf`,
      `2026-11/foo?param=val`,
      `2026-11/foo#fragment`,
    ];

    for (const badKey of maliciousKeys) {
      let threw = false;
      try {
        s3Storage.validateKey(badKey);
      } catch (err) {
        if (err instanceof StoragePathTraversalError) {
          threw = true;
        }
      }
      if (!threw) {
        throw new Error(`Storage validation failed to reject malicious key: "${badKey}"`);
      }
    }
    console.log(
      `\x1b[32m[PASS]\x1b[0m All ${maliciousKeys.length} path traversal / injection keys strictly rejected with StoragePathTraversalError.`,
    );

    // 8. Direct storage read with malicious key
    let readThrew = false;
    try {
      await s3Storage.read('../etc/shadow');
    } catch (err) {
      if (err instanceof StoragePathTraversalError) {
        readThrew = true;
      }
    }
    if (!readThrew) {
      throw new Error(
        's3Storage.read allowed path traversal without throwing StoragePathTraversalError',
      );
    }
    console.log(
      '\x1b[32m[PASS]\x1b[0m Direct s3Storage.read traversal attempt blocked before request dispatch.',
    );

    console.log(
      '\n\x1b[32m================================================================================\x1b[0m',
    );
    console.log('\x1b[32mS3 TENANT ISOLATION AUDIT: 100% PASSED\x1b[0m');
    console.log('\x1b[32m  • Real S3 object created and retrieved:  PASS\x1b[0m');
    console.log(
      '\x1b[32m  • Cross-tenant unauthorized read:        REJECTED (404, 0 bytes leaked)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Cross-tenant metadata leakage:         REJECTED (404, 0 records leaked)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Requisition/Resume ID splicing:        REJECTED (404, 0 bytes leaked)\x1b[0m',
    );
    console.log(
      '\x1b[32m  • Path traversal key craft attacks:      BLOCKED (StoragePathTraversalError)\x1b[0m',
    );
    console.log(
      '\x1b[32m================================================================================\n',
    );
  } finally {
    try {
      await s3Storage.delete(storageKeyA);
    } catch {
      // Best-effort cleanup of temporary test object
    }
    if (batchRecordA) {
      await db.processingJob
        .deleteMany({ where: { batchId: batchRecordA.batchId } })
        .catch(() => {});
      await db.processingBatch.deleteMany({ where: { id: batchRecordA.batchId } }).catch(() => {});
      for (const item of batchRecordA.accepted) {
        await db.resumeDocument
          .deleteMany({ where: { id: item.resumeDocumentId } })
          .catch(() => {});
        await db.candidate.deleteMany({ where: { id: item.candidateId } }).catch(() => {});
      }
    }
    if (reqA) await db.requisition.deleteMany({ where: { id: reqA.id } }).catch(() => {});
    if (reqB) await db.requisition.deleteMany({ where: { id: reqB.id } }).catch(() => {});
    if (clientA) await db.client.deleteMany({ where: { id: clientA.id } }).catch(() => {});
    if (clientB) await db.client.deleteMany({ where: { id: clientB.id } }).catch(() => {});
    if (userA) await db.user.deleteMany({ where: { id: userA.id } }).catch(() => {});
    if (userB) await db.user.deleteMany({ where: { id: userB.id } }).catch(() => {});
    if (orgA) await db.organization.deleteMany({ where: { id: orgA.id } }).catch(() => {});
    if (orgB) await db.organization.deleteMany({ where: { id: orgB.id } }).catch(() => {});
  }
}

runS3TenantIsolationTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\x1b[31m[TEST FAILED]\x1b[0m', err);
    process.exit(1);
  });
