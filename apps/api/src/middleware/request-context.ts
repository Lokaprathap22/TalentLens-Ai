import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RequestContextStore {
  correlationId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContextStore>();
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveSanitizedCorrelationId(rawHeader: string | string[] | undefined): string {
  const candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (SAFE_CORRELATION_ID_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return randomUUID();
}

export function runWithRequestContext<T>(correlationId: string, fn: () => T): T {
  return requestContextStorage.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return requestContextStorage.getStore()?.correlationId;
}

export function ensureRequestCorrelationId(request: Request, response: Response): string {
  const existing =
    typeof response.locals.requestId === 'string' &&
    SAFE_CORRELATION_ID_PATTERN.test(response.locals.requestId)
      ? response.locals.requestId
      : undefined;
  const correlationId = existing ?? resolveSanitizedCorrelationId(request.header('x-request-id'));
  response.locals.requestId = correlationId;
  if (!response.headersSent) {
    response.setHeader('x-request-id', correlationId);
  }
  return correlationId;
}

export function createRequestCorrelationMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const correlationId = ensureRequestCorrelationId(request, response);
    runWithRequestContext(correlationId, () => next());
  };
}
