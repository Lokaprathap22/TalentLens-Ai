import { z } from 'zod';

export const resumeIdParamSchema = z.object({
  requisitionId: z.string().uuid('Invalid requisition ID'),
  resumeId: z.string().uuid('Invalid resume ID'),
});

export const requisitionIdParamSchema = z.object({
  requisitionId: z.string().uuid('Invalid requisition ID'),
});

export const listResumesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function sanitizeFileName(name: string): string {
  // Strip null bytes, control characters, path traversal markers, and path separators
  const cleaned = name
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\.\.+/g, '')
    .replace(/[/\\]+/g, '_')
    .replace(/^_+/, '_')
    .trim();

  // If empty or all symbols, generate a safe default
  if (!cleaned || cleaned === '.' || cleaned === '_') {
    return 'document.bin';
  }

  // Cap length to 120 characters to prevent filesystem or DB field overflow
  return cleaned.slice(0, 120);
}
