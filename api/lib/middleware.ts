
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual }                     from 'crypto';
import { auth as adminAuth }                   from './firebaseAdmin';

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * verifyToken — Firebase ID token verify karo Authorization header se
 *
 * Client side pe:
 *   const token = await getIdToken(auth.currentUser);
 *   fetch('/api/...', { headers: { Authorization: `Bearer ${token}` } });
 */
export async function verifyToken(req: VercelRequest): Promise<string> {
  const authHeader = req.headers['authorization'] ?? '';

  if (!authHeader.startsWith('Bearer ')) {
    throw Object.assign(
      new Error('Missing or invalid Authorization header'),
      { status: 401 }
    );
  }

  const idToken = authHeader.slice(7).trim();

  if (!idToken) {
    throw Object.assign(
      new Error('Empty token'),
      { status: 401 }
    );
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken, true); // checkRevoked = true
    return decoded.uid;
  } catch (err: any) {
    const msg =
      err.code === 'auth/id-token-revoked'  ? 'Token revoked'  :
      err.code === 'auth/id-token-expired'  ? 'Token expired'  :
      err.code === 'auth/argument-error'    ? 'Invalid token'  :
                                              'Token verification failed';

    throw Object.assign(new Error(msg), { status: 401 });
  }
}

// ─── Input Sanitization ───────────────────────────────────────────────────────

const SANITIZE_RULES = {
  tableId:     { type: 'string', maxLen: 50,     pattern: /^[a-zA-Z0-9_-]+$/,            },
  lobbyId:     { type: 'string', maxLen: 50,     pattern: /^[a-zA-Z0-9_-]+$/,            },
  name:        { type: 'string', maxLen: 30,     pattern: /^[\w\s\u0900-\u097F-]{1,30}$/ },
  action:      { type: 'string', maxLen: 20,     pattern: /^[a-zA-Z-]+$/,                },
  amount:      { type: 'number', min: 1,         max: 100000,                             },
  entryFee:    { type: 'number', min: 1,         max: 10000,                              },
  selectedFee:    { type: 'number', min: 1,         max: 10000,                              },
  buyIn:       { type: 'number', min: 1,         max: 100000,                             },
  raiseAmount: { type: 'number', min: 1,         max: 100000,                             },
  avatar:      { type: 'string', maxLen: 200, pattern: /^https?:\/\/.+$/, optional: true },
  displayName: { type: 'string', maxLen: 30, pattern: /^[\w\s\u0900-\u097F-]{1,30}$/, optional: true },
  photoURL:    { type: 'string', maxLen: 200, pattern: /^https?:\/\/.+$/, optional: true },
  bid:         { type: 'number', min: 1,    max: 13,                                     },
  isReady:     { type: 'string', maxLen: 5, pattern: /^(true|false)$/,                   },
  cardId: { type: 'string', maxLen: 2, pattern: /^[2-9TJQKA][cdhs]$/i, },

} as const;

type SanitizeKey = keyof typeof SANITIZE_RULES;

/**
 * sanitize — body fields validate karo
 *
 * Usage:
 *   sanitize(req.body, ['tableId', 'name']);
 *   sanitize(req.body, ['tableId', 'amount']);
 */
export function sanitize(body: any, fields: SanitizeKey[]): void {
  for (const field of fields) {
    const value = body?.[field];
    const rule  = SANITIZE_RULES[field];

    if (!rule) {
      console.error('[SANITIZE] Missing rule:', field);
      throw new Error(`Missing sanitize rule: ${field}`);
    }

    if (value === undefined || value === null)
      throw Object.assign(
        new Error(`Missing field: ${field}`),
        { status: 400 }
      );

    if (rule.type === 'string') {
      if (typeof value !== 'string')
        throw Object.assign(
          new Error(`Field ${field} must be a string`),
          { status: 400 }
        );

      if (value.trim().length === 0)
        throw Object.assign(
          new Error(`Field ${field} cannot be empty`),
          { status: 400 }
        );

      if (value.length > rule.maxLen)
        throw Object.assign(
          new Error(`Field ${field} too long (max ${rule.maxLen})`),
          { status: 400 }
        );

      if (!rule.pattern.test(value))
        throw Object.assign(
          new Error(`Field ${field} contains invalid characters`),
          { status: 400 }
        );
    }

    if (rule.type === 'number') {
      const num = typeof value === 'string' ? Number(value) : value;

      if (typeof num !== 'number' || isNaN(num) || !isFinite(num))
        throw Object.assign(
          new Error(`Field ${field} must be a valid number`),
          { status: 400 }
        );

      if (num < rule.min)
        throw Object.assign(
          new Error(`Field ${field} must be at least ${rule.min}`),
          { status: 400 }
        );

      if (num > rule.max)
        throw Object.assign(
          new Error(`Field ${field} must be at most ${rule.max}`),
          { status: 400 }
        );

      // Parsed number body mein replace karo — baad mein string parse na karna pade
      body[field] = num;
    }
  }
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

/**
 * setCors — request ka origin echo karo
 * NEXT_PUBLIC_APP_URL khali/unset → SAB origins allowed (security token check se hai)
 * NEXT_PUBLIC_APP_URL set (comma-separated) → sirf listed domains allowed
 */
export function setCors(req: VercelRequest, res: VercelResponse): void {
  const origin = (req.headers['origin'] as string) || '';
  const raw = process.env.VERCEL_API || '';
  const allowed = raw.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

  if (origin && (allowed.length === 0 || allowed.includes(origin.replace(/\/+$/, '')))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── withMiddleware — sab ek saath ────────────────────────────────────────────

export interface MiddlewareOptions {
  /** Body fields jo sanitize karne hain */
  sanitizeFields?: SanitizeKey[];
  /** true = CRON_SECRET check karo, false = Firebase token check karo */
  isCron?: boolean;
}

export async function withMiddleware(
  req:  VercelRequest,
  res:  VercelResponse,
  opts: MiddlewareOptions = {},
): Promise<string | null> {
  // CORS
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return null; }

  // Method check
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return null;
  }

  // Input sanitization
  if (opts.sanitizeFields?.length) {
    try {
      sanitize(req.body, opts.sanitizeFields);
    } catch (e: any) {
      res.status(e.status || 400).json({ error: e.message });
      return null;
    }
  }
}
