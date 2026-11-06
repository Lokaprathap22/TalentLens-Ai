import { randomBytes } from 'node:crypto';
import { getDatabaseClient, type PrismaClient } from '@talentlens/database';
import { hashPassword } from '../modules/auth/password.service.js';

export interface BootstrapResult {
  organizationId: string;
  organizationName: string;
  userId: string;
  recruiterEmail: string;
  temporaryPassword: string;
}

export function generateSecureOneTimePassword(): string {
  // 18 bytes base64url yields 24 characters with ~144 bits of entropy
  return randomBytes(18).toString('base64url');
}

export async function bootstrapInitialTenant(
  database: PrismaClient,
  params: {
    organizationName: string;
    recruiterEmail: string;
  },
): Promise<BootstrapResult> {
  const orgName = params.organizationName.trim();
  const email = params.recruiterEmail.trim();

  if (!orgName || orgName.length < 2) {
    throw new Error('Organization name must contain at least 2 characters');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Valid recruiter email address is required');
  }

  const normalizedOrgName = orgName.toLowerCase();
  const normalizedEmail = email.toLowerCase();

  // Check collision for organization normalized name
  const existingOrg = await database.organization.findUnique({
    where: { normalizedName: normalizedOrgName },
  });

  if (existingOrg) {
    throw new Error(`Organization "${orgName}" already exists (ID: ${existingOrg.id})`);
  }

  const temporaryPassword = generateSecureOneTimePassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const result = await database.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: orgName,
        normalizedName: normalizedOrgName,
      },
    });

    const user = await tx.user.create({
      data: {
        organizationId: org.id,
        email,
        normalizedEmail,
        passwordHash,
        role: 'RECRUITER',
        status: 'ACTIVE',
      },
    });

    return {
      organizationId: org.id,
      organizationName: org.name,
      userId: user.id,
      recruiterEmail: user.email,
      temporaryPassword,
    };
  });

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const orgName = args[0];
  const email = args[1];

  if (!orgName || !email) {
    console.error('Usage: npm run bootstrap -- <organizationName> <recruiterEmail>');
    console.error('Example: npm run bootstrap -- "Acme Corp" "admin@acme.com"');
    process.exit(1);
  }

  try {
    const db = getDatabaseClient();
    const result = await bootstrapInitialTenant(db, {
      organizationName: orgName,
      recruiterEmail: email,
    });

    console.log('\n============================================================');
    console.log('TALENTLENS AI — INITIAL TENANT BOOTSTRAP SUCCESSFUL');
    console.log('============================================================');
    console.log(`Organization ID:    ${result.organizationId}`);
    console.log(`Organization Name:  ${result.organizationName}`);
    console.log(`Recruiter User ID:  ${result.userId}`);
    console.log(`Recruiter Email:    ${result.recruiterEmail}`);
    console.log('------------------------------------------------------------');
    console.log(`Temporary Password: ${result.temporaryPassword}`);
    console.log('------------------------------------------------------------');
    console.log('IMPORTANT SECURITY NOTICE:');
    console.log('1. Save this temporary password in your password manager immediately.');
    console.log('2. This temporary password will NOT be displayed again.');
    console.log('3. The recruiter must log in and change their password upon first sign-in.');
    console.log('============================================================\n');

    process.exit(0);
  } catch (err: unknown) {
    console.error(`\nBootstrap failed: ${(err as Error)?.message}\n`);
    process.exit(1);
  }
}

// Execute when invoked directly from CLI
if (process.argv[1]?.endsWith('bootstrap.ts') || process.argv[1]?.endsWith('bootstrap.js')) {
  main().catch((err) => {
    console.error('Fatal bootstrap execution error:', err);
    process.exit(1);
  });
}
