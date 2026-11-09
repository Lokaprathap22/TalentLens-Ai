import { getDatabaseClient, type PrismaClient } from '@talentlens/database';
import {
  ACTIVATION_TOKEN_TTL_MS,
  generateSecureToken,
  hashSecurityToken,
} from '../modules/auth/token.service.js';

export interface BootstrapResult {
  organizationId: string;
  organizationName: string;
  userId: string;
  recruiterEmail: string;
  activationToken: string;
  activationUrl: string;
}

export async function bootstrapInitialTenant(
  database: PrismaClient,
  params: {
    organizationName: string;
    recruiterEmail: string;
    applicationOrigin?: string;
  },
): Promise<BootstrapResult> {
  const orgName = params.organizationName.trim();
  const email = params.recruiterEmail.trim();
  const origin = (
    params.applicationOrigin ??
    process.env['APP_ORIGIN'] ??
    'http://localhost:5173'
  ).replace(/\/+$/, '');

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

  const activationToken = generateSecureToken(32);
  const tokenHash = hashSecurityToken(activationToken);
  const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_MS);

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
        passwordHash: null,
        role: 'RECRUITER',
        status: 'INVITED',
      },
    });

    await tx.userSecurityToken.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        tokenHash,
        type: 'ACTIVATION',
        expiresAt,
      },
    });

    const activationUrl = `${origin}/activate#token=${activationToken}`;

    return {
      organizationId: org.id,
      organizationName: org.name,
      userId: user.id,
      recruiterEmail: user.email,
      activationToken,
      activationUrl,
    };
  });

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const positionalArgs = args.filter((a) => !a.startsWith('--'));
  const orgName = positionalArgs[0];
  const email = positionalArgs[1];
  const printLink = args.includes('--print-activation-link') || args.includes('--print-token');

  if (!orgName || !email) {
    console.error(
      'Usage: npm run bootstrap -- <organizationName> <recruiterEmail> [--print-activation-link]',
    );
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
    console.log('Account Status:     INVITED (No temporary password created)');
    console.log('Activation Security: Token generated and stored as SHA-256 hash.');

    if (printLink) {
      console.log('------------------------------------------------------------');
      console.log('SENSITIVE OPERATOR NOTICE: ONE-TIME ACTIVATION LINK PRINTED');
      console.log('------------------------------------------------------------');
      console.log(`Activation URL:     ${result.activationUrl}`);
      console.log(`Activation Token:   ${result.activationToken}`);
      console.log('WARNING:');
      console.log('- This is a high-privilege one-time bearer activation credential.');
      console.log('- Transmit this link to the intended recruiter via a secure encrypted channel.');
      console.log('- Never commit, paste into shared logs, or expose in public communication.');
    } else {
      console.log('Notice:             One-time activation URL is concealed by default.');
      console.log(
        '                    Pass --print-activation-link to print URL for offline setup.',
      );
    }
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
