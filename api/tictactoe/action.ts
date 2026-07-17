// api/tictactoe/action.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue }                         from 'firebase-admin/firestore';
import { db }                                 from '../lib/firebaseAdmin';
import { internalWalletTransaction }          from '../lib/walletInternal';
import { verifyToken, sanitize, setCors }     from '../lib/middleware';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Types
// ─────────────────────────────────────────────────────────────────────────────
const TTT               = 'ticTacToeTables';
const PAYOUT_RETRY_COL  = 'payoutRetryQueue';
const TTT_COUNTER_PATH  = 'meta/tttCounter';

const ENTRY_FEES     = [10, 20, 50, 100, 200, 500] as const;
const WIN_MULTIPLIER = 0.90;
const DRAW_REFUND    = 0.95;
const TABLE_EXPIRY_MINS = 30;

type CellValue   = 'X' | 'O' | null;
type TTableStatus = 'WAITING' | 'PLAYING' | 'FINISHED' | 'CANCELLED';
type TPlayer     = 'X' | 'O';

interface TTTPlayer {
  uid:      string;
  userName: string;
  symbol:   TPlayer;
  joinedAt: FirebaseFirestore.Timestamp;
}

interface TTTTable {
  id:              string;
  tableNumber:     number;
  entryFee:        number;
  status:          TTableStatus;
  board:           CellValue[];
  players:         TTTPlayer[];
  currentTurn:     TPlayer;
  winner:          TPlayer | 'DRAW' | null;
  winLine:         number[] | null;
  hostUid:         string;
  guestUid:        string | null;
  prize:           number;
  settled:         boolean;
  payoutAttempted: boolean;
  createdAt:       FirebaseFirestore.Timestamp;
  updatedAt:       FirebaseFirestore.Timestamp;
  lastMoveAt:      FirebaseFirestore.Timestamp | null;
  expiresAt:       FirebaseFirestore.Timestamp;
  forfeitedBy?:    string;
  matchEndedAt?:   string;
  resetAt?:        string;
}

interface GameResult {
  winner:     TPlayer | 'DRAW' | null;
  line:       number[] | null;
  isFinished: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Win Lines
// ─────────────────────────────────────────────────────────────────────────────
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helpers
// ─────────────────────────────────────────────────────────────────────────────
const checkWinner = (board: CellValue[]): GameResult => {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { winner: board[a] as TPlayer, line: [...line], isFinished: true };
  }
  if (board.every((cell) => cell !== null))
    return { winner: 'DRAW', line: null, isFinished: true };
  return { winner: null, line: null, isFinished: false };
};

const validateEntryFee = (fee: number): void => {
  if (!(ENTRY_FEES as readonly number[]).includes(fee))
    throw new Error(`Invalid entry fee. Allowed: ${ENTRY_FEES.join(', ')}`);
};

const validateCellIndex = (index: number): void => {
  if (!Number.isInteger(index) || index < 0 || index > 8)
    throw new Error('Invalid cell index (0-8)');
};

// ─────────────────────────────────────────────────────────────────────────────
// Table Number — Atomic counter
// ─────────────────────────────────────────────────────────────────────────────
const getNextTableNumber = async (): Promise<number> => {
  const counterRef = db.doc(TTT_COUNTER_PATH);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next  = snap.exists ? (snap.data()!.count as number) + 1 : 1;
    tx.set(counterRef, { count: next });
    return next;
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Payout — via internalWalletTransaction (same as ludo/nine-card)
// ─────────────────────────────────────────────────────────────────────────────
const processPayout = async (tableId: string): Promise<void> => {
  const tableRef  = db.collection(TTT).doc(tableId);
  const tableSnap = await tableRef.get();
  if (!tableSnap.exists) return;

  const table = tableSnap.data() as TTTTable;
  if (table.payoutAttempted) return;

  await tableRef.update({ payoutAttempted: true });

  const pot = table.entryFee * 2;

  try {
    if (table.winner === 'DRAW') {
      const drawAmount = Math.floor(table.entryFee * DRAW_REFUND);
      for (const p of table.players) {
        await internalWalletTransaction({
          action:         'ADD',
          uid:            p.uid,
          amount:         drawAmount,
          type:           'REFUND',
          game: 'TicTacToe',
          balanceType:    'depositBalance',
          description:    `TicTacToe Draw ₹${drawAmount} - Table #${table.tableNumber}`,
          idempotencyKey: `ttt_draw_${tableId}_${p.uid}`,
        }).catch(console.error);
      }
    } else if (table.winner) {
      const winnerPlayer = table.players.find((p) => p.symbol === table.winner);
      if (winnerPlayer) {
        const winAmount = Math.floor(pot * WIN_MULTIPLIER);
        await internalWalletTransaction({
          action:         'ADD',
          uid:            winnerPlayer.uid,
          amount:         winAmount,
          type:           'GAME_WIN',
          game: 'TicTacToe',
          balanceType:    'winningBalance',
          description:    `TicTacToe Win ₹${winAmount} - Table #${table.tableNumber}`,
          idempotencyKey: `ttt_win_${tableId}_${winnerPlayer.uid}`,
        });
      }
    }

    await tableRef.update({ settled: true });
  } catch (err) {
    console.error(`CRITICAL: Payout failed for table ${tableId}:`, err);
    await db.collection(PAYOUT_RETRY_COL).add({
      tableId,
      winner:      table.winner,
      players:     table.players,
      entryFee:    table.entryFee,
      tableNumber: table.tableNumber,
      error:       err instanceof Error ? err.message : String(err),
      createdAt:   FieldValue.serverTimestamp(),
      attempts:    1,
      resolved:    false,
    }).catch(() => {});
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { type, ...body } = req.body ?? {};
  if (!type) { res.status(400).json({ ok: false, error: 'type required' }); return; }

  let uid = '';
  let userName = '';
  try {
    uid      = await verifyToken(req);
    userName = (body.userName ?? body.name ?? 'Player').toString().trim();
  } catch (e: any) {
    return res.status(e.status || 401).json({ ok: false, error: e.message });
  }

  
  const { tableId } = body;

  try {
    switch (type) {

      // ── MY-TABLE ──────────────────────────────────────────────────────────
      case 'my-table': {
        sanitize(body, ['tableId']);
        const [hostSnap, guestSnap] = await Promise.all([
          db.collection(TTT).where('hostUid', '==', uid).where('status', 'in', ['WAITING', 'PLAYING']).limit(1).get(),
          db.collection(TTT).where('guestUid', '==', uid).where('status', '==', 'PLAYING').limit(1).get(),
        ]);
        const docs = [...hostSnap.docs, ...guestSnap.docs];
        const d    = docs[0];
        return res.status(200).json({ ok: true, table: d ? { id: d.id, ...d.data() } : null });
      }

      // ── CREATE ────────────────────────────────────────────────────────────
      case 'create': {
        sanitize(body, ['selectedFee']);
        const entryFee = Number(body.selectedFee);
        validateEntryFee(entryFee);

        const existing = await db.collection(TTT)
          .where('hostUid', '==', uid)
          .where('status', 'in', ['WAITING', 'PLAYING'])
          .limit(1).get();
        if (!existing.empty)
          return res.status(409).json({ ok: false, error: 'You already have an active table. Finish or leave it first.' });

        const tableNumber = await getNextTableNumber();
        const expiresAt   = new Date(Date.now() + TABLE_EXPIRY_MINS * 60 * 1000);

        // ── Table create karo ─────────────────────────────────────────────
        let newTableId: string;
        try {
         const ref = await db.collection(TTT).add({
         tableNumber,
         entryFee,
         status:          'WAITING',
         board:           Array(9).fill(null),
         players:         [{ uid, userName, symbol: 'X', joinedAt: new Date() }],
         currentTurn:     'X',
         winner:          null,
         winLine:         null,
         hostUid:         uid,
         guestUid:        null,
         prize:           Math.floor(entryFee * 2 * WIN_MULTIPLIER),
         settled:         false,
         payoutAttempted: false,
         createdAt:       FieldValue.serverTimestamp(),
         updatedAt:       FieldValue.serverTimestamp(),
         lastMoveAt:      null,
         expiresAt:       expiresAt.toISOString(),
});
          newTableId = ref.id;
        } catch (e: any) {
             console.error('TTT create table error:', e.message); // ✅ log karo
             return res.status(500).json({ ok: false, error: 'Failed to create table' });
        }

        // ── Entry fee deduct ──────────────────────────────────────────────
        try {
          await internalWalletTransaction({
            action:         'DEDUCT',
            uid,
            amount:         entryFee,
            type:           'GAME_ENTRY',
            balanceType:    'depositBalance',
            game:           'TicTacToe',
            description:    `TicTacToe Entry ₹${entryFee} - Table #${tableNumber}`,
            idempotencyKey: `ttt_create_${newTableId}_${uid}`,
          });
        } catch (walletErr: any) {
          await db.collection(TTT).doc(newTableId).delete().catch(() => {});
          return res.status(402).json({ ok: false, error: walletErr.message || 'Insufficient balance' });
        }

        return res.status(200).json({ ok: true, tableId: newTableId, tableNumber });
      }

      // ── JOIN ──────────────────────────────────────────────────────────────
      case 'join': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        let entryFee = 0;
        let tableNumber = 0;

        try {
          await db.runTransaction(async (tx) => {
            const ref  = db.collection(TTT).doc(tableId);
            const snap = await tx.get(ref);

            if (!snap.exists) throw new Error('Table not found');
            const table = snap.data() as TTTTable;

            if (table.status !== 'WAITING')   throw new Error('Table is no longer open');
            if (table.hostUid === uid)         throw new Error('You cannot join your own table');
            if (table.players.some(p => p.uid === uid)) throw new Error('Already joined');
            if (table.players.length >= 2)    throw new Error('Table is full');
            if (table.expiresAt && new Date(table.expiresAt as any).getTime() < Date.now())
              throw new Error('This table has expired');

            entryFee    = table.entryFee;
            tableNumber = table.tableNumber;

            tx.update(ref, {
             status:    'PLAYING',
             guestUid:  uid,
             players:   [...table.players, { uid, userName, symbol: 'O', joinedAt: new Date() }],
             updatedAt: FieldValue.serverTimestamp(),
            });
          });
        } catch (txErr: any) {
          return res.status(400).json({ ok: false, error: txErr.message });
        }

        // ── Entry fee deduct ──────────────────────────────────────────────
        try {
          await internalWalletTransaction({
            action:         'DEDUCT',
            uid,
            amount:         entryFee,
            type:           'GAME_ENTRY',
            game: 'TicTacToe',
            description:    `TicTacToe Entry ₹${entryFee} - Table #${tableNumber}`,
            idempotencyKey: `ttt_join_${tableId}_${uid}`,
          });
        } catch (walletErr: any) {
          // Rollback — table wapas WAITING
          const ref  = db.collection(TTT).doc(tableId);
          const snap = await ref.get().catch(() => null);
          if (snap?.exists) {
            const t = snap.data() as TTTTable;
            await ref.update({
              status:    'WAITING',
              guestUid:  null,
              players:   t.players.filter(p => p.uid !== uid),
              updatedAt: FieldValue.serverTimestamp(),
            }).catch(e => console.error('CRITICAL: Join rollback failed:', e));
          }
          return res.status(402).json({ ok: false, error: walletErr.message || 'Insufficient balance' });
        }

        return res.status(200).json({ ok: true, tableId });
      }

      // ── LEAVE (host only, WAITING table) ─────────────────────────────────
      case 'leave': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        const ref  = db.collection(TTT).doc(tableId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'Table not found' });

        const table = snap.data() as TTTTable;
        if (table.status !== 'WAITING')
          return res.status(400).json({ ok: false, error: 'Game already started — use forfeit' });
        if (table.hostUid !== uid)
          return res.status(403).json({ ok: false, error: 'Only host can close a waiting table' });

        await ref.delete();

        try {
          await internalWalletTransaction({
            action:         'ADD',
            uid,
            amount:         table.entryFee,
            type:           'REFUND',
            game: 'TicTacToe',
            balanceType:    'depositBalance',
            description:    `TicTacToe Refund ₹${table.entryFee} - Table #${table.tableNumber}`,
            idempotencyKey: `ttt_cancel_${tableId}_${uid}`,
          });
        } catch (refundErr: any) {
          console.error('CRITICAL: Refund failed after table delete:', { uid, tableId, error: refundErr });
          await db.collection('pendingRefunds').add({
            uid, tableId, amount: table.entryFee, reason: 'host_leave',
            error: refundErr.message, createdAt: FieldValue.serverTimestamp(), resolved: false,
          }).catch(() => {});
          return res.status(500).json({ ok: false, error: 'Table closed but refund failed — support notified' });
        }

        return res.status(200).json({ ok: true });
      }

      // ── MOVE ──────────────────────────────────────────────────────────────
      case 'move': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });
        const cell = Number(body.cellIndex);
        validateCellIndex(cell);

        let gameResult: GameResult = { winner: null, line: null, isFinished: false };

        try {
          await db.runTransaction(async (tx) => {
            const ref  = db.collection(TTT).doc(tableId);
            const snap = await tx.get(ref);

            if (!snap.exists)                    throw new Error('Table not found');
            const table = snap.data() as TTTTable;
            if (table.status === 'FINISHED')     throw new Error('Game already finished');
            if (table.status !== 'PLAYING')      throw new Error('Game is not active');

            const playerSymbol = table.players.find(p => p.uid === uid)?.symbol;
            if (!playerSymbol)                   throw new Error('You are not a player in this game');
            if (table.currentTurn !== playerSymbol) throw new Error('Not your turn');
            if (table.board[cell] !== null)      throw new Error('Cell already taken');

            const newBoard  = [...table.board];
            newBoard[cell]  = playerSymbol;
            gameResult      = checkWinner(newBoard);
            const nextTurn: TPlayer = playerSymbol === 'X' ? 'O' : 'X';

            if (gameResult.isFinished) {
              tx.update(ref, {
                board:           newBoard,
                winner:          gameResult.winner,
                winLine:         gameResult.line,
                status:          'FINISHED',
                settled:         false,
                payoutAttempted: false,
                currentTurn:     nextTurn,
                updatedAt:       FieldValue.serverTimestamp(),
                lastMoveAt:      FieldValue.serverTimestamp(),
                matchEndedAt:    new Date().toISOString(),
                resetAt:         new Date(Date.now() + 15000).toISOString(),
              });
            } else {
              tx.update(ref, {
                board:       newBoard,
                currentTurn: nextTurn,
                updatedAt:   FieldValue.serverTimestamp(),
                lastMoveAt:  FieldValue.serverTimestamp(),
              });
            }
          });
        } catch (txErr: any) {
          return res.status(400).json({ ok: false, error: txErr.message });
        }

        if (gameResult.isFinished) {
          processPayout(tableId).catch(() => {});
        }

        return res.status(200).json({
          ok: true,
          winner:     gameResult.winner,
          line:       gameResult.line,
          isFinished: gameResult.isFinished,
        });
      }

      // ── FORFEIT ───────────────────────────────────────────────────────────
      case 'forfeit': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        try {
          await db.runTransaction(async (tx) => {
            const ref  = db.collection(TTT).doc(tableId);
            const snap = await tx.get(ref);

            if (!snap.exists) throw new Error('Table not found');
            const table = snap.data() as TTTTable;

            if (table.status !== 'PLAYING') throw new Error('Game is not active');
            if (!table.players.some(p => p.uid === uid)) throw new Error('You are not in this game');

            const forfeitingPlayer = table.players.find(p => p.uid === uid)!;
            const winningPlayer    = table.players.find(p => p.uid !== uid);
            if (!winningPlayer) throw new Error('Opponent not found');

            tx.update(ref, {
              status:          'FINISHED',
              winner:          winningPlayer.symbol,
              winLine:         null,
              settled:         false,
              payoutAttempted: false,
              forfeitedBy:     forfeitingPlayer.uid,
              updatedAt:       FieldValue.serverTimestamp(),
              matchEndedAt:    new Date().toISOString(),
              resetAt:         new Date(Date.now() + 15000).toISOString(),
            });
          });
        } catch (txErr: any) {
          return res.status(400).json({ ok: false, error: txErr.message });
        }

        processPayout(tableId).catch(() => {});
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown type: "${type}"` });
    }

  } catch (err: any) {
    console.error(`[tictactoe/${type}]`, err.message);
    const status = err?.status
      || (err.message?.includes('not found')    ? 404
        : err.message?.includes('Insufficient') ? 402
        : err.message?.includes('Not your turn') ? 403
        : 500);
    return res.status(status).json({ ok: false, error: err.message || 'Internal server error' });
  }
}
