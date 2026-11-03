import type { RequestHandler } from 'express';

export function createRequireSameOrigin(applicationOrigin: string): RequestHandler {
  return (request, response, next) => {
    const origin = request.get('origin');
    if (origin !== applicationOrigin) {
      response.status(403).json({ error: 'request_not_allowed' });
      return;
    }

    next();
  };
}
