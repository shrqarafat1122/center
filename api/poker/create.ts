import { db } from "../lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export default async function handler(req: any, res: any) {
  try {
    const tables = [
      {
        id: "table_001",
        name: "Beginner Table",
        minBuyIn: 100,
        maxBuyIn: 1000,
        smallBlind: 5,
        bigBlind: 10,
      },
      {
        id: "table_002",
        name: "Intermediate Table",
        minBuyIn: 500,
        maxBuyIn: 5000,
        smallBlind: 25,
        bigBlind: 50,
      },
      {
        id: "table_003",
        name: "High Roller",
        minBuyIn: 5000,
        maxBuyIn: 50000,
        smallBlind: 100,
        bigBlind: 200,
      },
    ];

    for (const t of tables) {
      await db.collection("pokerTables").doc(t.id).set({
        id: t.id,
        name: t.name,

        status: "waiting",
        phase: "waiting",

        minBuyIn: t.minBuyIn,
        maxBuyIn: t.maxBuyIn,

        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,

        maxPlayers: 6,

        players: [],
        spectatorQueue: [],
        communityCards: [],
        deck: [],

        pot: 0,
        sidePots: [],
        currentBet: 0,

        dealerSeat: -1,
        activePlayerUid: null,

        turnExpiresAt: null,
        afkWarningUid: null,
        afkWarningEndsAt: null,

        handNumber: 0,

        createdBy: "system",

        lastBrokePlayers: [],
        lastHandWins: {},
        lastHandAllIn: false,
        lastWinner: null,

        nextHandAt: null,

        reservedSeats: {},

        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        lastActionAt: FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Poker tables created",
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
