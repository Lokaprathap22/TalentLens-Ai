import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

let databaseClient: PrismaClient | undefined;

function createDatabaseClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL must be configured before creating the database client');
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export function getDatabaseClient(): PrismaClient {
  databaseClient ??= createDatabaseClient();
  return databaseClient;
}

export async function disconnectDatabase(): Promise<void> {
  if (databaseClient) {
    await databaseClient.$disconnect();
    databaseClient = undefined;
  }
}
