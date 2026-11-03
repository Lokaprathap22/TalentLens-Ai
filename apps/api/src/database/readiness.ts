import { getDatabaseClient } from '@talentlens/database';

export type DatabaseHealthChecker = () => Promise<void>;

export function createDatabaseHealthChecker(): DatabaseHealthChecker {
  return async () => {
    await getDatabaseClient().$queryRaw`SELECT 1`;
  };
}
