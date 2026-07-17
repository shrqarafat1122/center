// api/joker-pair/[action].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomInt }                          from 'crypto';
import { db }                                 from '../lib/firebaseAdmin';
import { FieldValue }                         from 'firebase-admin/firestore';
import { internalWalletTransaction }          from '../lib/walletInternal';
import { verifyToken, sanitize }              from '../lib/middleware';

// ─── Types + Helpers ─────────────────────────────────────────────────────────
interface GameCard    { id: string; rank: string; suit: string; }
interface PlayerGroup { cards: [string, string]; }

const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = ['h','d','c','s'];

function buildDeck(): GameCard[] {
  const deck: GameCard[] = [];
  for (const rank of RANKS)
    for (const suit of SUITS)
      deck.push({ id: `${rank}${suit}`, rank, suit });
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isValidPair(a: string, b: string, jokerRank: string | null, deck: GameCard[]) {
  const map = Object.fromEntries(deck.map((c) => [c.id, c]));
  const ca = map[a], cb = map[b];
  if (!ca || !cb) return false;
  if (ca.rank === cb.rank) return true;
  if (jokerRank && (ca.rank === jokerRank || cb.rank === jokerRank)) return true;
  return false;
}

function validateDeclare(
  hand: string[], groups: PlayerGroup[],
  jokerRank: string | null, deck: GameCard[],
) {
  if (hand.length !== 6)   return { valid: false, reason: 'Hand must have 6 cards' };
  if (groups.length !== 3) return { valid: false, reason: 'Need 3 pairs' };
  const used = new Set<string>();
  for (const grp of groups) {
    if (!grp.cards || grp.cards.length !== 2)
      return { valid: false, reason: 'Each group needs 2 cards' };
    const [ca, cb] = grp.cards;
    if (used.has(ca) || used.has(cb)) return { valid: false, reason: 'Duplicate card' };
    if (!hand.includes(ca) || !hand.includes(cb))
      return { valid: false, reason: 'Card not in hand' };
    if (!isValidPair(ca, cb, jokerRank, deck))
      return { valid: false, reason: `Invalid pair: ${ca}+${cb}` };
    used.add(ca); used.add(cb);
  }
  return { valid: true };
}

function nextTurn(players: string[], currentIndex: number) {
  const nextIndex = (currentIndex + 1) % players.length;
  return { currentTurnIndex: nextIndex, currentTurnUid: players[nextIndex], turnStartedAt: Date.now() };
}

// ─── Payout Helper ────────────────────────────────────────────────────────────
async function processPayout(tableId: string, winnerId: string, winnerAmount: number, prizePool: number) {
  const gameRef = db.collection('jokerPairGames').doc(tableId);
  try {
    await internalWalletTransaction({
      action:         'ADD',
      uid:            winnerId,
      amount:         winnerAmount,
      type:           'GAME_WIN',
      game:           'JokerPair',
      description:    `Joker Pair win - ₹${prizePool} - Table ${tableId}`,
      balanceType:    'winningBalance',
      idempotencyKey: `jp_win_${tableId}_${winnerId}`,
    });
    await gameRef.update({ payoutDone: true });
  } catch (e) {
    console.error('[PAYOUT FAILED] Manual intervention needed:', {
      tableId, winnerId, winnerAmount, error: e,
    });
    throw e;
  }
}

// ─── JOIN ─────────────────────────────────────────────────────────────────────
async function handleJoin(req: VercelRequest, res: VercelResponse, uid: string) {
  sanitize(req.body, ['tableId', 'name']);

  const { tableId, name, avatar } = req.body;
  const tableRef  = db.collection('jokerPairTables').doc(tableId);
  const tableSnap = await tableRef.get();
  if (!tableSnap.exists) return res.status(404).json({ error: 'Table not found' });

  const table      = tableSnap.data()!;
  const players    = (table.players  || []) as string[];
  const maxPlayers = (table.maxPlayers || 4) as number;
  const entryFee   = (table.entryFee  || 0) as number;

  if (table.status !== 'waiting')
    return res.status(400).json({ error: 'Game already started' });
  if (players.includes(uid))
    return res.status(200).json({ success: true, alreadyJoined: true });
  if (players.length >= maxPlayers)
    return res.status(400).json({ error: 'Table is full' });

  // Unique key per join attempt — static key exploit hota tha: join → leave
  // (refund) → dobara join pe DEDUCT duplicate banta (paisa katta nahi) lekin
  // player game mein aa jata = free entry
  const joinTs = Date.now();

  const deductResult = await internalWalletTransaction({
    action:         'DEDUCT',
    uid,
    amount:         entryFee,
    type:           'GAME_ENTRY',
    game:           'JokerPair',
    description:    `Joker Pair entry - Table ${tableId}`,
    idempotencyKey: `jp_join_${tableId}_${uid}_${joinTs}`,
  });

  // Duplicate = paisa deduct NAHI hua — bina payment ke game mein entry mat do
  if (deductResult.duplicate)
    return res.status(409).json({ error: 'Duplicate join request, try again' });

  try {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(tableRef);
      const cur   = fresh.data()!;
      if ((cur.players || []).includes(uid))        throw new Error('ALREADY_JOINED');
      if ((cur.players || []).length >= maxPlayers) throw new Error('TABLE_FULL');

      tx.update(tableRef, {
        players:                  FieldValue.arrayUnion(uid),
        [`playerNames.${uid}`]:   name,
        [`playerAvatars.${uid}`]: avatar || '',
        prizePool:                FieldValue.increment(entryFee),
      });
    });
  } catch (e: any) {
    if (e.message === 'ALREADY_JOINED')
      return res.status(200).json({ success: true, alreadyJoined: true });

    await internalWalletTransaction({
      action:         'ADD',
      uid,
      amount:         entryFee,
      type:           'REFUND',
      game:           'JokerPair',
      description:    `Joker Pair join refund - Table ${tableId}`,
      balanceType:    'depositBalance',
      idempotencyKey: `jp_join_refund_${tableId}_${uid}_${joinTs}`,
    }).catch(console.error);

    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({ success: true, alreadyJoined: false, entryFee });
}

// ─── START ────────────────────────────────────────────────────────────────────
async function handleStart(req: VercelRequest, res: VercelResponse, uid: string) {
  sanitize(req.body, ['tableId']);
  const { tableId } = req.body;

  const tableRef = db.collection('jokerPairTables').doc(tableId);
  const gameRef  = db.collection('jokerPairGames').doc(tableId);

  const result = await db.runTransaction(async (tx) => {
    const [tableSnap, gameSnap] = await Promise.all([tx.get(tableRef), tx.get(gameRef)]);
    if (!tableSnap.exists) throw new Error('Table not found');
    if (gameSnap.exists)   return { alreadyStarted: true };

    const table = tableSnap.data()!;
    if (table.status !== 'waiting') throw new Error('Table not in waiting state');

    const players: string[] = table.players || [];
    if (players.length < 2) throw new Error('Need at least 2 players');
    if (!players.includes(uid))
      throw Object.assign(new Error('Not a player at this table'), { status: 403 });

    const shuffled  = shuffle(buildDeck());
    const jokerCard = shuffled[0];
    const remaining = shuffled.slice(1);

    // SECURITY: hands/drawPile ab main doc mein NAHI jaate — client us doc
    // pe subscribe karta hai, pehle opponent ke cards + poora deck dikh jata
    // tha. Ab: main doc = public state (counts), private/{uid} = apna hand,
    // private/_server = draw pile (sirf server padhta hai).
    const playerMeta: Record<string, any> = {};
    let cardIdx = 0;
    for (const p of players) {
      const hand = remaining.slice(cardIdx, cardIdx + 5).map((c) => c.id);
      tx.set(gameRef.collection('private').doc(p), { hand, groups: [] });
      playerMeta[p] = {
        uid:       p,
        name:      table.playerNames?.[p] || 'Player',
        avatar:    table.playerAvatars?.[p] || '',
        handCount: hand.length,
        hasActed:  false,
      };
      cardIdx += 5;
    }

    const drawPile = remaining.slice(cardIdx).map((c) => c.id);
    tx.set(gameRef.collection('private').doc('_server'), { drawPile });

    tx.set(gameRef, {
      tableId, status: 'playing', players,
      playerData:       playerMeta,   // public meta only — no hands
      drawCount:        drawPile.length,
      discardPile:      [],
      jokerCard,
      jokerRank:        jokerCard.rank,
      currentTurnIndex: 0,
      currentTurnUid:   players[0],
      turnStartedAt:    Date.now(),
      turnDuration:     60,
      prizePool:        table.prizePool || table.entryFee * players.length,
      entryFee:         table.entryFee,
      winnerId:         null,
      winnerGroups:     null,
      startedAt:        FieldValue.serverTimestamp(),
      finishedAt:       null,
      payoutDone:       false,
    });
    tx.update(tableRef, { status: 'playing' });
    return { alreadyStarted: false, jokerRank: jokerCard.rank };
  });

  return res.status(200).json({ success: true, ...result });
}

// ─── ACTION ───────────────────────────────────────────────────────────────────
async function handleAction(req: VercelRequest, res: VercelResponse, uid: string) {
  sanitize(req.body, ['tableId', 'action']);
  const { tableId, action, payload } = req.body;

  if (action === 'discard') sanitize(payload || {}, ['cardId']);

  const validActions = ['pickDraw', 'pickDiscard', 'discard', 'declare', 'updateGroups'];
  if (!validActions.includes(action))
    throw Object.assign(new Error('Invalid action'), { status: 400 });

  const gameRef   = db.collection('jokerPairGames').doc(tableId);
  // Private docs: apna hand yahan hai (main doc mein sirf counts)
  const myPrivRef = gameRef.collection('private').doc(uid);
  const srvRef    = gameRef.collection('private').doc('_server');
  const FULL_DECK = buildDeck();

  // ── updateGroups: alag transaction — turn check nahi hota ──────────────────
  if (action === 'updateGroups') {
    if (!Array.isArray(payload?.groups))
      throw Object.assign(new Error('Invalid groups'), { status: 400 });

    await db.runTransaction(async (tx) => {
      const [snap, privSnap] = await Promise.all([tx.get(gameRef), tx.get(myPrivRef)]);
      if (!snap.exists)
        throw Object.assign(new Error('Game not found'), { status: 404 });

      const game = snap.data()!;
      if (game.status !== 'playing')
        throw Object.assign(new Error('Game is not active'), { status: 400 });
      if (!game.players.includes(uid) || !privSnap.exists)
        throw Object.assign(new Error('Not a player in this game'), { status: 403 });

      // Groups private doc mein — opponent inse hand ke cards infer kar leta
      tx.update(myPrivRef, { groups: payload.groups });
    });

    return res.status(200).json({ success: true });
  }

  // ── All other actions: single transaction ──────────────────────────────────
  const result = await db.runTransaction(async (tx) => {
    const [snap, privSnap, srvSnap] = await Promise.all([
      tx.get(gameRef), tx.get(myPrivRef), tx.get(srvRef),
    ]);
    if (!snap.exists) throw new Error('Game not found');
    const game = snap.data()!;

    if (game.status !== 'playing')   throw new Error('Game is not active');
    if (game.currentTurnUid !== uid) throw new Error('Not your turn');

    if (action === 'declare' && game.payoutDone)
      return { valid: true, action: 'declare', alreadyPaid: true, winnerId: game.winnerId };

    if (!privSnap.exists) throw new Error('Player not found');
    const priv = privSnap.data()!;
    const hand: string[] = [...(priv.hand || [])];
    const playerData = { ...game.playerData };

    // ── pickDraw ──────────────────────────────────────────────────────────────
    if (action === 'pickDraw') {
      if (hand.length !== 5) throw new Error('Already picked a card this turn');
      let drawPile: string[] = [...(srvSnap.data()?.drawPile || [])];
      let discardPile: string[] = [...(game.discardPile || [])];

      // Draw pile khali? Discard pile (top card chhod ke) shuffle karke naya
      // draw pile banao — pehle yahan error aata tha aur game atak jata tha
      if (drawPile.length === 0) {
        if (discardPile.length <= 1) throw new Error('No cards left to draw');
        const top   = discardPile.pop()!;
        drawPile    = shuffle(discardPile);
        discardPile = [top];
      }

      const pickedId = drawPile.pop()!;
      tx.update(srvRef, { drawPile });
      tx.update(myPrivRef, { hand: [...hand, pickedId] });
      tx.update(gameRef, {
        drawCount: drawPile.length,
        discardPile,
        [`playerData.${uid}.handCount`]: hand.length + 1,
      });
      return { action: 'pickDraw', cardId: pickedId };
    }

    // ── pickDiscard ───────────────────────────────────────────────────────────
    if (action === 'pickDiscard') {
      if (hand.length !== 5)             throw new Error('Already picked a card this turn');
      if (game.discardPile.length === 0) throw new Error('Discard pile is empty');

      const discardPile = [...game.discardPile];
      const pickedId    = discardPile.pop()!;
      tx.update(myPrivRef, { hand: [...hand, pickedId] });
      tx.update(gameRef, {
        discardPile,
        [`playerData.${uid}.handCount`]: hand.length + 1,
      });
      return { action: 'pickDiscard', cardId: pickedId };
    }

    // ── discard ───────────────────────────────────────────────────────────────
    if (action === 'discard') {
      const cardId: string = payload?.cardId;
      if (!cardId)                throw new Error('Missing cardId');
      if (hand.length !== 6)      throw new Error('Pick a card before discarding');
      if (!hand.includes(cardId)) throw new Error('Card not in hand');

      const newHand     = hand.filter((c) => c !== cardId);
      const discardPile = [...game.discardPile, cardId];
      const turn        = nextTurn(game.players, game.currentTurnIndex);

      tx.update(myPrivRef, { hand: newHand, groups: [] });
      tx.update(gameRef, {
        discardPile,
        [`playerData.${uid}.handCount`]: newHand.length,
        [`playerData.${uid}.hasActed`]:  true,
        [`playerData.${uid}.missedTurns`]: 0, // manual action = reset missed
        ...turn,
      });
      return { action: 'discard', cardId, nextTurnUid: turn.currentTurnUid };
    }

    // ── declare ───────────────────────────────────────────────────────────────
    if (action === 'declare') {
      if (hand.length !== 6) throw new Error('Pick a card before declaring');

      const groups     = (priv.groups || []) as PlayerGroup[];
      const validation = validateDeclare(hand, groups, game.jokerRank, FULL_DECK);
      if (!validation.valid) return { valid: false, reason: validation.reason };

      const prizePool    = game.prizePool as number;
      const commission   = Math.floor(prizePool * 0.1);
      const winnerAmount = prizePool - commission;

      tx.update(gameRef, {
        status:      'finished',
        winnerId:    uid,
        winnerGroups: groups,   // finish pe reveal karna theek hai
        finishedAt:  FieldValue.serverTimestamp(),
        payoutDone:  false,
      });
      tx.update(db.collection('jokerPairTables').doc(tableId), { status: 'finished' });

      return { valid: true, action: 'declare', winnerId: uid, winnerAmount, prizePool };
    }

    void playerData;
    throw new Error(`Unknown action: ${action}`);
  });

  // ── Payout (declare ke baad, transaction ke bahar) ────────────────────────
  const r = result as {
    action?:      string;
    valid?:       boolean;
    alreadyPaid?: boolean;
    winnerId?:    string;
    winnerAmount?: number;
    prizePool?:   number;
  };

 // ── Payout ke baad naya table create karo ────────────────────────────────
if (r.action === 'declare' && r.valid && !r.alreadyPaid) {
  
  try {
    await processPayout(tableId, r.winnerId!, r.winnerAmount!, r.prizePool!);
  } catch (err) {
    console.error('[JokerPair] Payout failed:', err);
    return res.status(202).json({
      success:      true,
      ...r,
      payoutStatus: 'pending',
      message:      'Win recorded; payout processing — will retry automatically',
    });
  }

  // ── 2. Payout success → naya table banao ──────────────────────────────
  let newTableId: string | null = null;

  try {
    const originalTableSnap = await db
      .collection('jokerPairTables')
      .doc(tableId)
      .get();

    const originalTable = originalTableSnap.data();
    const entryFee      = (originalTable?.entryFee   ?? 0) as number;
    const maxPlayers    = (originalTable?.maxPlayers  ?? 2) as number;

    const newTableRef = db.collection('jokerPairTables').doc(); // auto ID
    newTableId        = newTableRef.id;

    await newTableRef.set({
      entryFee,                                    // same as original
      maxPlayers,                                  // same as original
      hostId:        null,                         // screenshot mein null tha
      players:       [],                           // koi nahi
      playerNames:   {},                           // empty
      playerAvatars: {},                           // empty
      prizePool:     0,                            // 0 se shuru
      status:        'waiting',                    // waiting
      createdAt:     FieldValue.serverTimestamp(), // ab ka time
      updatedAt:     FieldValue.serverTimestamp(), // ab ka time
    });

    console.log('[JokerPair] New table created:', newTableId);

  } catch (err) {
    console.error('[JokerPair] New table creation failed:', err);
    // newTableId null rahega
  }

  return res.status(200).json({
    success:      true,
    ...r,
    payoutStatus: 'success',
    newTableId,                   // client ko bata do
  });
}

return res.status(200).json({ success: true, ...result });
}
// ─── LEAVE ────────────────────────────────────────────────────────────────────
async function handleLeave(req: VercelRequest, res: VercelResponse, uid: string) {
  sanitize(req.body, ['tableId']);
  const { tableId } = req.body;

  const tableRef = db.collection('jokerPairTables').doc(tableId);
  const gameRef  = db.collection('jokerPairGames').doc(tableId);

  const [tableSnap, gameSnap] = await Promise.all([tableRef.get(), gameRef.get()]);
  if (!tableSnap.exists) return res.status(404).json({ error: 'Table not found' });

  const table    = tableSnap.data()!;
  const entryFee = (table.entryFee || 0) as number;
  const players  = (table.players  || []) as string[];

  // ── Already finished guards ──────────────────────────────────────────────
  if (table.status === 'finished')
    return res.status(200).json({ success: true, alreadyFinished: true });

  if (gameSnap.exists && gameSnap.data()?.payoutDone)
    return res.status(200).json({ success: true, alreadyFinished: true, alreadyPaid: true });

  // ── WAITING → simple refund & remove ────────────────────────────────────
  if (table.status === 'waiting') {
    if (!players.includes(uid))
      return res.status(400).json({ error: 'Not in this table' });

    // PEHLE atomically remove karo, refund BAAD mein — warna do rapid leave
    // calls dono refund kara sakti thin (double refund race)
    const removed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(tableRef);
      if (!fresh.exists) return false;
      const cur = fresh.data()!;
      if (cur.status !== 'waiting') return false;
      const curPlayers = (cur.players || []) as string[];
      if (!curPlayers.includes(uid)) return false;

      const remaining = curPlayers.filter((p) => p !== uid);
      if (remaining.length === 0) {
        tx.delete(tableRef);
      } else {
        tx.update(tableRef, {
          players:                  FieldValue.arrayRemove(uid),
          [`playerNames.${uid}`]:   FieldValue.delete(),
          [`playerAvatars.${uid}`]: FieldValue.delete(),
          prizePool:                FieldValue.increment(-entryFee),
        });
      }
      return true;
    });

    if (!removed)
      return res.status(400).json({ error: 'Not in this table' });

    if (entryFee > 0) {
      try {
        await internalWalletTransaction({
          action:         'ADD',
          uid,
          amount:         entryFee,
          type:           'REFUND',
          game:           'JokerPair',
          description:    `Joker Pair refund - Table ${tableId}`,
          balanceType:    'depositBalance',
          idempotencyKey: `jp_refund_waiting_${tableId}_${uid}_${Date.now()}`,
        });
      } catch (refundErr: any) {
        console.error('CRITICAL: JokerPair leave refund failed:', { uid, tableId, error: refundErr });
        await db.collection('pendingRefunds').add({
          uid, tableId, amount: entryFee, game: 'JokerPair', reason: 'leave_waiting',
          error: refundErr?.message || '', createdAt: FieldValue.serverTimestamp(), resolved: false,
        }).catch(() => {});
        return res.status(500).json({ error: 'Left table but refund failed — support notified' });
      }
    }

    return res.status(200).json({ success: true, refunded: entryFee });
  }

  // ── PLAYING → leaver loses, opponent wins ────────────────────────────────
  if (table.status === 'playing') {
    if (!players.includes(uid))
      return res.status(400).json({ error: 'Not in this table' });

    // Opponent = jo uid nahi hai
    const winnerId = players.find((p) => p !== uid) ?? null;

    if (!winnerId) {
      // Edge case: sirf ek player tha (shouldn't happen), refund karo
      if (entryFee > 0) {
        await internalWalletTransaction({
          action:         'ADD',
          uid,
          amount:         entryFee,
          type:           'REFUND',
          game:           'JokerPair',
          description:    `Joker Pair refund (no opponent) - Table ${tableId}`,
          balanceType:    'depositBalance',
          idempotencyKey: `jp_refund_noop_${tableId}_${uid}`,
        });
      }

      // Game doc ho to finished mark karo, table bhi — pehle yahan broken
      // batch code tha (empty update crash karta: "must not be empty")
      const noopBatch = db.batch();
      if (gameSnap.exists) {
        noopBatch.update(gameRef, {
          status:       'finished',
          finishedAt:   FieldValue.serverTimestamp(),
          finishReason: 'no_opponent',
        });
      }
      noopBatch.update(tableRef, { status: 'finished' });
      await noopBatch.commit();

      return res.status(200).json({ success: true, refunded: entryFee });
    }

    // ── Prize calculation ──────────────────────────────────────────────────
    const prizePool    = (table.prizePool || 0) as number;   // e.g. 200
    const platformFee  = Math.floor(prizePool * 0.10);        // 10% cut
    const winnerPrize  = prizePool - platformFee;             // 90% to winner

    // ── Firestore batch: game + table finish ───────────────────────────────
    const batch = db.batch();

    if (gameSnap.exists) {
      batch.update(gameRef, {
        status:         'finished',
        finishedAt:     FieldValue.serverTimestamp(),
        winnerId,
        loserId:        uid,                  // jo leave kiya
        finishReason:   'player_left',
        payoutDone:     false,                // wallet transaction ke baad true karenge
      });
    } else {
      // Game doc nahi tha, create karo
      batch.set(gameRef, {
        tableId,
        players,
        status:         'finished',
        finishedAt:     FieldValue.serverTimestamp(),
        winnerId,
        loserId:        uid,
        finishReason:   'player_left',
        payoutDone:     false,
      });
    }

    batch.update(tableRef, { status: 'finished' });
    await batch.commit();

    // ── Winner ko prize do ─────────────────────────────────────────────────
    if (winnerPrize > 0) {
      try {
        await internalWalletTransaction({
          action:         'ADD',
          uid:            winnerId,
          amount:         winnerPrize,
          type:           'GAME_WIN',
          game:           'JokerPair',
          description:    `Joker Pair win (opponent left) - Table ${tableId}`,
          balanceType:    'winningBalance',
          idempotencyKey: `jp_win_leave_${tableId}_${winnerId}`,
        });

        // payoutDone = true mark karo
        await gameRef.update({ payoutDone: true });

      } catch (err) {
        console.error('Winner payout failed:', err);
        // payoutDone false rahega — retry possible
      }
    }

    return res.status(200).json({
      success:      true,
      winnerId,
      loserId:      uid,
      winnerPrize,
      platformFee,
      finishReason: 'player_left',
    });
  }

  // ── Unknown status ───────────────────────────────────────────────────────
  return res.status(400).json({ error: `Unknown table status: ${table.status}` });
}

// ─── AUTO-DISCARD ─────────────────────────────────────────────────────────────
async function handleAutoDiscard(req: VercelRequest, res: VercelResponse, uid: string) {
  sanitize(req.body, ['tableId']);
  const { tableId } = req.body;

  const tableRef  = db.collection('jokerPairTables').doc(tableId);
  const gameRef   = db.collection('jokerPairGames').doc(tableId);
  const myPrivRef = gameRef.collection('private').doc(uid);
  const srvRef    = gameRef.collection('private').doc('_server');

  const result  = await db.runTransaction(async (tx) => {
    const [snap, privSnap, srvSnap] = await Promise.all([
      tx.get(gameRef), tx.get(myPrivRef), tx.get(srvRef),
    ]);
    if (!snap.exists) throw new Error('Game not found');
    const game = snap.data()!;

    if (game.status !== 'playing')   throw new Error('Game is not active');
    if (game.currentTurnUid !== uid) return { skipped: true, reason: 'Turn already passed' };

    const elapsed  = (Date.now() - game.turnStartedAt) / 1000;
    const duration = game.turnDuration || 60;
    if (elapsed < duration - 2) return { skipped: true, reason: 'Turn not expired yet' };

    // ── 3 missed turns = forfeit — opponent jeet jata hai ────────────────────
    const missed = ((game.playerData?.[uid]?.missedTurns || 0) as number) + 1;
    if (missed >= 3) {
      const winnerId = (game.players as string[]).find((p) => p !== uid) ?? null;
      tx.update(gameRef, {
        status:       'finished',
        finishedAt:   FieldValue.serverTimestamp(),
        winnerId,
        loserId:      uid,
        finishReason: 'turn_forfeit',
        payoutDone:   false,
        [`playerData.${uid}.missedTurns`]: missed,
      });
      tx.update(tableRef, { status: 'finished' });
      return { forfeited: true, winnerId, loserId: uid, missedTurns: missed };
    }

    if (!privSnap.exists) throw new Error('Player not found');
    const priv        = privSnap.data()!;
    let hand: string[] = [...(priv.hand || [])];
    let drawPile: string[] = [...(srvSnap.data()?.drawPile || [])];
    let discardPile   = [...game.discardPile];

    if (hand.length === 5) {
      if (drawPile.length === 0) {
        if (discardPile.length <= 1) throw new Error('No cards left to draw');
        const top   = discardPile.pop()!;
        drawPile    = shuffle(discardPile);
        discardPile = [top];
      }
      hand = [...hand, drawPile.pop()!];
    }

    const cardsInGroups = new Set(((priv.groups || []) as any[]).flatMap((g: any) => g.cards || []));
    const candidates    = hand.filter((c: string) => !cardsInGroups.has(c));
    const pool          = candidates.length > 0 ? candidates : hand;
    const cardToDiscard = pool[randomInt(0, pool.length)];

    hand = hand.filter((c: string) => c !== cardToDiscard);
    discardPile.push(cardToDiscard);

    const turn = nextTurn(game.players, game.currentTurnIndex);
    tx.update(myPrivRef, { hand, groups: [] });
    tx.update(srvRef, { drawPile });
    tx.update(gameRef, {
      discardPile,
      drawCount: drawPile.length,
      [`playerData.${uid}.handCount`]: hand.length,
      [`playerData.${uid}.hasActed`]:  true,
      [`playerData.${uid}.missedTurns`]: missed, // track missed turns
      ...turn,
    });
    return { autoDiscarded: cardToDiscard, nextTurnUid: turn.currentTurnUid, missedTurns: missed };
  });

  // ── Forfeit hua toh winner ko payout karo ──────────────────────────────────
  if (result.forfeited && result.winnerId) {
    const tableSnap = await tableRef.get();
    const prizePool = (tableSnap.data()?.prizePool || 0) as number;
    const commission = Math.floor(prizePool * 0.10);
    const winnerPrize = prizePool - commission;

    if (winnerPrize > 0) {
      try {
        await internalWalletTransaction({
          action:         'ADD',
          uid:            result.winnerId,
          amount:         winnerPrize,
          type:           'GAME_WIN',
          game:           'JokerPair',
          description:    `Joker Pair win (opponent timeout forfeit) - Table ${tableId}`,
          balanceType:    'winningBalance',
          idempotencyKey: `jp_win_forfeit_${tableId}_${result.winnerId}`,
        });
        await gameRef.update({ payoutDone: true });
      } catch (err) {
        console.error('[PAYOUT FAILED] Forfeit payout:', { tableId, winnerId: result.winnerId, err });
      }
    }
  }

  return res.status(200).json({ success: true, ...result });
}

// ─── RETRY PAYOUT ────────────────────────────────────────────────────────────
async function handleRetryPayout(req: VercelRequest, res: VercelResponse, uid: string) {
  sanitize(req.body, ['tableId']);

  const adminDoc = await db.collection('admins').doc(uid).get();
  if (!adminDoc.exists)
    return res.status(403).json({ error: 'Forbidden' });

  const { tableId } = req.body;

  const gameRef = db.collection('jokerPairGames').doc(tableId);
  const snap    = await gameRef.get();
  if (!snap.exists) return res.status(404).json({ error: 'Game not found' });

  const game = snap.data()!;
  if (game.status !== 'finished' || game.payoutDone)
    return res.status(200).json({ success: true, message: 'No pending payout' });
  if (!game.winnerId)
    return res.status(200).json({ success: true, message: 'No winner — abandoned game' });

  const prizePool    = game.prizePool as number;
  const commission   = Math.floor(prizePool * 0.1);
  const winnerAmount = prizePool - commission;

  await processPayout(tableId, game.winnerId, winnerAmount, prizePool);
  return res.status(200).json({ success: true, message: 'Payout retried successfully' });
}

// ─── Router ───────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action as string;
  let uid = '';

  try {
    uid = await verifyToken(req);
  } catch (e: any) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  try {
    switch (action) {
      case 'join':         return await handleJoin(req, res, uid);
      case 'start':        return await handleStart(req, res, uid);
      case 'action':       return await handleAction(req, res, uid);
      case 'leave':        return await handleLeave(req, res, uid);
      case 'auto-discard': return await handleAutoDiscard(req, res, uid);
      case 'retry-payout': return await handleRetryPayout(req, res, uid);
      default:
        return res.status(404).json({ error: `Unknown route: ${action}` });
    }
  } catch (err: any) {
    console.error(`[joker-pair/${action}]`, err);
    return res.status(err?.status || 500).json({
      error: err.message || 'Internal server error',
    });
  }
}
