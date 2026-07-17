// lib/walletInternal.ts
// ✅ Sirf server-side game APIs use karein — client ke paas yeh kabhi nahi aana chahiye
import { db as adminDb } from './firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';

interface WalletData {
  depositBalance:  number;
  winningBalance:  number;
  referralBalance: number;
  bonusBalance:    number;
  totalBalance:    number;
  [key: string]:   any;
}

// ✅ FIX 1: Missing commas in ALLOWED_TYPES array
const ALLOWED_TYPES = [
  'DEPOSIT', 'WINNING', 'REFERRAL', 'BONUS', 'BET_WIN', 'SPLIT_WIN', 'REDEEM_CODE',
  'GAME_BET', 'CASH_OUT', 'GAME_ENTRY', 'ADD_MONEY', 'GAME_WIN', 'BET_LOSS', 'REFUND', 'WITHDRAWAL',
];

// ✅ FIX 1: balanceType whitelist — arbitrary field set hone se rokta hai
const ALLOWED_BALANCE_TYPES = [
  'depositBalance', 'winningBalance', 'referralBalance', 'bonusBalance',
] as const;
type BalanceType = typeof ALLOWED_BALANCE_TYPES[number];

// ✅ Bonus conversion rate — magic number hataya, config mein rakha
const BONUS_CONVERSION_RATE = 0.01; // 1% of winning amount

function deductFromWallet(wallet: WalletData, amount: number) {
  let remaining       = amount;
  let depositBalance  = wallet.depositBalance  || 0;
  let winningBalance  = wallet.winningBalance  || 0;
  let referralBalance = wallet.referralBalance || 0;
  let bonusBalance    = wallet.bonusBalance    || 0;

  const d = Math.min(depositBalance,  remaining); depositBalance  -= d; remaining -= d;
  const w = Math.min(winningBalance,  remaining); winningBalance  -= w; remaining -= w;
  const r = Math.min(referralBalance, remaining); referralBalance -= r; remaining -= r;
  const b = Math.min(bonusBalance,    remaining); bonusBalance    -= b; remaining -= b;

  if (remaining > 0) return null;

  return {
    depositBalance,
    winningBalance,
    referralBalance,
    bonusBalance,
    totalBalance: depositBalance + winningBalance + referralBalance + bonusBalance,
  };
}

export interface WalletTransactionParams {
  action:         'ADD' | 'DEDUCT' | 'WITHDRAW' | 'ADDFUND';
  uid:            string;
  amount:         number;
  type?:          string;
  game?:          string;
  status?:        string;
  description?:   string;
  balanceType?:   string;
  idempotencyKey: string;
}

// ✅ Yeh function sirf server-to-server — koi bhi game API yahan se import kare
export async function internalWalletTransaction(
  params: WalletTransactionParams,
): Promise<{ success: boolean; duplicate: boolean }> {
  const { action, uid, amount, type, game, status, description, balanceType, idempotencyKey } = params;

  // ── Input Validation ────────────────────────────────────────────────────────
  if (!uid)
    throw new Error('uid required');
  if (!amount || typeof amount !== 'number' || amount <= 0)
    throw new Error('amount must be a positive number');
  if (!['ADD', 'DEDUCT', 'ADDFUND', 'WITHDRAW'].includes(action))
    throw new Error('Invalid action');
  if (!ALLOWED_TYPES.includes(type))
    throw new Error(`Invalid type: ${type}`);
  if (!idempotencyKey)
    throw new Error('idempotencyKey required');

  // ✅ FIX 1: balanceType validate karo — sirf allowed fields accept karo
  if (balanceType && !(ALLOWED_BALANCE_TYPES as readonly string[]).includes(balanceType))
    throw new Error(`Invalid balanceType: ${balanceType}`);

  const resolvedBalanceType = (balanceType as BalanceType) || null;

  const txId      = `idem_${idempotencyKey}`;
  const txRef     = adminDb.collection('transactions').doc(txId);
  const walletRef = adminDb.collection('wallets').doc(uid);

  let isDuplicate = false;

  await adminDb.runTransaction(async (tx) => {
    const [dupSnap, walletSnap] = await Promise.all([
      tx.get(txRef),
      tx.get(walletRef),
    ]);

    // ── Idempotency check ───────────────────────────────────────────────────
    if (dupSnap.exists) {
      isDuplicate = true;
      return;
    }

    if (!walletSnap.exists) throw new Error('Wallet not found');
    const wallet = walletSnap.data() as WalletData;

    // ── DEDUCT ──────────────────────────────────────────────────────────────
    if (action === 'DEDUCT') {
      const nb = deductFromWallet(wallet, amount);
      if (!nb) throw new Error('Insufficient balance');
      tx.update(walletRef, { ...nb, updatedAt: FieldValue.serverTimestamp() });

      // ── WITHDRAW ────────────────────────────────────────────────────────────
    } else if (action === 'WITHDRAW') {
  const targetField: BalanceType = resolvedBalanceType || 'winningBalance';
  const current = wallet[targetField] || 0;

  if (amount < 100) {
    throw new Error('Minimum withdrawal amount is ₹100');
  }

  if (current < amount) {
    throw new Error('Insufficient balance');
  }

  tx.update(walletRef, {
    [targetField]: FieldValue.increment(-amount),
    totalBalance: FieldValue.increment(-amount),
    updatedAt: FieldValue.serverTimestamp(),
  });

    // ── ADDFUND ────────────────────────────────────────────────────────────
    } else if (action === 'ADDFUND') {
      if (amount < 50) {
    throw new Error('Minimum add amount is ₹50');
  }

    // ── ADD ─────────────────────────────────────────────────────────────────
    } else if (action === 'ADD') {
  const targetField: BalanceType = resolvedBalanceType || 'winningBalance';

  if (targetField === 'winningBalance') {
    let bonusBalance = wallet.bonusBalance || 0;
    let depositBalance = wallet.depositBalance || 0;
    const winningBalance = (wallet.winningBalance || 0) + amount;

    const conversionAmount = Math.floor(amount * BONUS_CONVERSION_RATE);

    if (conversionAmount > 0 && bonusBalance > 0) {
      const actual = Math.min(conversionAmount, bonusBalance);
      bonusBalance -= actual;
      depositBalance += actual;
    }

    tx.update(walletRef, {
      depositBalance,
      winningBalance,
      bonusBalance,
      totalBalance:
        depositBalance +
        winningBalance +
        bonusBalance +
        (wallet.referralBalance || 0),
      updatedAt: FieldValue.serverTimestamp(),
    });

  } else {

    tx.update(walletRef, {
      [targetField]: FieldValue.increment(amount),
      totalBalance: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp(),
    });

  }
}
    // ── Transaction record save karo ────────────────────────────────────────
    tx.set(txRef, {
      uid,
      type,
      action,
      amount:         action === 'DEDUCT' ? -Math.abs(amount) : Math.abs(amount),
      status:         status || 'COMPLETED',
      game: game ?? "poker",
      description:    description || '',
      balanceType:    resolvedBalanceType || '',
      idempotencyKey,
      createdAt:      FieldValue.serverTimestamp(),
    });
  });

  return { success: true, duplicate: isDuplicate };
}


// Only Game win & loss record
export async function betHistory(
  params: WalletTransactionParams,
): Promise<{ success: boolean; duplicate: boolean }> {
  const {
    action,
    uid,
    amount,
    type,
    game,
    status,
    description,
    idempotencyKey,
  } = params;

  const txId = `idem_${idempotencyKey}`;
  const txRef = adminDb.collection('bethistory').doc(txId);

  let isDuplicate = false;

  await adminDb.runTransaction(async (tx) => {
    const dupSnap = await tx.get(txRef);

    if (dupSnap.exists) {
      isDuplicate = true;
      return;
    }

    tx.set(txRef, {
      uid,
      type,
      action,
      amount: action === 'DEDUCT' ? -Math.abs(amount) : Math.abs(amount),
      status: status || 'COMPLETED',
      game,
      description: description || '',
      idempotencyKey,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true, duplicate: isDuplicate,
  };
}
