import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

function createAdminApp(): App {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY
    ?.replace(/^"|"$/g, '')
    .replace(/\\n/g, '\n');

  if (!projectId)   throw new Error('ENV_MISSING: FIREBASE_PROJECT_ID');
  if (!clientEmail) throw new Error('ENV_MISSING: FIREBASE_CLIENT_EMAIL');
  if (!privateKey)  throw new Error('ENV_MISSING: FIREBASE_PRIVATE_KEY');

  return getApps().length > 0
    ? getApps()[0]
    : initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}
const app = createAdminApp();
// Module-level singleton — Vercel warm instances mein re-use hoga
export const db = getFirestore(app);
export const auth = getAuth(app);
