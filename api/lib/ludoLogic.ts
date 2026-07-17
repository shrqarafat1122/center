// api/lib/ludoLogic.ts
// Pure, server-safe Ludo rules engine — no Firestore/network calls here.
// 2 colors only: blue / green — a Ludo table always has exactly 2 players.

export type PlayerColor = 'blue' | 'green';
export type PawnId = 0 | 1;

export interface Pawn {
  id: PawnId;
  color: PlayerColor;
  /** 0..56 = on board/home-stretch, 57 = finished. Pawns start on board (no "waiting" state). */
  position: number;
  isFinished: boolean;
}

export type Pawns = Record<PlayerColor, [Pawn, Pawn]>;

export const OUTER_LEN = 52;
export const HOME_LEN = 5;
export const TOTAL_STEPS = OUTER_LEN + HOME_LEN; // 57 = finished

// Safe squares (no capture) — indices in each pawn's own path frame of reference.
const SAFE_OUTER_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export function createInitialPawns(color: PlayerColor): [Pawn, Pawn] {
  return [
    { id: 0, color, position: 0, isFinished: false },
    { id: 1, color, position: 0, isFinished: false },
  ];
}

export function createInitialPawnState(): Pawns {
  return { blue: createInitialPawns('blue'), green: createInitialPawns('green') };
}

export function canMovePawn(pawn: Pawn, diceValue: number): boolean {
  if (pawn.isFinished) return false;
  return pawn.position + diceValue <= TOTAL_STEPS;
}

export function getMovablePawnIds(pawns: [Pawn, Pawn], diceValue: number): PawnId[] {
  return pawns.filter((p) => canMovePawn(p, diceValue)).map((p) => p.id);
}

export function movePawn(pawn: Pawn, diceValue: number): Pawn {
  if (!canMovePawn(pawn, diceValue)) return pawn;
  const newPos = pawn.position + diceValue;
  const isFinished = newPos >= TOTAL_STEPS;
  return { ...pawn, position: isFinished ? TOTAL_STEPS : newPos, isFinished };
}

/**
 * Absolute cell index on the shared 52-cell outer ring for a given pawn,
 * used to detect same-cell collisions between blue and green regardless of
 * each color's own path offset. Returns null when the pawn is in its home
 * stretch or finished (both are safe / not on the shared ring).
 */
function absoluteOuterIndex(pawn: Pawn): number | null {
  if (pawn.isFinished) return null;
  if (pawn.position >= OUTER_LEN) return null; // in home stretch
  const offset = pawn.color === 'green' ? 26 : 0;
  return (pawn.position + offset) % OUTER_LEN;
}

function isSafeCell(pawn: Pawn): boolean {
  if (pawn.position >= OUTER_LEN) return true; // home stretch always safe
  return SAFE_OUTER_INDICES.has(pawn.position);
}

/**
 * Checks whether moving `movingPawn` lands it on an opponent pawn.
 * Returns the captured opponent pawn (pre-capture state), or null if no capture.
 */
export function checkCapture(movingPawn: Pawn, allPawns: Pawns): Pawn | null {
  if (movingPawn.isFinished) return null;
  if (movingPawn.position >= OUTER_LEN) return null; // home stretch = safe
  if (isSafeCell(movingPawn)) return null;

  const myAbs = absoluteOuterIndex(movingPawn);
  if (myAbs === null) return null;

  const opponent: PlayerColor = movingPawn.color === 'blue' ? 'green' : 'blue';
  for (const op of allPawns[opponent]) {
    const opAbs = absoluteOuterIndex(op);
    if (opAbs !== null && opAbs === myAbs) return op;
  }
  return null;
}

export function sendPawnToStart(pawn: Pawn): Pawn {
  return { ...pawn, position: 0, isFinished: false };
}

export function checkWinner(pawns: Pawns): PlayerColor | null {
  for (const color of ['blue', 'green'] as PlayerColor[]) {
    if (pawns[color].every((p) => p.isFinished)) return color;
  }
  return null;
}

export function opponentColor(color: PlayerColor): PlayerColor {
  return color === 'blue' ? 'green' : 'blue';
}
