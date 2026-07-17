// api/ludo/action.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomInt }                          from 'crypto';
import { FieldValue }                         from 'firebase-admin/firestore';
import { db }                                 from '../lib/firebaseAdmin';
import { internalWalletTransaction }          from '../lib/walletInternal';
import { verifyToken, sanitize, setCors }     from '../lib/middleware';
import {
  PlayerColor, Pawns,
  createInitialPawnState,
  canMovePawn, getMovablePawnIds, movePawn,
  checkCapture, sendPawnToStart, checkWinner, opponentColor,
  TOTAL_STEPS,
} from '../lib/ludoLogic';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const LUDO_TABLES      = 'ludoTables';
const LUDO_GAMES       = 'ludoGames';
const PAYOUT_RETRY_COL = 'payoutRetryQueue';

const CAPTURE_BONUS   = 20;
const CAPTURE_PENALTY = 20;
const FINISH_BONUS    = 10;
const TURN_DURATION   = 45;
const GAME_DURATION   = 300; // seconds — whole-game timer, must match the client's GAME_DURATION
const MAX_PLAYERS     = 2;
const COMMISSION_RATE = 0.10;

// ─────────────────────────────────────────────────────────────────────────────
// Payout Logic
//
// Tables are reused (cleanupTable resets them), so idempotency keys built only
// from tableId+uid collide across games — a repeat winner's payout would be
// silently swallowed as a "duplicate". Every key therefore includes the game's
// `round` (a counter on the table doc, bumped by cleanupTable and copied onto
// the game doc at start).
//
// The payoutDone flag is claimed inside a transaction BEFORE any money moves,
// so two racing requests (both players calling 'leave' at once, or a 'leave'
// racing a winning 'move') can never both pay out.
// ─────────────────────────────────────────────────────────────────────────────
const processPayout = async (
  tableId: string, winnerId: string | null, prizePool: number, isDraw: boolean,
  players: string[],
): Promise<void> => {
  const gameRef = db.collection(LUDO_GAMES).doc(tableId);

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) return null;
    const g = snap.data()!;
    if (g.payoutDone) return null;
    tx.update(gameRef, { payoutDone: true, paidWinnerId: winnerId ?? null, paidIsDraw: isDraw });
    return g;
  });
  if (!claimed) return; // someone else already claimed (or game doc gone) — nothing to do

  const round = (claimed.round ?? 0) as number;

  try {
    if (isDraw) {
      const half = Math.floor(prizePool / 2);
      await Promise.all(players.map((p) =>
        internalWalletTransaction({
          action:         'ADD',
          uid:            p,
          amount:         half,
          type:           'REFUND',
          game:           'Ludo',
          description:    `Ludo Draw ₹${half} - Table ${tableId}`,
          balanceType:    'depositBalance',
          idempotencyKey: `ludo_draw_${tableId}_r${round}_${p}`,
        })
      ));
    } else if (winnerId) {
      const commission   = Math.floor(prizePool * COMMISSION_RATE);
      const winnerAmount = prizePool - commission;
      await internalWalletTransaction({
        action:         'ADD',
        uid:            winnerId,
        amount:         winnerAmount,
        type:           'GAME_WIN',
        game:           'Ludo',
        description:    `Ludo Win ₹${winnerAmount} - Table ${tableId}`,
        balanceType:    'winningBalance',
        idempotencyKey: `ludo_win_${tableId}_r${round}_${winnerId}`,
      });
    }
  } catch (err) {
    console.error(`CRITICAL: Payout failed for table ${tableId}:`, err);
    // payoutDone stays true — the claim stands so no live request double-pays.
    // The retry worker drains this queue re-using the same idempotency keys.
    await db.collection(PAYOUT_RETRY_COL).add({
      kind: 'payout',
      tableId, round, winnerId, prizePool, isDraw, players,
      idempotencyKeys: isDraw
        ? players.map((p) => `ludo_draw_${tableId}_r${round}_${p}`)
        : [`ludo_win_${tableId}_r${round}_${winnerId}`],
      error:     err instanceof Error ? err.message : String(err),
      createdAt: FieldValue.serverTimestamp(),
      attempts:  1, resolved: false,
    }).catch(() => {});
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — runs after a successful payout so the table slot can be reused.
// Bumps `round` so the next game at this table gets fresh idempotency keys.
// ─────────────────────────────────────────────────────────────────────────────
const cleanupTable = async (tableId: string): Promise<void> => {
  const tableRef = db.collection(LUDO_TABLES).doc(tableId);
  const gameRef  = db.collection(LUDO_GAMES).doc(tableId);

  try {
    await gameRef.delete();
  } catch (err) {
    console.error(`[Ludo] cleanupTable: failed to delete game doc for ${tableId}:`, err);
  }

  try {
    await tableRef.update({
      status:        'waiting',
      players:       [],
      playerNames:   {},
      playerAvatars: {},
      prizePool:     0,
      round:         FieldValue.increment(1),
    });
  } catch (err) {
    console.error(`[Ludo] cleanupTable: failed to reset table doc for ${tableId}:`, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { type, ...body } = req.body ?? {};
  if (!type) { res.status(400).json({ ok: false, error: 'type required' }); return; }

  let uid = '';
  try {
    uid = await verifyToken(req);
  } catch (e: any) {
    return res.status(e.status || 401).json({ ok: false, error: e.message });
  }

  const { tableId } = body;

  try {
    switch (type) {
      // ── GET TABLES ────────────────────────────────────────────────────────
      case 'getTables': {
        const snap = await db.collection(LUDO_TABLES)
          .where('status', 'in', ['waiting', 'playing'])
          .orderBy('entryFee', 'asc')
          .get();

        const tables = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return res.status(200).json({ ok: true, tables });
      }

      // ── JOIN TABLE ────────────────────────────────────────────────────────
      case 'join': {
        sanitize(body, ['tableId', 'name', 'avatar']);
        const { name, avatar } = body;
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });
        // avatar is rendered by other clients — keep it a short string only
        const safeAvatar = typeof avatar === 'string' ? avatar.slice(0, 500) : '';

        const tableRef  = db.collection(LUDO_TABLES).doc(tableId);
        const tableSnap = await tableRef.get();
        if (!tableSnap.exists) return res.status(404).json({ ok: false, error: 'Table not found' });

        const table    = tableSnap.data()!;
        const players  = (table.players  || []) as string[];
        const entryFee = (table.entryFee || 0) as number;
        const round    = (table.round    || 0) as number;

        if (table.status !== 'waiting')
          return res.status(400).json({ ok: false, error: 'Game already started' });
        if (players.includes(uid))
          return res.status(200).json({ ok: true, alreadyJoined: true });
        if (players.length >= MAX_PLAYERS)
          return res.status(400).json({ ok: false, error: 'Table is full' });

        try {
          await internalWalletTransaction({
            action:         'DEDUCT',
            uid,
            amount:         entryFee,
            type:           'GAME_ENTRY',
            game:           'Ludo',
            description:    `Ludo Entry ₹${entryFee} - Table ${tableId}`,
            idempotencyKey: `ludo_join_${tableId}_r${round}_${uid}`,
          });
        } catch (walletErr: any) {
          return res.status(402).json({ ok: false, error: walletErr.message || 'Insufficient balance' });
        }

        try {
          await db.runTransaction(async (tx) => {
            const fresh = await tx.get(tableRef);
            const cur   = fresh.data()!;
            if ((cur.players || []).includes(uid))         throw new Error('ALREADY_JOINED');
            if (cur.status !== 'waiting')                  throw new Error('Game already started');
            if ((cur.round || 0) !== round)                throw new Error('Table was reset, please rejoin');
            if ((cur.players || []).length >= MAX_PLAYERS) throw new Error('TABLE_FULL');

            tx.update(tableRef, {
              players:                  FieldValue.arrayUnion(uid),
              [`playerNames.${uid}`]:   name,
              [`playerAvatars.${uid}`]: safeAvatar,
              prizePool:                FieldValue.increment(entryFee),
            });
          });
        } catch (txErr: any) {
          if (txErr.message === 'ALREADY_JOINED')
            return res.status(200).json({ ok: true, alreadyJoined: true });

          await internalWalletTransaction({
            action:         'ADD',
            uid,
            amount:         entryFee,
            type:           'REFUND',
            game:           'Ludo',
            description:    `Ludo Join Refund ₹${entryFee} - Table ${tableId}`,
            balanceType:    'depositBalance',
            idempotencyKey: `ludo_join_refund_${tableId}_r${round}_${uid}`,
          }).catch(console.error);

          return res.status(400).json({ ok: false, error: txErr.message === 'TABLE_FULL' ? 'Table is full' : txErr.message });
        }

        return res.status(200).json({ ok: true, alreadyJoined: false, entryFee });
      }

      // ── START ─────────────────────────────────────────────────────────────
      case 'start': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        const tableRef = db.collection(LUDO_TABLES).doc(tableId);
        const gameRef  = db.collection(LUDO_GAMES).doc(tableId);

        let result: any;
        try {
          result = await db.runTransaction(async (tx) => {
            const [tableSnap, gameSnap] = await Promise.all([tx.get(tableRef), tx.get(gameRef)]);
            if (!tableSnap.exists) throw new Error('Table not found');
            if (gameSnap.exists)   return { alreadyStarted: true };

            const table = tableSnap.data()!;
            if (table.status !== 'waiting') throw new Error('Table not in waiting state');

            const players: string[] = table.players || [];
            if (players.length !== MAX_PLAYERS) throw new Error('Need exactly 2 players');
            if (!players.includes(uid))
              throw Object.assign(new Error('Not a player at this table'), { status: 403 });

            // Randomize who is blue (blue moves first) — otherwise the first
            // joiner always gets the first-move advantage.
            const order = randomInt(0, 2) === 0 ? players : [players[1], players[0]];
            const colorOf: Record<string, PlayerColor> = {
              [order[0]]: 'blue',
              [order[1]]: 'green',
            };

            tx.set(gameRef, {
              tableId, status: 'playing', players,
              round:         table.round || 0,
              colorOf,
              playerNames:   table.playerNames   || {},
              playerAvatars: table.playerAvatars || {},
              pawns:            createInitialPawnState(),
              currentTurn:      'blue' as PlayerColor,
              diceValue:        null,
              diceRolled:       false,
              scores:           { blue: 0, green: 0 },
              turnStartedAt:    Date.now(),
              turnDuration:     TURN_DURATION,
              gameStartedAtMs:  Date.now(),
              gameDuration:     GAME_DURATION,
              prizePool:        table.prizePool || table.entryFee * players.length,
              entryFee:         table.entryFee,
              winnerId:         null,
              winnerColor:      null,
              isDraw:           false,
              startedAt:        FieldValue.serverTimestamp(),
              finishedAt:       null,
              payoutDone:       false,
            });
            tx.update(tableRef, { status: 'playing' });
            return { alreadyStarted: false, colorOf };
          });
        } catch (txErr: any) {
          return res.status(txErr.status || 400).json({ ok: false, error: txErr.message });
        }

        return res.status(200).json({ ok: true, ...result });
      }

      // ── ROLL ──────────────────────────────────────────────────────────────
      case 'roll': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        const gameRef = db.collection(LUDO_GAMES).doc(tableId);
        let result: any;
        try {
          result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(gameRef);
            if (!snap.exists) throw new Error('Game not found');
            const game = snap.data()!;

            if (game.status !== 'playing')  throw new Error('Game is not active');
            const myColor: PlayerColor | undefined = game.colorOf?.[uid];
            if (!myColor)                     throw new Error('Not a player in this game');
            if (game.currentTurn !== myColor) throw new Error('Not your turn');
            if (game.diceRolled)              throw new Error('Already rolled this turn');

            const diceValue = randomInt(1, 7);
            const pawns: Pawns = game.pawns;
            const movable = getMovablePawnIds(pawns[myColor], diceValue);

            if (movable.length === 0) {
              const nextTurn = opponentColor(myColor);
              tx.update(gameRef, {
                diceValue, diceRolled: true, lastRollNoMove: true,
                currentTurn: nextTurn, turnStartedAt: Date.now(),
              });
              return { diceValue, movable: [], turnPassed: true, nextTurn };
            }

            tx.update(gameRef, { diceValue, diceRolled: true, lastRollNoMove: false });
            return { diceValue, movable, turnPassed: false };
          });
        } catch (txErr: any) {
          return res.status(400).json({ ok: false, error: txErr.message });
        }
        return res.status(200).json({ ok: true, ...result });
      }

      // ── MOVE ──────────────────────────────────────────────────────────────
      case 'move': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        const pawnId = Number(body.pawnId);
        if (pawnId !== 0 && pawnId !== 1)
          return res.status(400).json({ ok: false, error: 'Invalid pawnId' });

        const gameRef = db.collection(LUDO_GAMES).doc(tableId);
        let result: any;
        try {
          result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(gameRef);
            if (!snap.exists) throw new Error('Game not found');
            const game = snap.data()!;

            if (game.status !== 'playing')  throw new Error('Game is not active');
            const myColor: PlayerColor | undefined = game.colorOf?.[uid];
            if (!myColor)                     throw new Error('Not a player in this game');
            if (game.currentTurn !== myColor) throw new Error('Not your turn');
            if (!game.diceRolled || game.diceValue == null) throw new Error('Roll the dice first');

            const dice: number = game.diceValue;
            const pawns: Pawns = game.pawns;
            const myPawn = pawns[myColor].find((p) => p.id === pawnId);
            if (!myPawn) throw new Error('Pawn not found');
            if (!canMovePawn(myPawn, dice)) throw new Error('This pawn cannot move with that roll');

            const moved = movePawn(myPawn, dice);
            const newMyPawns = pawns[myColor].map((p) => (p.id === pawnId ? moved : p)) as [typeof moved, typeof moved];
            let newPawns: Pawns = { ...pawns, [myColor]: newMyPawns };

            let captured = false;
            const cap = checkCapture(moved, newPawns);
            if (cap) {
              const oppColor = opponentColor(myColor);
              const resetPawn = sendPawnToStart(cap);
              const newOppPawns = newPawns[oppColor].map((p) => (p.id === cap.id ? resetPawn : p)) as [typeof resetPawn, typeof resetPawn];
              newPawns = { ...newPawns, [oppColor]: newOppPawns };
              captured = true;
            }

            const scores = { ...game.scores };
            scores[myColor] = (scores[myColor] || 0) + dice;
            if (captured) {
              scores[myColor] += CAPTURE_BONUS;
              const oppColor = opponentColor(myColor);
              scores[oppColor] = Math.max(0, (scores[oppColor] || 0) - CAPTURE_PENALTY);
            }
            if (moved.isFinished && moved.position === TOTAL_STEPS) {
              scores[myColor] += FINISH_BONUS;
            }

            const winnerColor = checkWinner(newPawns);
            const gotExtraTurn = dice === 6 || captured || moved.isFinished;

            if (winnerColor) {
              const winnerUid = Object.entries(game.colorOf).find(([, c]) => c === winnerColor)?.[0] ?? null;
              tx.update(gameRef, {
                pawns: newPawns, scores,
                status: 'finished',
                winnerColor, winnerId: winnerUid,
                isDraw: false, finishReason: 'all_pawns_home',
                diceRolled: false, diceValue: null,
                finishedAt: FieldValue.serverTimestamp(),
              });
              tx.update(db.collection(LUDO_TABLES).doc(tableId), { status: 'finished' });
              return {
                  pawns: newPawns, 
                  scores, 
                  captured, 
                  winnerColor, 
                  winnerId: winnerUid,
                  gameOver: true, 
                  prizePool: game.prizePool, 
                  players: game.players,
                  pawnJustFinished: moved.isFinished && myPawn.position !== TOTAL_STEPS,  // 🆕
              };
            }

            const nextTurn = gotExtraTurn ? myColor : opponentColor(myColor);
            tx.update(gameRef, {
              pawns: newPawns, scores,
              diceRolled: false, diceValue: null,
              currentTurn: nextTurn, turnStartedAt: Date.now(),
            });

            return { 
           pawns: newPawns, 
          scores, 
          captured, 
         nextTurn, 
         gameOver: false,
       pawnJustFinished: moved.isFinished && myPawn.position !== TOTAL_STEPS,  // 🆕
   };
          });
        } catch (txErr: any) {
          return res.status(400).json({ ok: false, error: txErr.message });
        }

        if (result.gameOver) {
          try {
            await processPayout(tableId, result.winnerId ?? null, result.prizePool ?? 0, false, result.players ?? []);
          } catch (err) {
            console.error('[Ludo] Payout failed:', err);
            return res.status(202).json({ ok: true, ...result, payoutStatus: 'pending' });
          }
          await cleanupTable(tableId).catch((err) => console.error('[Ludo] cleanup failed:', err));
          return res.status(200).json({ ok: true, ...result, payoutStatus: 'success' });
        }
        return res.status(200).json({ ok: true, ...result });
      }

      // ── TIMEOUT (game clock expired) ──────────────────────────────────────
      // Called by either client when the 5-minute game timer hits zero. The
      // server verifies the real elapsed time, so a malicious client can't end
      // the game early. Winner = higher score; equal scores = draw (both get
      // half the pool back). Idempotent: second caller gets alreadyFinished.
      case 'timeout': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        const gameRef = db.collection(LUDO_GAMES).doc(tableId);
        let result: any;
        try {
          result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(gameRef);
            if (!snap.exists) return { alreadyFinished: true };
            const game = snap.data()!;
            if (game.status !== 'playing') return { alreadyFinished: true };
            if (!game.colorOf?.[uid]) throw new Error('Not a player in this game');

            const startedMs  = (game.gameStartedAtMs || 0) as number;
            const durationMs = ((game.gameDuration || GAME_DURATION) as number) * 1000;
            // small 3s grace for clock skew between client tick and server check
            if (!startedMs || Date.now() - startedMs < durationMs - 3000)
              throw new Error('Game time is not over yet');

            const scores    = game.scores || {};
            const blueScore  = (scores.blue  || 0) as number;
            const greenScore = (scores.green || 0) as number;
            const isDraw = blueScore === greenScore;
            const winnerColor: PlayerColor | null = isDraw ? null : blueScore > greenScore ? 'blue' : 'green';
            const winnerId = winnerColor
              ? Object.entries(game.colorOf).find(([, c]) => c === winnerColor)?.[0] ?? null
              : null;

            tx.update(gameRef, {
              status: 'finished',
              winnerColor, winnerId, isDraw,
              finishReason: 'timeout',
              diceRolled: false, diceValue: null,
              finishedAt: FieldValue.serverTimestamp(),
            });
            tx.update(db.collection(LUDO_TABLES).doc(tableId), { status: 'finished' });
            return {
              alreadyFinished: false, winnerId, winnerColor, isDraw,
              prizePool: game.prizePool || 0, players: game.players || [],
            };
          });
        } catch (txErr: any) {
          return res.status(400).json({ ok: false, error: txErr.message });
        }

        if (result.alreadyFinished)
          return res.status(200).json({ ok: true, alreadyFinished: true });

        try {
          await processPayout(tableId, result.winnerId, result.prizePool, result.isDraw, result.players);
        } catch (err) {
          console.error('[Ludo] Timeout payout failed:', err);
          return res.status(202).json({ ok: true, ...result, payoutStatus: 'pending' });
        }
        await cleanupTable(tableId).catch((err) => console.error('[Ludo] cleanup failed:', err));
        return res.status(200).json({ ok: true, ...result, payoutStatus: 'success' });
      }

      // ── LEAVE ─────────────────────────────────────────────────────────────
      case 'leave': {
        sanitize(body, ['tableId']);
        if (!tableId) return res.status(400).json({ ok: false, error: 'tableId required' });

        const tableRef = db.collection(LUDO_TABLES).doc(tableId);
        const gameRef  = db.collection(LUDO_GAMES).doc(tableId);

        // Phase 1: decide what "leave" means right now, atomically. This kills
        // the races the old code had (double prizePool decrement on rapid
        // double-leave; both players leaving at once each crowning the other
        // winner and both getting paid).
        let decision: any;
        try {
          decision = await db.runTransaction(async (tx) => {
            const [tableSnap, gameSnap] = await Promise.all([tx.get(tableRef), tx.get(gameRef)]);
            if (!tableSnap.exists)
              throw Object.assign(new Error('Table not found'), { status: 404 });

            const table    = tableSnap.data()!;
            const entryFee = (table.entryFee || 0) as number;
            const players  = (table.players  || []) as string[];
            const round    = (table.round    || 0) as number;

            if (table.status === 'finished' || (gameSnap.exists && gameSnap.data()!.status === 'finished'))
              return { kind: 'alreadyFinished' };

            if (!players.includes(uid)) throw new Error('Not in this table');

            if (table.status === 'waiting') {
              const remaining = players.filter((p) => p !== uid);
              if (remaining.length === 0) {
                // Reset (don't delete) — tables are the lobby list, deleting
                // one removes it from getTables forever.
                tx.update(tableRef, {
                  status: 'waiting', players: [], playerNames: {}, playerAvatars: {},
                  prizePool: 0, round: FieldValue.increment(1),
                });
              } else {
                tx.update(tableRef, {
                  players:                  FieldValue.arrayRemove(uid),
                  [`playerNames.${uid}`]:   FieldValue.delete(),
                  [`playerAvatars.${uid}`]: FieldValue.delete(),
                  prizePool:                FieldValue.increment(-entryFee),
                });
              }
              return { kind: 'waitingRefund', entryFee, round };
            }

            if (table.status === 'playing') {
              if (!gameSnap.exists) {
                // Anomalous: table says playing but no game doc. Don't lose
                // anyone's money — finish the table and refund all entries.
                tx.update(tableRef, { status: 'finished' });
                return { kind: 'refundAll', entryFee, players, round };
              }
              const game        = gameSnap.data()!;
              const gamePlayers = (game.players || players) as string[];
              const winnerId    = gamePlayers.find((p) => p !== uid) ?? null;

              if (!winnerId) {
                tx.update(gameRef, {
                  status: 'finished', winnerId: null, winnerColor: null,
                  isDraw: false, finishReason: 'player_left',
                  finishedAt: FieldValue.serverTimestamp(), payoutDone: true,
                });
                tx.update(tableRef, { status: 'finished' });
                return { kind: 'refundAll', entryFee, players: [uid], round: game.round ?? round };
              }

              tx.update(gameRef, {
                status: 'finished', winnerId,
                winnerColor: game.colorOf?.[winnerId] ?? null,
                isDraw: false, finishReason: 'player_left',
                finishedAt: FieldValue.serverTimestamp(),
              });
              tx.update(tableRef, { status: 'finished' });
              return {
                kind: 'forfeit', winnerId,
                prizePool: (game.prizePool || table.prizePool || 0) as number,
                players: gamePlayers,
              };
            }

            throw new Error('Unhandled table status');
          });
        } catch (txErr: any) {
          return res.status(txErr.status || 400).json({ ok: false, error: txErr.message });
        }

        // Phase 2: money movement (idempotent) outside the transaction.
        if (decision.kind === 'alreadyFinished')
          return res.status(200).json({ ok: true, alreadyFinished: true });

        if (decision.kind === 'waitingRefund') {
          if (decision.entryFee > 0) {
            try {
              await internalWalletTransaction({
                action:         'ADD',
                uid,
                amount:         decision.entryFee,
                type:           'REFUND',
                game:           'Ludo',
                description:    `Ludo Refund ₹${decision.entryFee} - Table ${tableId}`,
                balanceType:    'depositBalance',
                idempotencyKey: `ludo_refund_waiting_${tableId}_r${decision.round}_${uid}`,
              });
            } catch (err) {
              console.error('[Ludo] Waiting refund failed:', err);
              await db.collection(PAYOUT_RETRY_COL).add({
                kind: 'refund', tableId, round: decision.round,
                uid, amount: decision.entryFee,
                idempotencyKeys: [`ludo_refund_waiting_${tableId}_r${decision.round}_${uid}`],
                error: err instanceof Error ? err.message : String(err),
                createdAt: FieldValue.serverTimestamp(), attempts: 1, resolved: false,
              }).catch(() => {});
              return res.status(202).json({ ok: true, refunded: 0, refundStatus: 'pending' });
            }
          }
          return res.status(200).json({ ok: true, refunded: decision.entryFee });
        }

        if (decision.kind === 'refundAll') {
          if (decision.entryFee > 0) {
            await Promise.all(decision.players.map((p: string) =>
              internalWalletTransaction({
                action:         'ADD',
                uid:            p,
                amount:         decision.entryFee,
                type:           'REFUND',
                game:           'Ludo',
                description:    `Ludo Refund (Game Aborted) ₹${decision.entryFee} - Table ${tableId}`,
                balanceType:    'depositBalance',
                idempotencyKey: `ludo_refund_abort_${tableId}_r${decision.round}_${p}`,
              }).catch(console.error)
            ));
          }
          await cleanupTable(tableId).catch((err) => console.error('[Ludo] cleanup failed:', err));
          return res.status(200).json({ ok: true, refunded: decision.entryFee });
        }

        // forfeit — opponent wins the pot
        try {
          await processPayout(tableId, decision.winnerId, decision.prizePool, false, decision.players);
        } catch (err) {
          console.error('[Ludo] Leave payout failed:', err);
          return res.status(202).json({ ok: true, winnerId: decision.winnerId, prizePool: decision.prizePool, payoutStatus: 'pending' });
        }
        await cleanupTable(tableId).catch((err) => console.error('[Ludo] cleanup failed:', err));
        return res.status(200).json({ ok: true, winnerId: decision.winnerId, prizePool: decision.prizePool, payoutStatus: 'success' });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown type: "${type}"` });
    }
  } catch (err: any) {
    console.error(`[ludo/${type}]`, err.message);
    const status = err?.status
      || (err.message?.includes('not found')     ? 404
        : err.message?.includes('Insufficient')  ? 402
        : err.message?.includes('Not your turn') ? 403
        : 500);
    return res.status(status).json({ ok: false, error: err.message || 'Internal server error' });
  }
}
