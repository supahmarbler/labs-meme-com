/**
 * One-time script: Parse dump.sql and insert wallet rows into labs_user_wallets
 * via Supabase Management API.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_... node import-wallets.js
 *
 * Inserts into both dev and prod by default.
 */

import { readFileSync } from "fs";

const DUMP_PATH = "/Users/johanunger/Downloads/dump.sql";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("FATAL: SUPABASE_ACCESS_TOKEN required");
  process.exit(1);
}

const PROJECTS = {
  dev: "vnteehkwrygodkljfwyp",
  prod: "csvegolcvwuwssoefxdh",
};

const BATCH_SIZE = 500;

function parseDump() {
  console.log("Parsing dump.sql...");
  const content = readFileSync(DUMP_PATH, "utf-8");

  // Find the COPY public.wallet section
  const startMarker = "COPY public.wallet (id, wallet_address, wallet_type, meme_user_id, created_at, synced_to_v1) FROM stdin;";
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    console.error("FATAL: Could not find COPY public.wallet section");
    process.exit(1);
  }

  const dataStart = startIdx + startMarker.length + 1; // skip newline
  const endIdx = content.indexOf("\n\\.\n", dataStart);
  const dataSection = content.substring(dataStart, endIdx);

  const rows = [];
  const seen = new Set(); // dedupe by (user_id, wallet_address)

  for (const line of dataSection.split("\n")) {
    if (!line || line === "\\.") continue;
    const parts = line.split("\t");
    // columns: id, wallet_address, wallet_type, meme_user_id, created_at, synced_to_v1
    if (parts.length < 4) continue;

    const walletAddress = parts[1];
    const walletType = parts[2]; // EVM or SOLANA
    const memeUserId = parts[3];
    const userId = `meme-${memeUserId}`;
    const chain = walletType === "SOLANA" ? "SOLANA" : "EVM";

    const key = `${userId}|${walletAddress}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({ user_id: userId, wallet_address: walletAddress, chain });
  }

  console.log(`Parsed ${rows.length} unique wallet rows`);
  return rows;
}

async function runQuery(projectId, query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectId}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

function escapeSQL(str) {
  return str.replace(/'/g, "''");
}

async function insertBatch(projectId, envName, rows) {
  // Clear existing data first
  console.log(`[${envName}] Clearing existing data...`);
  await runQuery(projectId, "DELETE FROM labs_user_wallets;");

  console.log(`[${envName}] Inserting ${rows.length} rows in batches of ${BATCH_SIZE}...`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch
      .map(
        (r) =>
          `('${escapeSQL(r.user_id)}', '${escapeSQL(r.wallet_address)}', '${r.chain}')`
      )
      .join(",\n");

    const query = `INSERT INTO labs_user_wallets (user_id, wallet_address, chain) VALUES ${values} ON CONFLICT (user_id, wallet_address) DO NOTHING;`;

    await runQuery(projectId, query);
    inserted += batch.length;
    process.stdout.write(`\r[${envName}] ${inserted}/${rows.length}`);
  }

  console.log(`\n[${envName}] Done. Verifying...`);
  const result = await runQuery(projectId, "SELECT count(*) as cnt FROM labs_user_wallets;");
  console.log(`[${envName}] Rows in table: ${result[0]?.cnt}`);
}

async function main() {
  const rows = parseDump();

  for (const [envName, projectId] of Object.entries(PROJECTS)) {
    await insertBatch(projectId, envName, rows);
  }

  console.log("Import complete.");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
