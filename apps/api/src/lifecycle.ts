export interface ClosableServer {
  close(callback: (error?: Error) => void): void;
}

export function createShutdownHandler(
  server: ClosableServer,
  disconnect: () => Promise<void>,
): (signal: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (signal: string): Promise<void> => {
    shutdownPromise ??= new Promise((resolve) => {
      console.log(`Received ${signal}; shutting down API`);

      server.close(async (error) => {
        if (error) {
          console.error('API shutdown failed');
          process.exitCode = 1;
          resolve();
          return;
        }

        try {
          await disconnect();
        } catch {
          console.error('Database disconnect failed during API shutdown');
          process.exitCode = 1;
        }

        resolve();
      });
    });

    return shutdownPromise;
  };
}
