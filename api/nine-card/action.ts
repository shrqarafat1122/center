import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue, Timestamp }              from 'firebase-admin/firestore';
import { db }                                 from '../lib/firebaseAdmin';
import { internalWalletTransaction, betHistory } from '../lib/walletInternal';
import { verifyToken, sanitize, setCors }     from '../lib/middleware';
import { randomInt }                          from 'crypto';

export const config = { maxDuration: 30 };

const COL = 'nineCardTables';

// ─── Types ────────────────────────────────────────────────────────────────────

type Suit         = '♠' | '♥' | '♦' | '♣';
type Rank         = 'A' | 'K' | 'Q' | 'J' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type PlayerStatus = 'waiting' | 'blind' | 'seen' | 'packed' | 'show';
type TableStatus  = 'waiting' | 'booting' | 'playing' | 'showdown' | 'finished' | 'disabled';

interface Card { rank: Rank; suit: Suit; id: string; }

interface NineCardPlayer {
  uid: string; displayName: string; photoURL?: string;
  status: PlayerStatus; hasPaidBoot: boolean;
  currentBet: number; totalBet: number; cardIds: string[];
  isMyTurn: boolean; seenCards: boolean; connected: boolean;
  joinedAt: any; turnStartedAt: any; autoCallAt: any; timeoutCount: number;
}

interface NineCardTable {
  id: string; name: string; bootAmount: number;
  status: TableStatus; locked: boolean; createdBy: string;
  players: Record<string, NineCardPlayer>; playerOrder: string[];
  pot: number; currentCallAmount: number; currentTurn: string | null;
  round: number; deck: string[]; deckIndex: number;
  winnerId: string | null; winnerReason: string | null; isDraw: boolean;
  history: any[]; minPlayers: number; maxPlayers: number;
  lastRaiseBy: string | null; lastRaiseAmount: number;
  createdAt: any; updatedAt: any;
}

// ─── Card Engine ──────────────────────────────────────────────────────────────

const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];
const RANKS: Rank[] = ['A', 'K', 'Q', 'J', '2', '3', '4', '5', '6', '7', '8', '9'];
const ENGLISH_CARDS = new Set<Rank>(['A', 'K', 'Q', 'J']);
const ENGLISH_RANK: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 };

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit, id: `${rank}${suit}` });
  return deck;
}

function shuffleDeck(deck: Card[]): Card[] {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getCardById(id: string): Card {
  return { suit: id.slice(-1) as Suit, rank: id.slice(0, -1) as Rank, id };
}

function computeHandValue(cardIds: string[]): { value: number; englishRank: number; isTie: boolean } {
  const [c1, c2]   = cardIds.map(getCardById);
  const isEng1 = ENGLISH_CARDS.has(c1.rank);
  const isEng2 = ENGLISH_CARDS.has(c2.rank);

  if (isEng1 && isEng2) {
    return { value: -1, englishRank: Math.max(ENGLISH_RANK[c1.rank] || 0, ENGLISH_RANK[c2.rank] || 0), isTie: true };
  }
  if (!isEng1 && !isEng2) {
    return { value: (parseInt(c1.rank) + parseInt(c2.rank)) % 10, englishRank: 0, isTie: false };
  }
  const numCard = isEng1 ? c2 : c1;
  const engCard = isEng1 ? c1 : c2;
  return { value: parseInt(numCard.rank), englishRank: ENGLISH_RANK[engCard.rank] || 0, isTie: false };
}

function compareHands(aCards: string[], bCards: string[]): 'a' | 'b' | 'draw' {
  const a = computeHandValue(aCards);
  const b = computeHandValue(bCards);

  if (a.isTie && b.isTie) {
    if (a.englishRank > b.englishRank) return 'a';
    if (b.englishRank > a.englishRank) return 'b';
    return 'draw';
  }
  if (a.isTie && !b.isTie) return b.value >= 0 ? 'b' : 'draw';
  if (b.isTie && !a.isTie) return a.value >= 0 ? 'a' : 'draw';
  if (a.value > b.value)        return 'a';
  if (b.value > a.value)        return 'b';
  if (a.englishRank > b.englishRank) return 'a';
  if (b.englishRank > a.englishRank) return 'b';
  return 'draw';
}

// ─── Payout + BetHistory Helpers ─────────────────────────────────────────────
//
// LOGIC:
//   winner net profit  = potReceived - winner.totalBet
//   loser  net loss    = loser.totalBet
//   draw   net profit  = share - player.totalBet  (positive ya 0)
//   draw   net loss    = player.totalBet - share  (agar share < totalBet)
//
// BetHistory mein sirf actual profit/loss jaata hai, poora pot nahi.

async function recordWin(
  winnerId:   string,
  netProfit:  number,
  totalBet:   number,
  tableName:  string,
  tableId:    string,
  round:      number,
  reason:     string,
) {
  if (netProfit <= 0) return;
  await betHistory({
    action:  'ADD',
    uid:     winnerId,
    game:    'NineCard',
    amount:  netProfit,
    type:    'BET_WIN',
    description: `Win | Round#${round} | ${reason} | Table: "${tableName}" | Bet: ₹${totalBet} Won: ₹${netProfit}`,
    idempotencyKey: `9card_win_${tableId}_${round}_${winnerId}`,
  }).catch(e => console.error('[9CARD WIN RECORD]', e));
}

async function recordLoss(
  uid:       string,
  lossAmt:   number,
  tableName: string,
  tableId:   string,
  round:     number,
  reason:    string,
) {
  if (lossAmt <= 0) return;
  await betHistory({
    action:  'DEDUCT',
    uid,
    game:    'NineCard',
    amount:  lossAmt,
    type:    'BET_LOSS',
    description: `Loss | Round#${round} | ${reason} | Table: "${tableName}" | Lost: ₹${lossAmt}`,
    idempotencyKey: `9card_loss_${tableId}_${round}_${uid}`,
  }).catch(e => console.error('[9CARD LOSS RECORD]', e));
}

async function recordDrawSplit(
  uid:       string,
  share:     number,
  totalBet:  number,
  tableName: string,
  tableId:   string,
  round:     number,
) {
  const net = share - totalBet;
  if (net > 0) {
    // Profit side of draw
    await betHistory({
      action:  'ADD',
      uid,
      game:    'NineCard',
      amount:  net,
      type:    'SPLIT_WIN',
      description: `Draw Split | Round#${round} | Table: "${tableName}" | Bet: ₹${totalBet} Got: ₹${share} Net: +₹${net}`,
      idempotencyKey: `9card_draw_win_${tableId}_${round}_${uid}`,
    }).catch(e => console.error('[9CARD DRAW WIN RECORD]', e));
  } else if (net < 0) {
    // Loss side of draw (shouldn't happen in equal-split but guard hai)
    await betHistory({
      action:  'DEDUCT',
      uid,
      game:    'NineCard',
      amount:  Math.abs(net),
      type:    'BET_LOSS',
      description: `Draw Split | Round#${round} | Table: "${tableName}" | Bet: ₹${totalBet} Got: ₹${share} Net: -₹${Math.abs(net)}`,
      idempotencyKey: `9card_draw_loss_${tableId}_${round}_${uid}`,
    }).catch(e => console.error('[9CARD DRAW LOSS RECORD]', e));
  }
  // net === 0: exact breakeven — koi record nahi
}

// Wallet credit (actual payout — alag hai betHistory se)
async function payWinner(
  winnerId:  string,
  amount:    number,
  tableId:   string,
  round:     number,
  reason:    string,
) {
  if (amount <= 0) return;
  await internalWalletTransaction({
    action:      'ADD',
    uid:         winnerId,
    amount,
    type:        'GAME_WIN',
    game:        'NineCard',
    balanceType: 'winningBalance',
    description: `9 Card win — ${reason}`,
    idempotencyKey: `9card_win_${tableId}_${round}_${winnerId}`,
  });
}

async function payDraw(
  uids:     string[],
  totalPot: number,
  tableId:  string,
  round:    number,
) {
  if (totalPot <= 0 || uids.length === 0) return;
  const share     = Math.floor(totalPot / uids.length);
  const remainder = totalPot - share * uids.length;
  for (let i = 0; i < uids.length; i++) {
    const amount = share + (i === 0 ? remainder : 0);
    if (amount <= 0) continue;
    await internalWalletTransaction({
      action:      'ADD',
      uid:         uids[i],
      amount,
      game:        'NineCard',
      type:        'GAME_WIN',
      balanceType: 'winningBalance',
      description: `9 Card draw split ₹${amount}`,
      idempotencyKey: `9card_draw_${tableId}_${round}_${uids[i]}`,
    }).catch(console.error);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);
  if (req.method === 'OPTIONS')
    return res.status(204).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { type, ...body } = req.body ?? {};
  if (!type) return res.status(400).json({ error: 'type required' });

  let uid = '';
  try {
    uid = await verifyToken(req);
  } catch (e: any) {
    return res.status(e.status || 401).json({ error: e.message });
  }

  sanitize(body, ['tableId']);
  const { tableId } = body;
  const tableRef = db.collection(COL).doc(tableId);

  try {
    switch (type) {

      // ── JOIN ──────────────────────────────────────────────────────────────
      case 'join': {
        const { displayName, photoURL, amount } = body;
        sanitize(body, ['displayName', 'photoURL', 'amount']);
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.locked)                return res.status(400).json({ error: 'Table is locked' });
        if (table.status === 'disabled') return res.status(400).json({ error: 'Table is disabled' });
        if (table.status === 'playing')  return res.status(400).json({ error: 'Game already in progress' });
        if (Object.keys(table.players).length >= table.maxPlayers)
          return res.status(400).json({ error: 'Table is full' });
        if (table.players[uid])          return res.status(409).json({ error: 'Already joined' });

        try {
          await db.runTransaction(async (tx) => {
            const fresh = await tx.get(tableRef);
            if (!fresh.exists) throw new Error('Table not found');
            const ft = fresh.data() as NineCardTable;

            if (ft.players[uid])                                  throw new Error('ALREADY_JOINED');
            if (Object.keys(ft.players).length >= ft.maxPlayers)  throw new Error('TABLE_FULL');

            const player: NineCardPlayer = {
              uid, displayName, photoURL: photoURL || '',
              status: 'waiting', hasPaidBoot: false,
              currentBet: 0, totalBet: 0, cardIds: [],
              isMyTurn: false, seenCards: false, connected: true,
              joinedAt: Timestamp.now(), turnStartedAt: null,
              autoCallAt: null, timeoutCount: 0,
            };

            const updatedPlayers = { ...ft.players, [uid]: player };
            const updatedOrder   = [...ft.playerOrder, uid];
            const willBeFull     = Object.keys(updatedPlayers).length >= ft.maxPlayers;

            tx.update(tableRef, {
              players:     updatedPlayers,
              playerOrder: updatedOrder,
              locked:      willBeFull,
              updatedAt:   FieldValue.serverTimestamp(),
            });
          });
        } catch (e: any) {
          if (e.message === 'ALREADY_JOINED')
            return res.status(409).json({ error: 'Already joined' });
          if (e.message === 'TABLE_FULL')
            return res.status(400).json({ error: 'Table is full' });
          return res.status(500).json({ error: e.message });
        }

        return res.status(200).json({ ok: true });
      }

      // ── AUTO START ────────────────────────────────────────────────────────
      case 'auto-start': {
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.status !== 'waiting')
          return res.status(200).json({ ok: true, skipped: true });
        if (Object.keys(table.players).length < table.minPlayers)
          return res.status(200).json({ ok: true, skipped: true, reason: 'Not enough players' });

        const claimed = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(tableRef);
          if (!fresh.exists) return null;
          const ft = fresh.data() as NineCardTable;
          if (ft.status !== 'waiting')                            return null;
          if (Object.keys(ft.players).length < ft.minPlayers)    return null;
          tx.update(tableRef, { status: 'booting', updatedAt: FieldValue.serverTimestamp() });
          return ft;
        });

        if (!claimed) return res.status(200).json({ ok: true, skipped: true });

        const updatedPlayers = { ...claimed.players };
        const paidUids: string[] = [];

        for (const pUid of claimed.playerOrder) {
          try {
            await internalWalletTransaction({
              action:      'DEDUCT',
              uid:         pUid,
              amount:      claimed.bootAmount,
              type:        'GAME_ENTRY',
              game:        'NineCard',
              description: `9 Card boot ₹${claimed.bootAmount} — ${claimed.name}`,
              idempotencyKey: `9card_boot_${tableId}_${(claimed.round || 0) + 1}_${pUid}`,
            });
            updatedPlayers[pUid] = { ...updatedPlayers[pUid], hasPaidBoot: true };
            paidUids.push(pUid);
          } catch (e) {
            // Insufficient balance — drop this player for this hand
            delete updatedPlayers[pUid];
          }
        }

        if (paidUids.length < claimed.minPlayers) {
          // Refund whoever paid and reopen
          for (const pUid of paidUids) {
            await internalWalletTransaction({
              action: 'ADD', uid: pUid, amount: claimed.bootAmount,
              type: 'REFUND', game: 'NineCard', balanceType: 'depositBalance',
              description: `9 Card refund — round cancelled`,
              idempotencyKey: `9card_boot_refund_${tableId}_${pUid}_${Date.now()}`,
            }).catch(console.error);
          }
          await tableRef.update({ status: 'waiting', updatedAt: FieldValue.serverTimestamp() });
          return res.status(200).json({ ok: true, skipped: true, reason: 'Not enough players paid boot' });
        }

        const deck    = shuffleDeck(buildDeck());
        const deckIds = deck.map(c => c.id);
        let   deckIdx = 0;

        for (let i = 0; i < paidUids.length; i++) {
          const pUid = paidUids[i];
          updatedPlayers[pUid] = {
            ...updatedPlayers[pUid],
            cardIds:       [deckIds[deckIdx++], deckIds[deckIdx++]],
            status:        'blind',
            currentBet:    claimed.bootAmount,
            totalBet:      claimed.bootAmount,
            isMyTurn:      i === 0,
            turnStartedAt: i === 0 ? Timestamp.now() : null,
            autoCallAt:    i === 0 ? Timestamp.now() : null,
            timeoutCount:  0,
          };
        }

        await tableRef.update({
          players:           updatedPlayers,
          playerOrder:       paidUids,
          status:            'playing',
          locked:            true,
          deck:              deckIds,
          deckIndex:         deckIdx,
          pot:               claimed.bootAmount * paidUids.length,
          currentTurn:       paidUids[0],
          currentCallAmount: claimed.bootAmount,
          lastRaiseBy:       null,
          lastRaiseAmount:   0,
          round:             (claimed.round || 0) + 1,
          updatedAt:         FieldValue.serverTimestamp(),
        });

        return res.status(200).json({ ok: true });
      }

      // ── SEE CARDS ─────────────────────────────────────────────────────────
      case 'see-cards': {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(tableRef);
          if (!snap.exists) throw new Error('Table not found');
          const table  = snap.data() as NineCardTable;

          if (table.currentTurn !== uid) throw new Error('Not your turn');
          const player = table.players[uid];
          if (!player)          throw new Error('Player not found');
          if (player.seenCards) throw new Error('Already seen cards');

          tx.update(tableRef, {
            [`players.${uid}.seenCards`]:     true,
            [`players.${uid}.status`]:        'seen',
            [`players.${uid}.turnStartedAt`]: Timestamp.now(),
            [`players.${uid}.autoCallAt`]:    Timestamp.now(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        return res.status(200).json({ ok: true });
      }

      // ── CALL ──────────────────────────────────────────────────────────────
      case 'call': {
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.currentTurn !== uid)  return res.status(403).json({ error: 'Not your turn' });
        if (!table.players[uid])        return res.status(404).json({ error: 'Player not found' });
        if (table.status !== 'playing') return res.status(400).json({ error: 'Game not active' });

        const player        = table.players[uid];
        const callAmt       = Number(table.currentCallAmount || 0);
        const activePlayers = table.playerOrder.filter(id => table.players[id]?.status !== 'packed');
        const myIdx         = activePlayers.indexOf(uid);
        const nextUid       = activePlayers[(myIdx + 1) % activePlayers.length];

        await internalWalletTransaction({
          action: 'DEDUCT', uid, amount: callAmt,
          type: 'GAME_ENTRY',
          game: 'NineCard',
          description: `9 Card call ₹${callAmt}`,
          idempotencyKey: `9card_call_${tableId}_${table.round}_${uid}_${Date.now()}`,
        });

        const updatedPlayers = { ...table.players };
        updatedPlayers[uid] = {
          ...player,
          currentBet:    (player.currentBet || 0) + callAmt,
          totalBet:      (player.totalBet   || 0) + callAmt,
          isMyTurn:      false,
          turnStartedAt: null,
          autoCallAt:    null,
        };
        updatedPlayers[nextUid] = {
          ...updatedPlayers[nextUid],
          isMyTurn:      true,
          turnStartedAt: Timestamp.now(),
          autoCallAt:    Timestamp.now(),
        };

        await tableRef.update({
          players:         updatedPlayers,
          pot:             Number(table.pot || 0) + callAmt,
          currentTurn:     nextUid,
          lastRaiseBy:     null,
          lastRaiseAmount: 0,
          updatedAt:       FieldValue.serverTimestamp(),
        });

        return res.status(200).json({ ok: true });
      }

      // ── RAISE ─────────────────────────────────────────────────────────────
      case 'raise': {
        const { raiseAmount } = body;
        sanitize(body, ['raiseAmount']);
        if (typeof raiseAmount !== 'number' || raiseAmount <= 0)
          return res.status(400).json({ error: 'raiseAmount required' });

        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.currentTurn !== uid)  return res.status(403).json({ error: 'Not your turn' });
        const player = table.players[uid];
        if (!player)                    return res.status(404).json({ error: 'Player not found' });
        if (table.status !== 'playing') return res.status(400).json({ error: 'Game not active' });

        const minRaise = player.seenCards
          ? Number(table.currentCallAmount || 0) * 2
          : Number(table.currentCallAmount || 0);

        if (raiseAmount < minRaise)
          return res.status(400).json({ error: `Minimum raise is ₹${minRaise}` });

        const activePlayers = table.playerOrder.filter(id => table.players[id]?.status !== 'packed');
        const myIdx         = activePlayers.indexOf(uid);
        const nextUid       = activePlayers[(myIdx + 1) % activePlayers.length];

        await internalWalletTransaction({
          action: 'DEDUCT', uid, amount: raiseAmount,
          type: 'GAME_ENTRY',
          game: 'NineCard',
          description: `9 Card raise ₹${raiseAmount}`,
          idempotencyKey: `9card_raise_${tableId}_${table.round}_${uid}_${Date.now()}`,
        });

        const updatedPlayers = { ...table.players };
        updatedPlayers[uid] = {
          ...player,
          currentBet:    (player.currentBet || 0) + raiseAmount,
          totalBet:      (player.totalBet   || 0) + raiseAmount,
          isMyTurn:      false,
          turnStartedAt: null,
          autoCallAt:    null,
        };
        updatedPlayers[nextUid] = {
          ...updatedPlayers[nextUid],
          isMyTurn:      true,
          turnStartedAt: Timestamp.now(),
          autoCallAt:    Timestamp.now(),
        };

        await tableRef.update({
          players:           updatedPlayers,
          pot:               Number(table.pot || 0) + raiseAmount,
          currentCallAmount: raiseAmount,
          currentTurn:       nextUid,
          lastRaiseBy:       uid,
          lastRaiseAmount:   raiseAmount,
          updatedAt:         FieldValue.serverTimestamp(),
        });

        return res.status(200).json({ ok: true });
      }

      // ── PACK ──────────────────────────────────────────────────────────────
      case 'pack': {
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.currentTurn !== uid)  return res.status(403).json({ error: 'Not your turn' });
        if (table.status !== 'playing') return res.status(400).json({ error: 'Game not active' });

        const order     = table.playerOrder.filter(id => table.players[id]);
        const myIdx     = order.indexOf(uid);
        const winnerUid = order[(myIdx + 1) % order.length];
        const pot       = Number(table.pot || 0);

        // Snapshot totalBets before finishing
        const packerTotalBet = table.players[uid]?.totalBet   || 0;
        const winnerTotalBet = table.players[winnerUid]?.totalBet || 0;
        const winnerNet      = pot - winnerTotalBet; // what winner actually profits

        const updatedPlayers = { ...table.players };
        updatedPlayers[uid] = {
          ...updatedPlayers[uid],
          status: 'packed', isMyTurn: false,
          turnStartedAt: null, autoCallAt: null,
        };

        const historyEntry = {
          round:      table.round,
          winnerId:   winnerUid,
          winnerName: table.players[winnerUid]?.displayName || 'Player',
          pot,
          reason:     `${table.players[uid].displayName} packed`,
          isDraw:     false,
          timestamp:  Timestamp.now(),
        };

        await tableRef.update({
          players:         updatedPlayers,
          winnerId:        winnerUid,
          winnerReason:    'Opponent packed',
          isDraw:          false,
          status:          'finished',
          history:         [...table.history, historyEntry],
          lastRaiseBy:     null,
          lastRaiseAmount: 0,
          currentTurn:     null,
          updatedAt:       FieldValue.serverTimestamp(),
        });

        // Wallet: pay full pot to winner
        await payWinner(winnerUid, pot, tableId, table.round, 'Opponent packed');

        // BetHistory: net profit for winner, net loss for packer
        await recordWin(
          winnerUid, winnerNet, winnerTotalBet,
          table.name, tableId, table.round, 'Opponent packed',
        );
        await recordLoss(
          uid, packerTotalBet,
          table.name, tableId, table.round, 'Packed',
        );

        return res.status(200).json({ ok: true });
      }

      // ── SHOW ──────────────────────────────────────────────────────────────
      case 'show': {
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.currentTurn !== uid)  return res.status(403).json({ error: 'Not your turn' });
        const player = table.players[uid];
        if (!player)                    return res.status(404).json({ error: 'Player not found' });
        if (!player.seenCards)          return res.status(400).json({ error: 'See cards first before showing' });
        if (table.status !== 'playing') return res.status(400).json({ error: 'Game not active' });

        const order  = table.playerOrder.filter(id => table.players[id]);
        const myIdx  = order.indexOf(uid);
        const oppUid = order[(myIdx + 1) % order.length];
        const pot    = Number(table.pot || 0);

        // Snapshot totalBets before finishing
        const myTotalBet  = table.players[uid]?.totalBet    || 0;
        const oppTotalBet = table.players[oppUid]?.totalBet || 0;

        const result = compareHands(table.players[uid].cardIds, table.players[oppUid].cardIds);
        let winnerId:    string | null = null;
        let loserId:     string | null = null;
        let winnerReason = '';
        let isDraw       = false;

        if      (result === 'a') { winnerId = uid;    loserId = oppUid; winnerReason = 'Higher hand value'; }
        else if (result === 'b') { winnerId = oppUid; loserId = uid;    winnerReason = 'Higher hand value'; }
        else                     { isDraw = true;     winnerReason = 'Draw — pot split'; }

        const updatedPlayers = { ...table.players };
        for (const pUid of order) {
          updatedPlayers[pUid] = {
            ...updatedPlayers[pUid],
            status: 'show', isMyTurn: false,
            turnStartedAt: null, autoCallAt: null,
          };
        }

        const historyEntry = {
          round:      table.round,
          winnerId,
          winnerName: winnerId ? table.players[winnerId].displayName : null,
          pot, reason: winnerReason, isDraw, timestamp: Timestamp.now(),
        };

        await tableRef.update({
          players:         updatedPlayers,
          winnerId, winnerReason, isDraw,
          status:          'finished',
          history:         [...table.history, historyEntry],
          lastRaiseBy:     null,
          lastRaiseAmount: 0,
          currentTurn:     null,
          updatedAt:       FieldValue.serverTimestamp(),
        });

        if (isDraw) {
          // Wallet: split pot
          await payDraw(order, pot, tableId, table.round);

          // BetHistory: net per player
          const share     = Math.floor(pot / order.length);
          const remainder = pot - share * order.length;
          for (let i = 0; i < order.length; i++) {
            const pUid      = order[i];
            const pShare    = share + (i === 0 ? remainder : 0);
            const pTotalBet = table.players[pUid]?.totalBet || 0;
            await recordDrawSplit(pUid, pShare, pTotalBet, table.name, tableId, table.round);
          }

        } else if (winnerId && loserId) {
          // Wallet: full pot to winner
          await payWinner(winnerId, pot, tableId, table.round, 'Show — higher hand');

          // BetHistory: net profit for winner, net loss for loser
          const winnerTotalBet = winnerId === uid ? myTotalBet : oppTotalBet;
          const loserTotalBet  = loserId  === uid ? myTotalBet : oppTotalBet;
          const winnerNet      = pot - winnerTotalBet;

          await recordWin(
            winnerId, winnerNet, winnerTotalBet,
            table.name, tableId, table.round, 'Show — higher hand',
          );
          await recordLoss(
            loserId, loserTotalBet,
            table.name, tableId, table.round, 'Show — lower hand',
          );
        }

        return res.status(200).json({ ok: true, result, winnerId, isDraw });
      }

      // ── LEAVE ─────────────────────────────────────────────────────────────
      case 'leave': {
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;
        if (!table.players[uid]) return res.status(200).json({ ok: true });

        const updatedPlayers = { ...table.players };
        const updatedOrder   = table.playerOrder.filter(id => id !== uid);
        const pot            = Number(table.pot || 0);

        // ── Active game — opponent wins ────────────────────────────────────
        if ((table.status === 'playing' || table.status === 'booting') && updatedOrder.length > 0) {
          const winnerUid      = updatedOrder[0];
          const leaverTotalBet = table.players[uid]?.totalBet    || 0;
          const winnerTotalBet = table.players[winnerUid]?.totalBet || 0;
          const winnerNet      = pot - winnerTotalBet;

          delete updatedPlayers[uid];

          const historyEntry = {
            round:      table.round || 0,
            winnerId:   winnerUid,
            winnerName: table.players[winnerUid]?.displayName || 'Player',
            pot,
            reason:     `${table.players[uid].displayName} left the game`,
            isDraw:     false,
            timestamp:  Timestamp.now(),
          };

          await tableRef.update({
            players:         updatedPlayers,
            playerOrder:     updatedOrder,
            status:          'finished',
            winnerId:        winnerUid,
            winnerReason:    'Opponent left the table',
            isDraw:          false,
            history:         [...table.history, historyEntry],
            currentTurn:     null,
            locked:          false,
            lastRaiseBy:     null,
            lastRaiseAmount: 0,
            updatedAt:       FieldValue.serverTimestamp(),
          });

          // Wallet
          await payWinner(winnerUid, pot, tableId, table.round, 'Opponent left');

          // BetHistory
          await recordWin(
            winnerUid, winnerNet, winnerTotalBet,
            table.name, tableId, table.round, 'Opponent left',
          );
          await recordLoss(
            uid, leaverTotalBet,
            table.name, tableId, table.round, 'Left the game',
          );

          return res.status(200).json({ ok: true });
        }

        // ── Waiting state — nothing deducted, just vacate seat ────────────
        delete updatedPlayers[uid];

        if (updatedOrder.length === 0) {
          await tableRef.update({
            players: {}, playerOrder: [], pot: 0,
            currentCallAmount: table.bootAmount,
            currentTurn: null, deck: [], deckIndex: 0,
            winnerId: null, winnerReason: null, isDraw: false,
            lastRaiseBy: null, lastRaiseAmount: 0,
            locked: false, status: 'waiting',
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          await tableRef.update({
            players:     updatedPlayers,
            playerOrder: updatedOrder,
            locked:      false,
            updatedAt:   FieldValue.serverTimestamp(),
          });
        }

        return res.status(200).json({ ok: true });
      }

      // ── RESET ─────────────────────────────────────────────────────────────
      case 'reset': {
        const snap = await tableRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Table not found' });
        const table = snap.data() as NineCardTable;

        if (table.status !== 'finished')
          return res.status(400).json({ error: 'Game abhi finish nahi hua' });

        const resetPlayers: Record<string, NineCardPlayer> = {};
        for (const pUid of table.playerOrder) {
          const p = table.players[pUid];
          if (!p) continue;
          resetPlayers[pUid] = {
            ...p,
            status: 'waiting', hasPaidBoot: false,
            currentBet: 0, totalBet: 0, cardIds: [],
            isMyTurn: false, seenCards: false, connected: true,
            turnStartedAt: null, autoCallAt: null, timeoutCount: 0,
          };
        }

        await tableRef.update({
          players:           resetPlayers,
          pot:               0,
          currentCallAmount: table.bootAmount,
          currentTurn:       null,
          deck:              [],
          deckIndex:         0,
          winnerId:          null,
          winnerReason:      null,
          isDraw:            false,
          lastRaiseBy:       null,
          lastRaiseAmount:   0,
          locked:            Object.keys(resetPlayers).length >= table.maxPlayers,
          status:            'waiting',
          updatedAt:         FieldValue.serverTimestamp(),
        });

        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: `Unknown type: "${type}"` });
    }

  } catch (err: any) {
    console.error(`[nine-card/${type}]`, err.message);
    const status = err?.status
      || (err.message?.includes('not found')     ? 404
        : err.message?.includes('Insufficient')  ? 402
        : err.message?.includes('Not your turn') ? 403
        : 500);
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
}
