import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';

// Lightweight logging helper that also persists to the notifications-adjacent log.
export function logAction(action: string, detail: string) {
  const ts = new Date().toISOString();
  console.log(`[admin] ${ts} ${action} — ${detail}`);
}

export async function notify(role: string, recipientId: number, title: string, body: string) {
  await db
    .prepare('INSERT INTO notifications (recipient_role, recipient_id, title, body) VALUES (?,?,?,?)')
    .run(role, recipientId, title, body);
}

// Global error-handling middleware.
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || 500;
  if (status >= 500) console.error('[admin] Unhandled error:', err);
  res.status(status).json({ error: err.message || 'Internal server error' });
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Route not found' });
}
