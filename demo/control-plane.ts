// Plays IMD's control plane with the oracle key: for each seat on a job, creates an agent's session
// account, funds it with NEAR for gas and storage, and assigns it to the seat
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
// 0.2 NEAR
const SESSION_FUNDING = 200_000_000_000_000_000_000_000n;
const ONE_YOCTO = 1n;
const CALL_GAS = 30_000_000_000_000n;
const USAGE = "Usage: npm run control-plane -- <job_id> <seat_id>... [--hours <hours>]";

// Key file of a seat's session, which the agent passes to the CLI with --session
function sessionFile(seatId: string): URL {
  return new URL(`../.env.session.${seatId}`, import.meta.url);
}

// Creates, funds and assigns one session account, and returns its id
async function assignSeat(
  oracle: Account,
  contractId: string,
  jobId: string,
  seatId: string,
  expiresAt: number,
): Promise<string> {
  // A session account is an implicit account: its id is the hex of its ed25519 public key
  const sessionKey = KeyPair.fromRandom("ed25519");
  const sessionAccountId = Buffer.from(sessionKey.getPublicKey().data).toString("hex");
  // Saves the key before funding, so a funded account always has its key on disk
  writeFileSync(sessionFile(seatId), `STIPEND_SESSION_KEY=${sessionKey.toString()}\n`, { mode: 0o600 });

  const funding = await oracle.transfer({ receiverId: sessionAccountId, amount: SESSION_FUNDING });
  console.log(`Seat ${seatId}: session account ${sessionAccountId} funded with 0.2 NEAR`);
  console.log(`  Transaction: ${EXPLORER_TX_URL}/${funding.transaction.hash}`);

  const assignment = await oracle.callFunctionRaw({
    contractId,
    methodName: "assign",
    args: {
      job_id: jobId,
      seat_id: seatId,
      session_account: sessionAccountId,
      expires_at: String(expiresAt),
    },
    deposit: ONE_YOCTO,
    gas: CALL_GAS,
    waitUntil: "FINAL",
  });
  console.log(`  Assigned to job ${jobId}: ${EXPLORER_TX_URL}/${assignment.transaction.hash}`);
  console.log(`  Key saved to .env.session.${seatId}`);
  return sessionAccountId;
}

// Usage: npm run control-plane -- <job_id> <seat_id>... [--hours <hours>]
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { hours: { type: "string", default: "6" } },
  });
  const [jobId, ...seatIds] = positionals;
  const hours = Number(values.hours);
  if (!jobId || seatIds.length === 0 || !(hours > 0)) {
    throw new Error(USAGE);
  }
  if (new Set(seatIds).size !== seatIds.length || seatIds.some((seatId) => !/^[\w-]+$/.test(seatId))) {
    throw new Error("Seat ids must be distinct letters, digits, _ or -");
  }
  const { NEAR_RPC_URL, STIPEND_CONTRACT_ID, ORACLE_ID, ORACLE_KEY } = process.env;
  if (!NEAR_RPC_URL || !STIPEND_CONTRACT_ID || !ORACLE_ID || !ORACLE_KEY) {
    throw new Error("Set NEAR_RPC_URL, STIPEND_CONTRACT_ID, ORACLE_ID and ORACLE_KEY in .env");
  }
  const existingFiles = seatIds.filter((seatId) => existsSync(sessionFile(seatId)));
  if (existingFiles.length > 0) {
    throw new Error(`Session files exist for seats ${existingFiles.join(", ")}. Remove them to create new sessions.`);
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const oracle = new Account(ORACLE_ID, provider, ORACLE_KEY as KeyPairString);

  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  // One seat at a time, so the oracle's transactions use its access key nonces in order
  for (const seatId of seatIds) {
    const sessionAccountId = await assignSeat(oracle, STIPEND_CONTRACT_ID, jobId, seatId, expiresAt);
    const session = await provider.callFunction({
      contractId: STIPEND_CONTRACT_ID,
      method: "get_session",
      args: { session_account: sessionAccountId },
    });
    console.log(`  Session: ${JSON.stringify(session)}`);
  }
}

await main();
