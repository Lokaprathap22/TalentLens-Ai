import { describe, expect, it, vi } from 'vitest';

import { createShutdownHandler, type ClosableServer } from './lifecycle.js';

describe('createShutdownHandler', () => {
  it('closes the HTTP server before disconnecting the database', async () => {
    const events: string[] = [];
    const server: ClosableServer = {
      close(callback) {
        events.push('close-started');
        callback();
      },
    };
    const disconnect = vi.fn(async () => {
      events.push('database-disconnected');
    });

    await createShutdownHandler(server, disconnect)('SIGTERM');

    expect(events).toEqual(['close-started', 'database-disconnected']);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not disconnect more than once for repeated signals', async () => {
    const server: ClosableServer = {
      close(callback) {
        callback();
      },
    };
    const disconnect = vi.fn(async () => undefined);
    const shutdown = createShutdownHandler(server, disconnect);

    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
