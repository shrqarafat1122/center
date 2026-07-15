// api/poker/action.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue, Timestamp }              from 'firebase-admin/firestore';
import { randomInt }                          from 'crypto';
import { db }                                 from '../lib/firebaseAdmin';
import { internalWalletTransaction, betHistory } from '../lib/walletInternal';
import { verifyToken, sanitize }              from '../lib/middleware';
import { setCors } from "../lib/middleware";

export const config = { maxDuration: 30 };

const POKER            = 'pokerTables';
const TURN_SECS        = 20;
const AFK_WARNING_SECS = 15;
const SHOWDOWN_SECS    = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type PokerPhase   = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
type SeatStatus   = 'ACTIVE' | 'SITTING_OUT' | 'AFK_WARNING' | 'LEFT_SEAT' | 'DISCONNECTED';
type PlayerStatus = 'waiting' | 'active' | 'folded' | 'allin' | 'left' | 'disconnected';

interface Card { suit: string; value: string; numericValue: number; }

interface PokerPlayer {
  uid:               string;
  name:              string;
  avatar:            string;
  chips:             number;
  holeCards:         Card[];
  bet:               number;
  totalBet:          number;
  status:            PlayerStatus;
  seatStatus:        SeatStatus;
  missedTurns:       number;
  isDealer:          boolean;
  isSmallBlind:      boolean;
  isBigBlind:        boolean;
  isTurn:            boolean;
  hasActedThisRound: boolean;
  handRank?:         string;
  seatIndex:         number;
  joinedAt:          any;
  disconnectedAt?:   any;
  lastAction?:       string | null;
  lastActionAmount?: number | null;
  lastSeen?:         any;
  turnStartedAt?:    any;
  afkWarningAt?:     any;
  leaveRequested?:   boolean;
}

interface SidePot { amount: number; eligibleUids: string[]; }

interface PokerTable {
  id:               string;
  name:             string;
  status:           'waiting' | 'playing' | 'finished';
  phase:            PokerPhase;
  minBuyIn:         number;
  maxBuyIn:         number;
  smallBlind:       number;
  bigBlind:         number;
  maxPlayers:       6;
  players:          PokerPlayer[];
  spectatorQueue:   any[];
  reservedSeats:    Record<number, { uid: string; until: number }>;
  communityCards:   Card[];
  pot:              number;
  sidePots:         SidePot[];
  currentBet:       number;
  dealerSeat:       number;
  activePlayerUid:  string | null;
  turnExpiresAt:    any;
  afkWarningUid?:   string | null;
  afkWarningEndsAt?: any;
  deck:             Card[];
  handNumber:       number;
  lastBrokePlayers: Array<{ uid: string; name: string }>;
  lastHandWins?:    Record<string, number>;
  lastHandAllIn?:   boolean;
  lastWinner?:      string;
  nextHandAt?:      any;
  createdAt:        any;
  updatedAt:        any;
  lastActionAt:     any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deck
// ─────────────────────────────────────────────────────────────────────────────
const SUITS  = ['spades', 'hearts', 'diamonds', 'clubs'] as const;
const VALUES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'] as const;

function createDeck(): Card[] {
  return SUITS.flatMap(suit =>
    VALUES.map((value, i) => ({ suit, value, numericValue: i + 2 }))
  );
}

function shuffleDeck(deck: Card[]): Card[] {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore safety
// ─────────────────────────────────────────────────────────────────────────────
function fsafe(val: any): any {
  if (val === undefined || val === null) return null;
  if (Array.isArray(val)) return val.map(fsafe);
  if (
    typeof val === 'object' &&
    typeof val.toMillis !== 'function' &&
    !val._methodName
  ) {
    const out: any = {};
    for (const k of Object.keys(val)) out[k] = fsafe(val[k]);
    return out;
  }
  return val;
}

function sp(players: PokerPlayer[]): PokerPlayer[] {
  return fsafe(players) as PokerPlayer[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand evaluation
// ─────────────────────────────────────────────────────────────────────────────
function getCombinations(arr: Card[], k: number): Card[][] {
  const result: Card[][] = [];
  function combo(start: number, cur: Card[]) {
    if (cur.length === k) { result.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) combo(i + 1, [...cur, arr[i]]);
  }
  combo(0, []);
  return result;
}

function evalFive(cards: Card[]): { rank: number; name: string; kickers: number[] } {
  const sorted = [...cards].sort((a, b) => b.numericValue - a.numericValue);
  const suits  = sorted.map(c => c.suit);
  const vals   = sorted.map(c => c.numericValue);
  const isFlush = suits.every(s => s === suits[0]);
  const isNS    = vals.every((v, i) => i === 0 || v === vals[i - 1] - 1);
  const isWS    = vals[0] === 14 && vals[1] === 5 && vals[2] === 4 && vals[3] === 3 && vals[4] === 2;
  const isSt    = isNS || isWS;
  const high    = isWS ? 5 : vals[0];
  const freq: Record<number, number> = {};
  vals.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  const kickers = Object.entries(freq)
    .map(([v, c]) => ({ v: Number(v), c }))
    .sort((a, b) => b.c - a.c || b.v - a.v)
    .map(x => x.v);
  const counts = Object.values(freq).sort((a, b) => b - a);
  if (isFlush && isSt && high === 14 && vals[1] === 13)
    return { rank: 9, name: 'Royal Flush 👑', kickers: [14, 13, 12, 11, 10] };
  if (isFlush && isSt)              return { rank: 8, name: 'Straight Flush',  kickers: [high] };
  if (counts[0] === 4)              return { rank: 7, name: 'Four of a Kind',  kickers };
  if (counts[0] === 3 && counts[1] === 2) return { rank: 6, name: 'Full House', kickers };
  if (isFlush)                      return { rank: 5, name: 'Flush',           kickers: vals };
  if (isSt)                         return { rank: 4, name: 'Straight',        kickers: [high] };
  if (counts[0] === 3)              return { rank: 3, name: 'Three of a Kind', kickers };
  if (counts[0] === 2 && counts[1] === 2) return { rank: 2, name: 'Two Pair', kickers };
  if (counts[0] === 2)              return { rank: 1, name: 'One Pair',        kickers };
  return { rank: 0, name: 'High Card', kickers: vals };
}

function evalBest(cards: Card[]): { rank: number; name: string; kickers: number[] } {
  if (cards.length < 2) return { rank: -1, name: 'No Cards', kickers: [] };
  const combos = cards.length <= 5 ? [cards] : getCombinations(cards, 5);
  let best = { rank: -1, name: 'No Cards', kickers: [] as number[] };
  for (const c of combos) {
    const r = evalFive(c);
    if (cmpHands(r, best) > 0) best = r;
  }
  return best;
}

function cmpHands(
  a: { rank: number; kickers: number[] },
  b: { rank: number; kickers: number[] },
): number {
  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const av = a.kickers[i] ?? 0;
    const bv = b.kickers[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Side pots
// ─────────────────────────────────────────────────────────────────────────────
function buildSidePots(players: PokerPlayer[]): SidePot[] {
  const contributors = players
    .filter(p => p.totalBet > 0 && p.status !== 'left')
    .sort((a, b) => a.totalBet - b.totalBet);
  if (!contributors.length) return [];
  const pots: SidePot[] = [];
  let prev = 0;
  for (const c of contributors) {
    if (c.totalBet <= prev) continue;
    const slice    = c.totalBet - prev;
    const eligible = players.filter(
      p => p.totalBet >= c.totalBet && p.status !== 'left' &&
           (p.status === 'active' || p.status === 'allin')
    );
    const contrib  = players.filter(
      p => p.totalBet >= c.totalBet && p.status !== 'left'
    );
    pots.push({ amount: slice * contrib.length, eligibleUids: eligible.map(p => p.uid) });
    prev = c.totalBet;
  }
  const merged: SidePot[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    const same = last &&
      last.eligibleUids.length === pot.eligibleUids.length &&
      last.eligibleUids.every((u, i) => u === pot.eligibleUids[i]);
    if (same) merged[merged.length - 1] = { ...last, amount: last.amount + pot.amount };
    else merged.push({ ...pot });
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Betting helpers
// ─────────────────────────────────────────────────────────────────────────────
function bettingComplete(players: PokerPlayer[], currentBet: number): boolean {
  const active = players.filter(p => p.status === 'active');
  if (!active.length) return true;
  return active.every(p => p.hasActedThisRound && p.bet === currentBet);
}

function nextActiveIdx(players: PokerPlayer[], from: number): number {
  for (let i = 1; i <= players.length; i++) {
    const idx = (from + i) % players.length;
    if (players[idx].status === 'active') return idx;
  }
  return -1;
}

function resetStreet(players: PokerPlayer[]): void {
  players.forEach(p => {
    if (p.status === 'active' || p.status === 'allin') {
      p.bet = 0;
      p.hasActedThisRound = false;
      p.isTurn = false;
      p.lastAction = null;
      p.lastActionAmount = null;
    }
  });
}

function dealCards(deck: Card[], community: Card[], count: number): void {
  for (let i = 0; i < count; i++) {
    if (deck.length > 0) community.push(deck.pop()!);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clean state helpers — single source of truth
// ─────────────────────────────────────────────────────────────────────────────
function cleanHandState(): Record<string, any> {
  return {
    communityCards:   [],
    deck:             [],
    pot:              0,
    sidePots:         [],
    currentBet:       0,
    dealerSeat:       0,
    activePlayerUid:  null,
    turnExpiresAt:    null,
    afkWarningUid:    null,
    afkWarningEndsAt: null,
    lastHandAllIn:    false,
    lastHandWins:     {},
    lastWinner:       null,
    lastBrokePlayers: [],
  };
}

function cleanPlayer(p: PokerPlayer, finalChips: number): PokerPlayer {
  return {
    uid:            p.uid,
    name:           p.name,
    avatar:         p.avatar,
    seatIndex:      p.seatIndex,
    joinedAt:       p.joinedAt,
    lastSeen:       p.lastSeen || Timestamp.now(),
    // Preserve DISCONNECTED — do not downgrade to LEFT_SEAT or ACTIVE
    seatStatus:     p.seatStatus === 'LEFT_SEAT' ? 'LEFT_SEAT' : p.seatStatus,
    leaveRequested: false,
    missedTurns:    0,
    chips:          finalChips,
    holeCards:         [],
    bet:               0,
    totalBet:          0,
    // DISCONNECTED players keep disconnected status so AFK handles them
    status:            (p.seatStatus === 'DISCONNECTED' ? 'disconnected' : 'waiting') as PlayerStatus,
    isDealer:          false,
    isSmallBlind:      false,
    isBigBlind:        false,
    isTurn:            false,
    hasActedThisRound: false,
    handRank:          '',
    lastAction:        null,
    lastActionAmount:  null,
    turnStartedAt:     null,
    afkWarningAt:      null,
    disconnectedAt:    p.disconnectedAt || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// separatePlayersAfterHand
// DISCONNECTED players with chips stay seated — they can reconnect
// ─────────────────────────────────────────────────────────────────────────────
function separatePlayersAfterHand(settledPlayers: PokerPlayer[]): {
  showdownPlayers: PokerPlayer[];
  seated:          PokerPlayer[];
  newSpectators:   any[];
} {
  const showdownPlayers: PokerPlayer[] = [];
  const seated:          PokerPlayer[] = [];
  const newSpectators:   any[]         = [];

  for (const p of settledPlayers) {
    const mustLeave =
      p.chips <= 0 ||
      p.leaveRequested === true ||
      p.seatStatus === 'LEFT_SEAT';

    if (mustLeave) {
      showdownPlayers.push({ ...p, seatStatus: 'LEFT_SEAT' });
      newSpectators.push({
        uid:         p.uid,
        name:        p.name,
        avatar:      p.avatar || '',
        buyIn:       0,
        seatIndex:   null,
        joinedAt:    Timestamp.now(),
        isSpectator: true,
      });
    } else {
      // ACTIVE or DISCONNECTED with chips — stays at table
      showdownPlayers.push(p);
      seated.push(p);
    }
  }

  return { showdownPlayers, seated, newSpectators };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildFreshHandState
// ─────────────────────────────────────────────────────────────────────────────
interface FreshHandResult { update: Record<string, any>; handNumber: number; }

function buildFreshHandState(
  table:          Pick<PokerTable, 'smallBlind' | 'bigBlind' | 'maxPlayers' | 'minBuyIn' | 'handNumber'>,
  seatedPlayers:  PokerPlayer[],
  spectatorQueue: any[],
): FreshHandResult | null {
  let players = seatedPlayers.map(p => ({ ...p }));
  let queue   = [...spectatorQueue];

  // Promote waiting spectators into empty seats
  while (players.length < table.maxPlayers && queue.length > 0) {
    const idx = queue.findIndex(s => !s.isSpectator && (s.buyIn || 0) > 0);
    if (idx === -1) break;
    const spec = queue.splice(idx, 1)[0];
    const occupied = new Set(players.map(p => p.seatIndex));
    let seat = 0;
    if (spec.seatIndex != null && !occupied.has(spec.seatIndex)) seat = spec.seatIndex;
    else while (occupied.has(seat)) seat++;
    players.push({
      uid: spec.uid, name: spec.name, avatar: spec.avatar || '',
      chips: spec.buyIn || table.minBuyIn,
      holeCards: [], bet: 0, totalBet: 0,
      status: 'waiting', seatStatus: 'ACTIVE', missedTurns: 0,
      isDealer: false, isSmallBlind: false, isBigBlind: false,
      isTurn: false, hasActedThisRound: false, handRank: '',
      seatIndex: seat, joinedAt: Timestamp.now(), lastSeen: Timestamp.now(),
    });
  }

  // Only players with chips who are not left
  players = players.filter(
    p => p.chips > 0 && p.seatStatus !== 'LEFT_SEAT' && !p.leaveRequested
  );

  if (players.length < 2) return null;

  players.sort((a, b) => a.seatIndex - b.seatIndex);

  const handNumber = (table.handNumber || 0) + 1;
  const n          = players.length;
  const dealerIdx  = handNumber % n;
  const sbIdx      = (dealerIdx + 1) % n;
  const bbIdx      = (dealerIdx + 2) % n;

  players.forEach((p, i) => {
    p.holeCards          = [];
    p.bet                = 0;
    p.totalBet           = 0;
    // DISCONNECTED players get dealt in; AFK system auto-folds them
    p.status             = p.seatStatus === 'DISCONNECTED' ? 'disconnected' : 'active';
    p.isTurn             = false;
    p.hasActedThisRound  = false;
    p.handRank           = '';
    p.lastAction         = null;
    p.lastActionAmount   = null;
    p.isDealer           = i === dealerIdx;
    p.isSmallBlind       = i === sbIdx;
    p.isBigBlind         = i === bbIdx;
    p.missedTurns        = 0;
    p.afkWarningAt       = null;
    p.leaveRequested     = false;
    p.lastSeen           = Timestamp.now();
    p.turnStartedAt      = null;
  });

  const deck = shuffleDeck(createDeck());
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) {
      const pi = (dealerIdx + 1 + i) % n;
      players[pi].holeCards.push(deck.pop()!);
    }
  }

  const sbAmt = Math.min(table.smallBlind, players[sbIdx].chips);
  players[sbIdx].chips   -= sbAmt;
  players[sbIdx].bet      = sbAmt;
  players[sbIdx].totalBet = sbAmt;
  players[sbIdx].lastAction       = 'blind';
  players[sbIdx].lastActionAmount = sbAmt;
  if (players[sbIdx].chips === 0) players[sbIdx].status = 'allin';

  const bbAmt = Math.min(table.bigBlind, players[bbIdx].chips);
  players[bbIdx].chips   -= bbAmt;
  players[bbIdx].bet      = bbAmt;
  players[bbIdx].totalBet = bbAmt;
  players[bbIdx].lastAction       = 'blind';
  players[bbIdx].lastActionAmount = bbAmt;
  if (players[bbIdx].chips === 0) players[bbIdx].status = 'allin';

  const currentBet = Math.max(table.bigBlind, bbAmt);
  const pot        = sbAmt + bbAmt;

  // Find first active player to act (skip disconnected/allin)
  let firstToActIdx = (bbIdx + 1) % n;
  let attempts      = 0;
  while (players[firstToActIdx].status !== 'active' && attempts++ < n) {
    firstToActIdx = (firstToActIdx + 1) % n;
  }
  if (players[firstToActIdx].status !== 'active') firstToActIdx = -1;
  else {
    players[firstToActIdx].isTurn        = true;
    players[firstToActIdx].turnStartedAt = Timestamp.now();
  }

  return {
    handNumber,
    update: {
      ...cleanHandState(),
      status:           'playing',
      phase:            'preflop',
      communityCards:   [],
      deck,
      pot,
      currentBet,
      sidePots:         [],
      dealerSeat:       dealerIdx,
      activePlayerUid:  firstToActIdx >= 0 ? players[firstToActIdx].uid : null,
      turnExpiresAt:    firstToActIdx >= 0
        ? Timestamp.fromDate(new Date(Date.now() + TURN_SECS * 1000))
        : null,
      afkWarningUid:    null,
      afkWarningEndsAt: null,
      nextHandAt:       null,
      players:          sp(players),
      spectatorQueue:   queue,
      handNumber,
      updatedAt:        FieldValue.serverTimestamp(),
      lastActionAt:     FieldValue.serverTimestamp(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// settleHand
// ─────────────────────────────────────────────────────────────────────────────
async function settleHand(
  tx:             FirebaseFirestore.Transaction,
  tableRef:       FirebaseFirestore.DocumentReference,
  table:          PokerTable,
  players:        PokerPlayer[],
  communityCards: Card[],
  spectatorQueue: any[],
): Promise<{
  payouts:      Array<{ uid: string; amount: number; totalBet: number; name: string; handRank: string }>;
  brokePlayers: Array<{ uid: string; name: string }>;
  allPlayers:   PokerPlayer[];
}> {
  const sidePots   = buildSidePots(players);
  const contenders = players.filter(p => p.status === 'active' || p.status === 'allin');
  const wasAllIn   = contenders.length >= 2 && contenders.every(p => p.status === 'allin');

  // Snapshot before any mutation
  const snapshot = players.map(p => ({ ...p }));

  // Evaluate hands
  contenders.forEach(p => {
    if (communityCards.length >= 3)
      p.handRank = evalBest([...p.holeCards, ...communityCards]).name;
  });

  // Compute wins
  const wins: Record<string, number> = {};

  const awardPot = (eligible: PokerPlayer[], potAmount: number) => {
    if (potAmount <= 0 || !eligible.length) return;
    let best = { rank: -1, name: '', kickers: [] as number[] };
    let winners: PokerPlayer[] = [];
    for (const p of eligible) {
      const hand = evalBest([...p.holeCards, ...communityCards]);
      const c    = cmpHands(hand, best);
      if (c > 0) { best = hand; winners = [p]; }
      else if (c === 0) winners.push(p);
    }
    if (!winners.length) return;
    const share     = Math.floor(potAmount / winners.length);
    const remainder = potAmount - share * winners.length;
    winners.forEach(w => { wins[w.uid] = (wins[w.uid] || 0) + share; });
    if (remainder > 0) {
      const sorted = [...winners].sort((a, b) =>
        ((a.seatIndex - table.dealerSeat + 6) % 6) -
        ((b.seatIndex - table.dealerSeat + 6) % 6)
      );
      wins[sorted[0].uid] = (wins[sorted[0].uid] || 0) + remainder;
    }
  };

  if (sidePots.length === 0) {
    awardPot(contenders, players.reduce((s, p) => s + p.totalBet, 0));
  } else {
    for (const pot of sidePots)
      awardPot(contenders.filter(p => pot.eligibleUids.includes(p.uid)), pot.amount);
  }

  // cleanPlayer() on ALL players with final chip counts
  const settledPlayers = players.map(p => cleanPlayer(p, p.chips + (wins[p.uid] || 0)));

  const brokePlayers: Array<{ uid: string; name: string }> = [];
  settledPlayers.forEach(p => {
    if (p.chips <= 0) brokePlayers.push({ uid: p.uid, name: p.name });
  });

  const { showdownPlayers, seated, newSpectators } = separatePlayersAfterHand(settledPlayers);

  const finalQueue = [
    ...spectatorQueue.filter(s => !newSpectators.some((ns: any) => ns.uid === s.uid)),
    ...newSpectators,
  ];

  const winnerUid = Object.keys(wins).length > 0
    ? Object.entries(wins).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  // hasEnough: seated includes DISCONNECTED players with chips
  const hasEnough =
    seated.filter(p => p.chips > 0).length >= 2 ||
    finalQueue.filter(s => !s.isSpectator && (s.buyIn || 0) > 0).length > 0;

  // Restore holeCards + handRank for showdown display
  const displayPlayers = showdownPlayers.map(p => {
    const orig = snapshot.find(s => s.uid === p.uid);
    return {
      ...p,
      holeCards: orig?.holeCards || [],
      handRank:  orig?.handRank  || p.handRank || '',
    };
  });

  tx.update(tableRef, {
    ...cleanHandState(),
    communityCards,           // keep visible during showdown display
    phase:            'showdown',
    status:           'waiting',
    players:          sp(displayPlayers),
    spectatorQueue:   finalQueue,
    lastBrokePlayers: brokePlayers,
    lastWinner:       winnerUid,
    lastHandWins:     wins,
    lastHandAllIn:    wasAllIn,
    nextHandAt:       hasEnough
      ? Timestamp.fromDate(new Date(Date.now() + SHOWDOWN_SECS * 1000))
      : null,
    updatedAt:        FieldValue.serverTimestamp(),
    lastActionAt:     FieldValue.serverTimestamp(),
  });

  const payouts = Object.entries(wins)
    .filter(([, a]) => a > 0)
    .map(([uid, amount]) => {
      const s = snapshot.find(p => p.uid === uid);
      return { uid, amount, totalBet: s?.totalBet || 0, name: s?.name || '', handRank: s?.handRank || '' };
    });

  return { payouts, brokePlayers, allPlayers: snapshot };
}

// ─────────────────────────────────────────────────────────────────────────────
// processPayouts
// ─────────────────────────────────────────────────────────────────────────────
async function processPayouts(
  payouts:    Array<{ uid: string; amount: number; totalBet: number; name: string; handRank: string }>,
  allPlayers: PokerPlayer[],
  tableName:  string,
  tableId:    string,
  handNumber: number,
): Promise<void> {
  for (const { uid, amount, totalBet, handRank } of payouts) {
    if (amount <= 0) continue;
    const net = amount - totalBet;
    if (net <= 0) continue;
    try {
      await betHistory({
        action: 'ADD', uid, game: 'Poker', amount: net, type: 'BET_WIN',
        description: `Win|Hand#${handNumber}|"${handRank}"|Table:"${tableName}"|Bet:₹${totalBet}Won:₹${net}`,
        idempotencyKey: `poker_win_${tableId}_${uid}_${handNumber}`,
      });
    } catch (e) { console.error('[WIN]', { tableId, handNumber, uid, net, e }); }
  }

  const winSet = new Set(payouts.map(p => p.uid));
  const losers = [
    ...allPlayers
      .filter(p => !winSet.has(p.uid) && p.totalBet > 0 && p.status !== 'left')
      .map(p => ({ uid: p.uid, lossAmt: p.totalBet, handRank: p.handRank || 'Folded' })),
    ...payouts
      .filter(p => p.amount - p.totalBet < 0)
      .map(p => ({ uid: p.uid, lossAmt: p.totalBet - p.amount, handRank: p.handRank })),
  ];

  for (const { uid, lossAmt, handRank } of losers) {
    if (lossAmt <= 0) continue;
    try {
      await betHistory({
        action: 'DEDUCT', uid, game: 'Poker', amount: lossAmt, type: 'BET_LOSS',
        description: `Loss|Hand#${handNumber}|"${handRank}"|Table:"${tableName}"|Lost:₹${lossAmt}`,
        idempotencyKey: `poker_loss_${tableId}_${uid}_${handNumber}`,
      });
    } catch (e) { console.error('[LOSS]', { tableId, handNumber, uid, lossAmt, e }); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// advancePhase
// ─────────────────────────────────────────────────────────────────────────────
async function advancePhase(
  tx:        FirebaseFirestore.Transaction,
  tableRef:  FirebaseFirestore.DocumentReference,
  table:     PokerTable,
  players:   PokerPlayer[],
  deck:      Card[],
  community: Card[],
  pot:       number,
  queue:     any[],
): Promise<{ settled: boolean; payouts: any[]; allPlayers: PokerPlayer[] }> {
  const active = players.filter(p => p.status === 'active');
  const allIn  = players.filter(p => p.status === 'allin');

  if (active.length === 0 && allIn.length >= 2) {
    resetStreet(players);
    while (community.length < 5) dealCards(deck, community, 1);
    const r = await settleHand(tx, tableRef, table, players, community, queue);
    return { settled: true, ...r };
  }

  let nextPhase: PokerPhase;
  let toDeal: number;
  if      (table.phase === 'preflop') { nextPhase = 'flop';  toDeal = 3; }
  else if (table.phase === 'flop')    { nextPhase = 'turn';  toDeal = 1; }
  else if (table.phase === 'turn')    { nextPhase = 'river'; toDeal = 1; }
  else {
    const r = await settleHand(tx, tableRef, table, players, community, queue);
    return { settled: true, ...r };
  }

  resetStreet(players);
  dealCards(deck, community, toDeal);

  const stillActive = players.filter(p => p.status === 'active');
  if (stillActive.length === 0 && players.filter(p => p.status === 'allin').length >= 2) {
    while (community.length < 5) dealCards(deck, community, 1);
    const r = await settleHand(tx, tableRef, table, players, community, queue);
    return { settled: true, ...r };
  }

  const di   = players.findIndex(p => p.isDealer);
  const fi   = nextActiveIdx(players, di !== -1 ? di : -1);
  const fp   = fi !== -1 ? players[fi] : null;
  if (fp) { fp.isTurn = true; fp.turnStartedAt = Timestamp.now(); }

  tx.update(tableRef, {
    players:          sp(players),
    deck,
    communityCards:   community,
    phase:            nextPhase,
    pot,
    currentBet:       0,
    sidePots:         buildSidePots(players),
    activePlayerUid:  fp?.uid || null,
    turnExpiresAt:    fp ? Timestamp.fromDate(new Date(Date.now() + TURN_SECS * 1000)) : null,
    afkWarningUid:    null,
    afkWarningEndsAt: null,
    updatedAt:        FieldValue.serverTimestamp(),
    lastActionAt:     FieldValue.serverTimestamp(),
  });

  return { settled: false, payouts: [], allPlayers: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// executeAction
// ─────────────────────────────────────────────────────────────────────────────
interface ActionResult {
  payouts:             Array<{ uid: string; amount: number; totalBet: number; name: string; handRank: string }>;
  allPlayers:          PokerPlayer[];
  tableName:           string;
  handNumber:          number;
  settled:             boolean;
  everyoneLeft:        boolean;
  everyoneLeftPlayers: PokerPlayer[];
}

async function executeAction(
  tableId:      string,
  actingUid:    string,
  action:       string,
  raiseAmount?: number,
): Promise<ActionResult> {
  let payouts: any[]          = [];
  let allPlayers: PokerPlayer[] = [];
  let tableName   = '';
  let handNumber  = 0;
  let settled     = false;
  let everyoneLeft = false;
  let everyoneLeftPlayers: PokerPlayer[] = [];

  await db.runTransaction(async tx => {
    const tableRef = db.collection(POKER).doc(tableId);
    const snap     = await tx.get(tableRef);
    if (!snap.exists) throw new Error('Table not found');
    const table = snap.data() as PokerTable;

    tableName  = table.name;
    handNumber = table.handNumber || 1;

    if (table.activePlayerUid !== actingUid) throw new Error('Not your turn');
    if (table.status !== 'playing')           throw new Error('Game not in progress');
    if (table.phase === 'waiting' || table.phase === 'showdown')
      throw new Error('No active hand');

    let players  = table.players.map(p => ({ ...p }));
    let queue    = [...(table.spectatorQueue || [])];
    const deck   = [...table.deck];
    const comm   = [...table.communityCards];
    let pot      = table.pot;
    let curBet   = table.currentBet;

    const pIdx = players.findIndex(p => p.uid === actingUid);
    if (pIdx === -1) throw new Error('Player not found');
    const player = players[pIdx];
    if (player.status !== 'active') throw new Error('You cannot act in your current status');

    switch (action) {
      case 'fold': {
        player.status            = 'folded';
        player.isTurn            = false;
        player.hasActedThisRound = true;
        player.lastAction        = 'fold';
        player.holeCards         = [];
        player.turnStartedAt     = null;
        break;
      }
      case 'check': {
        if (player.bet < curBet)
          throw new Error(`Cannot check — must call ₹${curBet - player.bet} or raise`);
        player.isTurn            = false;
        player.hasActedThisRound = true;
        player.lastAction        = 'check';
        player.turnStartedAt     = null;
        break;
      }
      case 'call': {
        const toCall = Math.min(curBet - player.bet, player.chips);
        if (toCall <= 0) throw new Error('Nothing to call');
        player.chips    -= toCall;
        player.bet      += toCall;
        player.totalBet += toCall;
        pot             += toCall;
        if (player.chips === 0) player.status = 'allin';
        player.isTurn            = false;
        player.hasActedThisRound = true;
        player.lastAction        = 'call';
        player.lastActionAmount  = toCall;
        player.turnStartedAt     = null;
        break;
      }
      case 'raise': {
        const minT = curBet + Math.max(curBet, table.bigBlind);
        const maxT = player.chips + player.bet;
        if (!raiseAmount || raiseAmount < minT)
          throw new Error(`Minimum raise is ₹${minT}`);
        if (raiseAmount > maxT)
          throw new Error(`Cannot raise more than your stack (₹${maxT})`);
        const toAdd = Math.min(raiseAmount - player.bet, player.chips);
        player.chips    -= toAdd;
        player.bet      += toAdd;
        player.totalBet += toAdd;
        pot             += toAdd;
        curBet           = player.bet;
        if (player.chips === 0) player.status = 'allin';
        player.isTurn            = false;
        player.hasActedThisRound = true;
        player.lastAction        = 'raise';
        player.lastActionAmount  = player.bet;
        player.turnStartedAt     = null;
        players.forEach((p, i) => {
          if (i !== pIdx && p.status === 'active' && p.bet < curBet)
            p.hasActedThisRound = false;
        });
        break;
      }
      case 'allin': {
        const amt = player.chips;
        if (amt <= 0) throw new Error('No chips to go all-in with');
        player.chips     = 0;
        player.bet      += amt;
        player.totalBet += amt;
        pot             += amt;
        player.status    = 'allin';
        player.isTurn    = false;
        player.hasActedThisRound = true;
        player.lastAction        = 'allin';
        player.lastActionAmount  = amt;
        player.turnStartedAt     = null;
        if (player.bet > curBet) {
          curBet = player.bet;
          players.forEach((p, i) => {
            if (i !== pIdx && p.status === 'active' && p.bet < curBet)
              p.hasActedThisRound = false;
          });
        }
        break;
      }
      default: throw new Error(`Unknown action: ${action}`);
    }

    player.missedTurns  = 0;
    player.seatStatus   = 'ACTIVE';
    player.afkWarningAt = null;
    player.lastSeen     = Timestamp.now();
    players[pIdx]       = player;

    const nonFolded = players.filter(p => p.status !== 'folded' && p.status !== 'left');

    // Everyone folded
    if (nonFolded.length === 0) {
      tx.update(tableRef, {
        ...cleanHandState(),
        players:      sp(players.map(p => cleanPlayer(p, p.chips))),
        phase:        'waiting',
        status:       'waiting',
        updatedAt:    FieldValue.serverTimestamp(),
        lastActionAt: FieldValue.serverTimestamp(),
      });
      everyoneLeftPlayers = table.players;
      everyoneLeft        = true;
      return;
    }

    // One winner by fold
    if (nonFolded.length === 1) {
      const winner   = { ...nonFolded[0] };
      const snapshot = players.map(p => ({ ...p }));

      const settled1 = players.map(p =>
        cleanPlayer(p, p.uid === winner.uid ? p.chips + pot : p.chips)
      );
      const { showdownPlayers, seated, newSpectators } = separatePlayersAfterHand(settled1);
      const finalQueue = [
        ...queue.filter(s => !newSpectators.some((ns: any) => ns.uid === s.uid)),
        ...newSpectators,
      ];
      const brokePlayers: any[] = [];
      settled1.forEach(p => { if (p.chips <= 0) brokePlayers.push({ uid: p.uid, name: p.name }); });
      const hasEnough =
        seated.filter(p => p.chips > 0).length >= 2 ||
        finalQueue.filter(s => !s.isSpectator && (s.buyIn || 0) > 0).length > 0;

      const displayPlayers = showdownPlayers.map(p => ({
        ...p,
        holeCards: p.uid === winner.uid ? (snapshot.find(s => s.uid === p.uid)?.holeCards || []) : [],
        handRank:  p.uid === winner.uid ? 'Won by Fold' : '',
      }));

      tx.update(tableRef, {
        ...cleanHandState(),
        communityCards:   comm,
        players:          sp(displayPlayers),
        spectatorQueue:   finalQueue,
        phase:            'showdown',
        status:           'waiting',
        nextHandAt:       hasEnough
          ? Timestamp.fromDate(new Date(Date.now() + SHOWDOWN_SECS * 1000))
          : null,
        lastWinner:       winner.uid,
        lastHandWins:     { [winner.uid]: pot },
        lastHandAllIn:    false,
        lastBrokePlayers: brokePlayers,
        updatedAt:        FieldValue.serverTimestamp(),
        lastActionAt:     FieldValue.serverTimestamp(),
      });

      payouts    = [{
        uid:      winner.uid,
        amount:   pot,
        totalBet: snapshot.find(p => p.uid === winner.uid)?.totalBet || 0,
        name:     winner.name,
        handRank: 'Won by Fold',
      }];
      allPlayers = snapshot;
      settled    = true;
      return;
    }

    // Betting complete — advance phase
    if (bettingComplete(players, curBet)) {
      const result = await advancePhase(tx, tableRef, table, players, deck, comm, pot, queue);
      if (result.settled) {
        payouts    = result.payouts;
        allPlayers = result.allPlayers;
        settled    = true;
      }
      return;
    }

    // Continue — next player
    const nextIdx = nextActiveIdx(players, pIdx);
    const next    = nextIdx !== -1 ? players[nextIdx] : null;
    if (next) { next.isTurn = true; next.turnStartedAt = Timestamp.now(); }

    tx.update(tableRef, {
      players:          sp(players),
      pot,
      currentBet:       curBet,
      sidePots:         buildSidePots(players),
      activePlayerUid:  next?.uid || null,
      turnExpiresAt:    next
        ? Timestamp.fromDate(new Date(Date.now() + TURN_SECS * 1000))
        : null,
      afkWarningUid:    null,
      afkWarningEndsAt: null,
      updatedAt:        FieldValue.serverTimestamp(),
      lastActionAt:     FieldValue.serverTimestamp(),
    });
  });

  return { payouts, allPlayers, tableName, handNumber, settled, everyoneLeft, everyoneLeftPlayers };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Handler — the entire switch lives inside this async function
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { type, ...body } = req.body ?? {};
  if (!type) { res.status(400).json({ error: 'type required' }); return; }

  let uid = '';
  try { uid = await verifyToken(req); }
  catch (e: any) { res.status(e.status || 401).json({ error: e.message }); return; }

  sanitize(body, ['tableId']);
  const { tableId } = body;
  const tableRef    = db.collection(POKER).doc(tableId);

  try {

    // ── JOIN ─────────────────────────────────────────────────────────────────
    if (type === 'join') {
      sanitize(body, ['name', 'buyIn']);
      const { name, avatar, buyIn, seatIndex } = body;

      if (typeof buyIn !== 'number' || buyIn < 0) {
        res.status(400).json({ error: 'Invalid buy-in' }); return;
      }

      const snap = await tableRef.get();
      if (!snap.exists) { res.status(404).json({ error: 'Table not found' }); return; }
      const table = snap.data() as PokerTable;

      const existing = table.players.find(p => p.uid === uid);
      if (existing && existing.seatStatus !== 'LEFT_SEAT') {
        res.status(409).json({ error: 'Already at table' }); return;
      }
      if ((table.spectatorQueue || []).some((s: any) => s.uid === uid && !s.isSpectator)) {
        res.status(409).json({ error: 'Already in queue' }); return;
      }

      if (buyIn > 0) {
        if (buyIn < table.minBuyIn) { res.status(400).json({ error: `Min ₹${table.minBuyIn}` }); return; }
        if (buyIn > table.maxBuyIn) { res.status(400).json({ error: `Max ₹${table.maxBuyIn}` }); return; }
      }

      const activeSeated = table.players.filter(p => p.seatStatus !== 'LEFT_SEAT').length;

      if (buyIn === 0 || activeSeated >= 6 || table.status === 'playing') {
        await tableRef.update({
          spectatorQueue: FieldValue.arrayUnion({
            uid, name, avatar: avatar || '', buyIn,
            seatIndex: seatIndex ?? null,
            joinedAt:    Timestamp.now(),
            isSpectator: buyIn === 0,
          }),
          updatedAt: FieldValue.serverTimestamp(),
        });
        res.status(200).json({ role: 'spectator' }); return;
      }

      const joinTs = Date.now();
      try {
        await internalWalletTransaction({
          action: 'DEDUCT', uid, amount: buyIn, balanceType: 'winningBalance',
          type: 'GAME_ENTRY', game: 'Poker',
          description: `Poker buy-in at "${table.name}"`,
          idempotencyKey: `poker_join_${tableId}_${uid}_${joinTs}`,
        });
      } catch (e: any) { res.status(402).json({ error: e.message || 'Insufficient balance' }); return; }

      try {
        await db.runTransaction(async tx => {
          const t   = await tx.get(tableRef);
          if (!t.exists) throw new Error('Table gone');
          const cur = t.data() as PokerTable;
          const ex  = cur.players.find(p => p.uid === uid);
          if (ex && ex.seatStatus !== 'LEFT_SEAT') throw new Error('Already joined');
          const ac  = cur.players.filter(p => p.seatStatus !== 'LEFT_SEAT').length;
          if (ac >= 6) throw new Error('Table full');
          const occ = new Set(cur.players.filter(p => p.seatStatus !== 'LEFT_SEAT').map(p => p.seatIndex));
          let seat  = seatIndex ?? -1;
          if (seat === -1 || occ.has(seat)) { seat = 0; while (occ.has(seat)) seat++; }
          const newP: PokerPlayer = {
            uid, name, avatar: avatar || '', chips: buyIn,
            holeCards: [], bet: 0, totalBet: 0,
            status: 'waiting', seatStatus: 'ACTIVE', missedTurns: 0,
            isDealer: false, isSmallBlind: false, isBigBlind: false,
            isTurn: false, hasActedThisRound: false, handRank: '',
            seatIndex: seat, joinedAt: Timestamp.now(), lastSeen: Timestamp.now(),
          };
          const updP = ex
            ? cur.players.map(p => p.uid === uid ? newP : p)
            : [...cur.players, newP];
          tx.update(tableRef, {
            players:        sp(updP),
            spectatorQueue: cur.spectatorQueue.filter((s: any) => s.uid !== uid),
            updatedAt:      FieldValue.serverTimestamp(),
          });
        });
      } catch (e: any) {
        await internalWalletTransaction({
          action: 'ADD', uid, amount: buyIn, balanceType: 'winningBalance',
          type: 'REFUND', game: 'Poker', description: 'Refund: join failed',
          idempotencyKey: `poker_join_refund_${tableId}_${uid}_${joinTs}`,
        }).catch(() => {});
        res.status(500).json({ error: e.message }); return;
      }
      res.status(200).json({ role: 'player' }); return;
    }

    // ── TAKE SEAT ─────────────────────────────────────────────────────────────
    if (type === 'take-seat') {
      const { seatIndex, buyIn } = body;
      const snap = await tableRef.get();
      if (!snap.exists) { res.status(404).json({ error: 'Table not found' }); return; }
      const table = snap.data() as PokerTable;

      const existing = table.players.find(p => p.uid === uid);
      if (existing && existing.seatStatus !== 'LEFT_SEAT') {
        res.status(409).json({ error: 'Already seated' }); return;
      }
      if (table.status === 'playing') {
        res.status(400).json({ error: 'Hand in progress — wait' }); return;
      }
      if (typeof buyIn !== 'number' || buyIn <= 0) {
        res.status(400).json({ error: 'Invalid buy-in' }); return;
      }
      if (buyIn < table.minBuyIn) { res.status(400).json({ error: `Min ₹${table.minBuyIn}` }); return; }
      if (buyIn > table.maxBuyIn) { res.status(400).json({ error: `Max ₹${table.maxBuyIn}` }); return; }

      const occ = new Set(table.players.filter(p => p.seatStatus !== 'LEFT_SEAT').map(p => p.seatIndex));
      if (seatIndex !== undefined) {
        if (seatIndex < 0 || seatIndex > 5) { res.status(400).json({ error: 'Invalid seat' }); return; }
        if (occ.has(seatIndex)) { res.status(409).json({ error: 'Seat occupied' }); return; }
      } else if (occ.size >= 6) { res.status(409).json({ error: 'Table full' }); return; }

      const joinTs = Date.now();
      try {
        await internalWalletTransaction({
          action: 'DEDUCT', uid, amount: buyIn, balanceType: 'winningBalance',
          type: 'GAME_ENTRY', game: 'Poker',
          description: `Poker take-seat at "${table.name}"`,
          idempotencyKey: `poker_takeseat_${tableId}_${uid}_${joinTs}`,
        });
      } catch (e: any) { res.status(402).json({ error: e.message || 'Insufficient balance' }); return; }

      try {
        await db.runTransaction(async tx => {
          const t   = await tx.get(tableRef);
          if (!t.exists) throw new Error('Table gone');
          const cur = t.data() as PokerTable;
          const occ2 = new Set(cur.players.filter(p => p.seatStatus !== 'LEFT_SEAT').map(p => p.seatIndex));
          let seat   = seatIndex ?? -1;
          if (seat === -1 || occ2.has(seat)) { seat = 0; while (occ2.has(seat) && seat < 6) seat++; }
          if (seat >= 6) throw new Error('No seats');
          const spec = cur.spectatorQueue.find((s: any) => s.uid === uid);
          const newP: PokerPlayer = {
            uid,
            name:   existing?.name || spec?.name || 'Player',
            avatar: existing?.avatar || spec?.avatar || '',
            chips: buyIn, holeCards: [], bet: 0, totalBet: 0,
            status: 'waiting', seatStatus: 'ACTIVE', missedTurns: 0,
            isDealer: false, isSmallBlind: false, isBigBlind: false,
            isTurn: false, hasActedThisRound: false, handRank: '',
            seatIndex: seat, joinedAt: Timestamp.now(), lastSeen: Timestamp.now(),
          };
          const updP = existing
            ? sp(cur.players.map(p => p.uid === uid ? newP : p))
            : sp([...cur.players.filter(p => p.uid !== uid), newP]);
          tx.update(tableRef, {
            players:        updP,
            spectatorQueue: cur.spectatorQueue.filter((s: any) => s.uid !== uid),
            updatedAt:      FieldValue.serverTimestamp(),
          });
        });
      } catch (e: any) {
        await internalWalletTransaction({
          action: 'ADD', uid, amount: buyIn, balanceType: 'winningBalance',
          type: 'REFUND', game: 'Poker', description: 'Refund: take-seat failed',
          idempotencyKey: `poker_takeseat_refund_${tableId}_${uid}_${joinTs}`,
        }).catch(() => {});
        res.status(500).json({ error: e.message }); return;
      }
      res.status(200).json({ ok: true, role: 'player' }); return;
    }

    // ── RESERVE SEAT ──────────────────────────────────────────────────────────
    if (type === 'reserve-seat') {
      const { seatIndex } = body;
      if (seatIndex === undefined || seatIndex < 0 || seatIndex > 5) {
        res.status(400).json({ error: 'Invalid seat' }); return;
      }
      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) throw new Error('Table not found');
        const table    = snap.data() as PokerTable;
        const reserved = (table.reservedSeats || {})[seatIndex];
        if (table.players.some(p => p.seatIndex === seatIndex && p.seatStatus !== 'LEFT_SEAT'))
          throw new Error('Occupied');
        if (reserved && reserved.uid !== uid && Date.now() < reserved.until)
          throw new Error('Reserved');
        tx.update(tableRef, {
          [`reservedSeats.${seatIndex}`]: { uid, until: Date.now() + 60_000 },
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.status(200).json({ ok: true, reservedUntil: Date.now() + 60_000 }); return;
    }

    // ── RELEASE SEAT ──────────────────────────────────────────────────────────
    if (type === 'release-seat') {
      const { seatIndex } = body;
      if (seatIndex === undefined) { res.status(400).json({ error: 'seatIndex required' }); return; }
      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) return;
        const table    = snap.data() as PokerTable;
        const reserved = (table.reservedSeats || {})[seatIndex];
        if (!reserved || reserved.uid !== uid) return;
        tx.update(tableRef, {
          [`reservedSeats.${seatIndex}`]: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.status(200).json({ ok: true }); return;
    }

    // ── START HAND ────────────────────────────────────────────────────────────
    if (type === 'start-hand') {
      if (!tableId) { res.status(400).json({ error: 'tableId required' }); return; }
      try {
        await db.runTransaction(async tx => {
          const snap = await tx.get(tableRef);
          if (!snap.exists) throw new Error('Table not found');
          const table = snap.data() as PokerTable;

          if (table.status === 'playing') throw new Error('Hand already in progress');

          if (table.phase === 'showdown' && table.nextHandAt) {
            const readyAt = table.nextHandAt.toMillis
              ? table.nextHandAt.toMillis()
              : new Date(table.nextHandAt).getTime();
            if (Date.now() < readyAt - 500) throw new Error('Showdown in progress — wait');
          }
          // nextHandAt === null is allowed — means hasEnough was previously wrong

          // Pre-clean all players through cleanPlayer()
          const preCleaned = table.players.map(p => cleanPlayer(p, p.chips));
          const { seated, newSpectators } = separatePlayersAfterHand(preCleaned);

          const mergedQueue = [
            ...(table.spectatorQueue || []).filter(
              s => !newSpectators.some((ns: any) => ns.uid === s.uid)
            ),
            ...newSpectators,
          ];

          const fresh = buildFreshHandState(table, seated, mergedQueue);
          if (!fresh) throw new Error('Need at least 2 players to start');

          tx.update(tableRef, fresh.update);
        });
        res.status(200).json({ ok: true }); return;
      } catch (e: any) {
        const expected = [
          'Hand already in progress',
          'Showdown in progress — wait',
          'Need at least 2 players to start',
          'Table not found',
        ];
        res.status(expected.includes(e.message) ? 400 : 500).json({ error: e.message }); return;
      }
    }

    // ── ACTION ────────────────────────────────────────────────────────────────
    if (type === 'action') {
      sanitize(body, ['action']);
      const { action, raiseAmount } = body;
      if (!['fold', 'check', 'call', 'raise', 'allin'].includes(action)) {
        res.status(400).json({ error: 'Invalid action' }); return;
      }
      if (action === 'raise' && (typeof raiseAmount !== 'number' || raiseAmount <= 0)) {
        res.status(400).json({ error: 'raiseAmount required' }); return;
      }
      const result = await executeAction(tableId, uid, action, raiseAmount);
      if (result.everyoneLeft) {
        for (const p of result.everyoneLeftPlayers) {
          if (p.chips > 0) {
            await internalWalletTransaction({
              action: 'ADD', uid: p.uid, amount: p.chips,
              balanceType: 'winningBalance', type: 'REFUND', game: 'Poker',
              description: 'Poker refund — all left',
              idempotencyKey: `poker_everyone_left_${tableId}_${result.handNumber}_${p.uid}`,
            }).catch(() => {});
          }
        }
      }
      if (result.settled && result.payouts.length)
        await processPayouts(result.payouts, result.allPlayers, result.tableName, tableId, result.handNumber);
      res.status(200).json({ ok: true }); return;
    }

    // ── AUTO-FOLD ─────────────────────────────────────────────────────────────
    if (type === 'auto-fold') {
      const snap = await tableRef.get();
      if (!snap.exists) { res.status(404).json({ error: 'Table not found' }); return; }
      const table = snap.data() as PokerTable;

      if (!table.activePlayerUid || !table.turnExpiresAt) {
        res.status(200).json({ ok: true, action: 'none' }); return;
      }
      const now       = Date.now();
      const expiresAt = table.turnExpiresAt instanceof Timestamp
        ? table.turnExpiresAt.toMillis()
        : (table.turnExpiresAt as any)?._seconds * 1000;
      if (now < expiresAt) {
        res.status(200).json({ ok: true, action: 'not_expired' }); return;
      }

      const activeUid = table.activePlayerUid;
      const player    = table.players.find(p => p.uid === activeUid);
      if (!player) { res.status(200).json({ ok: true, action: 'none' }); return; }

      const missed = player.missedTurns || 0;

      if (player.seatStatus === 'AFK_WARNING' && table.afkWarningEndsAt) {
        const warnExp = table.afkWarningEndsAt instanceof Timestamp
          ? table.afkWarningEndsAt.toMillis()
          : (table.afkWarningEndsAt as any)?._seconds * 1000;
        if (now < warnExp) { res.status(200).json({ ok: true, action: 'warning_active' }); return; }

        const autoAct = player.bet >= table.currentBet ? 'check' : 'fold';
        let result: ActionResult;
        try { result = await executeAction(tableId, activeUid, autoAct); }
        catch { res.status(200).json({ ok: true, action: 'already_handled' }); return; }

        if (!result.settled) {
          await db.runTransaction(async tx => {
            const fs = await tx.get(tableRef);
            if (!fs.exists) return;
            const ft = fs.data() as PokerTable;
            tx.update(tableRef, {
              players: sp(ft.players.map(p =>
                p.uid === activeUid
                  ? { ...p, seatStatus: 'LEFT_SEAT' as SeatStatus, missedTurns: 0, afkWarningAt: null }
                  : p
              )),
              spectatorQueue: [
                ...ft.spectatorQueue.filter((s: any) => s.uid !== activeUid),
                { uid: activeUid, name: player.name, avatar: player.avatar || '', buyIn: 0, seatIndex: null, joinedAt: Timestamp.now(), isSpectator: true },
              ],
              afkWarningUid:    null,
              afkWarningEndsAt: null,
              updatedAt:        FieldValue.serverTimestamp(),
            });
          });
        }
        if (result.settled && result.payouts.length)
          await processPayouts(result.payouts, result.allPlayers, result.tableName, tableId, result.handNumber);
        res.status(200).json({ ok: true, action: 'afk_seat_removed' }); return;
      }

      const newMissed = missed + 1;
      const autoAct   = player.bet >= table.currentBet ? 'check' : 'fold';
      let result: ActionResult;
      try { result = await executeAction(tableId, activeUid, autoAct); }
      catch { res.status(200).json({ ok: true, action: 'already_handled' }); return; }

      if (result.settled && result.payouts.length) {
        await processPayouts(result.payouts, result.allPlayers, result.tableName, tableId, result.handNumber);
        res.status(200).json({ ok: true, action: autoAct }); return;
      }
      if (!result.settled) {
        await db.runTransaction(async tx => {
          const fs = await tx.get(tableRef);
          if (!fs.exists) return;
          const ft  = fs.data() as PokerTable;
          const upd = ft.players.map(p =>
            p.uid === activeUid ? {
              ...p,
              missedTurns: newMissed,
              ...(newMissed >= 2 ? { seatStatus: 'AFK_WARNING' as SeatStatus, afkWarningAt: Timestamp.now() } : {}),
            } : p
          );
          tx.update(tableRef, { players: sp(upd), updatedAt: FieldValue.serverTimestamp() });
        });
      }
      res.status(200).json({ ok: true, action: autoAct }); return;
    }

    // ── START AFK WARNING ─────────────────────────────────────────────────────
    if (type === 'start-afk-warning') {
      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) return;
        const table     = snap.data() as PokerTable;
        const activeUid = table.activePlayerUid;
        if (!activeUid) return;
        const player = table.players.find(p => p.uid === activeUid);
        if (!player || (player.missedTurns || 0) < 1 || player.seatStatus === 'AFK_WARNING') return;
        const warnEndsAt = Timestamp.fromDate(new Date(Date.now() + AFK_WARNING_SECS * 1000));
        tx.update(tableRef, {
          players: sp(table.players.map(p =>
            p.uid === activeUid
              ? { ...p, seatStatus: 'AFK_WARNING' as SeatStatus, afkWarningAt: Timestamp.now() }
              : p
          )),
          turnExpiresAt:    warnEndsAt,
          afkWarningUid:    activeUid,
          afkWarningEndsAt: warnEndsAt,
          updatedAt:        FieldValue.serverTimestamp(),
        });
      });
      res.status(200).json({ ok: true }); return;
    }

    // ── LEAVE ─────────────────────────────────────────────────────────────────
    if (type === 'leave') {
      let chipsToReturn = 0;
      let tableName_    = '';
      let joinedAtMs    = 0;

      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) throw new Error('Table not found');
        const table   = snap.data() as PokerTable;
        const player  = table.players.find(p => p.uid === uid);
        const inQueue = (table.spectatorQueue || []).some((s: any) => s.uid === uid);
        if (!player && !inQueue) return;

        if (player) {
          chipsToReturn = player.chips;
          tableName_    = table.name;
          joinedAtMs    = player.joinedAt?.toMillis?.() || (player.joinedAt?._seconds || 0) * 1000;
        }

        const remP  = table.players.filter(p => p.uid !== uid);
        const remQ  = (table.spectatorQueue || []).filter((s: any) => s.uid !== uid);
        const update: Record<string, any> = {
          players:        sp(remP),
          spectatorQueue: remQ,
          updatedAt:      FieldValue.serverTimestamp(),
        };

        if (table.status === 'playing' && player) {
          const nonFolded = remP.filter(
            p => p.status !== 'folded' && p.status !== 'left' && p.seatStatus !== 'LEFT_SEAT'
          );
          if (nonFolded.length === 1) {
            const winner  = nonFolded[0];
            const finalP  = remP.map(p => ({
              ...cleanPlayer(p, p.uid === winner.uid ? p.chips + table.pot : p.chips),
              holeCards: p.uid === winner.uid ? p.holeCards : [],
              handRank:  p.uid === winner.uid ? 'Won by Fold' : '',
              seatStatus: (
                (p.chips + (p.uid === winner.uid ? table.pot : 0)) <= 0 || p.leaveRequested
                  ? 'LEFT_SEAT' : p.seatStatus
              ) as SeatStatus,
            }));
            Object.assign(update, {
              ...cleanHandState(),
              communityCards: table.communityCards,
              players:        sp(finalP),
              phase:          'showdown',
              status:         'waiting',
              nextHandAt:     Timestamp.fromDate(new Date(Date.now() + SHOWDOWN_SECS * 1000)),
              lastWinner:     winner.uid,
              lastHandWins:   { [winner.uid]: table.pot },
              lastHandAllIn:  false,
            });
          } else if (nonFolded.length === 0) {
            Object.assign(update, {
              ...cleanHandState(),
              players: sp(remP.map(p => cleanPlayer(p, p.chips))),
              phase:   'waiting',
              status:  'waiting',
            });
          } else if (table.activePlayerUid === uid) {
            const nextActive = remP.find(p => p.status === 'active');
            if (nextActive) {
              Object.assign(update, {
                players: sp(remP.map(p =>
                  p.uid === nextActive.uid
                    ? { ...p, isTurn: true, turnStartedAt: Timestamp.now() }
                    : p
                )),
                activePlayerUid:  nextActive.uid,
                turnExpiresAt:    Timestamp.fromDate(new Date(Date.now() + TURN_SECS * 1000)),
                afkWarningUid:    null,
                afkWarningEndsAt: null,
              });
            }
          }
        } else if (table.status !== 'playing') {
          if (remP.filter(p => p.seatStatus !== 'LEFT_SEAT').length < 2) {
            Object.assign(update, {
              ...cleanHandState(),
              phase:  'waiting',
              status: 'waiting',
            });
          }
        }

        tx.update(tableRef, update);
      });

      if (chipsToReturn > 0) {
        await internalWalletTransaction({
          action: 'ADD', uid, amount: chipsToReturn,
          balanceType: 'winningBalance', type: 'CASH_OUT', game: 'Poker',
          description: `Chips returned from "${tableName_}"`,
          idempotencyKey: `poker_leave_${tableId}_${uid}_${joinedAtMs}`,
        }).catch(e => console.error('[LEAVE]', e));
      }
      res.status(200).json({ ok: true }); return;
    }

    // ── REBUY ─────────────────────────────────────────────────────────────────
    if (type === 'rebuy') {
      sanitize(body, ['amount']);
      const { amount } = body;
      if (typeof amount !== 'number' || amount <= 0) {
        res.status(400).json({ error: 'Invalid amount' }); return;
      }
      const snap = await tableRef.get();
      if (!snap.exists) { res.status(404).json({ error: 'Table not found' }); return; }
      const table = snap.data() as PokerTable;
      const player = table.players.find(p => p.uid === uid);
      if (!player) { res.status(404).json({ error: 'Not at table' }); return; }
      if (player.chips > 0) { res.status(400).json({ error: 'You still have chips' }); return; }
      if (table.status === 'playing' && table.phase !== 'showdown') {
        res.status(400).json({ error: 'Hand in progress — wait' }); return;
      }
      if (amount < table.minBuyIn) { res.status(400).json({ error: `Min ₹${table.minBuyIn}` }); return; }
      if (amount > table.maxBuyIn) { res.status(400).json({ error: `Max ₹${table.maxBuyIn}` }); return; }

      const rebuyTs = Date.now();
      try {
        await internalWalletTransaction({
          action: 'DEDUCT', uid, amount, type: 'GAME_BET', game: 'Poker',
          description: `Rebuy at "${table.name}"`,
          idempotencyKey: `poker_rebuy_${tableId}_${uid}_${rebuyTs}`,
        });
      } catch (e: any) { res.status(402).json({ error: e.message || 'Insufficient balance' }); return; }

      try {
        await db.runTransaction(async tx => {
          const fs  = await tx.get(tableRef);
          if (!fs.exists) throw new Error('Table not found');
          const ft  = fs.data() as PokerTable;
          const idx = ft.players.findIndex(p => p.uid === uid);
          if (idx === -1) throw new Error('Player not found');
          tx.update(tableRef, {
            players:   sp(ft.players.map((p, i) => i === idx ? cleanPlayer({ ...p, chips: 0 }, amount) : p)),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (e: any) {
        await internalWalletTransaction({
          action: 'ADD', uid, amount, balanceType: 'winningBalance',
          type: 'REFUND', game: 'Poker', description: 'Refund: rebuy failed',
          idempotencyKey: `poker_rebuy_refund_${tableId}_${uid}_${rebuyTs}`,
        }).catch(() => {});
        res.status(500).json({ error: e.message || 'Rebuy failed' }); return;
      }
      res.status(200).json({ ok: true, newChips: amount }); return;
    }

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    if (type === 'disconnect') {
      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) return;
        const table = snap.data() as PokerTable;
        tx.update(tableRef, {
          players: sp(table.players.map(p =>
            p.uid === uid && (p.status === 'active' || p.status === 'waiting')
              ? { ...p, status: 'disconnected' as PlayerStatus, seatStatus: 'DISCONNECTED' as SeatStatus, disconnectedAt: Timestamp.now() }
              : p
          )),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.status(200).json({ ok: true }); return;
    }

    // ── RECONNECT ─────────────────────────────────────────────────────────────
    if (type === 'reconnect') {
      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) return;
        const table = snap.data() as PokerTable;
        tx.update(tableRef, {
          players: sp(table.players.map(p =>
            p.uid === uid && (p.status === 'disconnected' || p.seatStatus === 'DISCONNECTED')
              ? {
                  ...p,
                  status:         (table.status === 'playing' ? 'active' : 'waiting') as PlayerStatus,
                  seatStatus:     'ACTIVE' as SeatStatus,
                  disconnectedAt: null,
                  lastSeen:       Timestamp.now(),
                }
              : p
          )),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.status(200).json({ ok: true }); return;
    }

    // ── PING ──────────────────────────────────────────────────────────────────
    if (type === 'ping') {
      await db.runTransaction(async tx => {
        const snap = await tx.get(tableRef);
        if (!snap.exists) return;
        const table = snap.data() as PokerTable;
        tx.update(tableRef, {
          players:   sp(table.players.map(p => p.uid === uid ? { ...p, lastSeen: Timestamp.now() } : p)),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      res.status(200).json({ ok: true }); return;
    }

    // ── GET STATE ─────────────────────────────────────────────────────────────
    if (type === 'get-state') {
      const snap = await tableRef.get();
      if (!snap.exists) { res.status(404).json({ error: 'Table not found' }); return; }
      const table = snap.data() as PokerTable;
      res.status(200).json({
        ...table,
        deck: [],
        players: sp(table.players.map(p => ({
          ...p,
          holeCards:
            p.uid === uid ||
            table.phase === 'showdown' ||
            (table.lastHandAllIn && p.status === 'allin')
              ? p.holeCards
              : p.holeCards.map(() => ({ suit: 'back', value: '?', numericValue: 0 })),
        }))),
      });
      return;
    }

    // ── UNKNOWN ───────────────────────────────────────────────────────────────
    res.status(400).json({ error: `Unknown type: "${type}"` });

  } catch (err: any) {
    console.error(`[poker/${type}]`, err.message, err.stack);
    const status =
      err?.status ||
      (err.message?.includes('not found')       ? 404
       : err.message?.includes('Insufficient')  ? 402
       : err.message?.includes('Not your turn') ? 403
       : 500);
    res.status(status).json({ error: err.message || 'Internal server error' });
  }
}
