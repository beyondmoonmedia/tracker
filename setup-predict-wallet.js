#!/usr/bin/env node
/**
 * One-time script to add the PREDICT payment wallet to the database.
 * Run with: node setup-predict-wallet.js
 * Requires the tracker to be running on http://localhost:1337 (or set TRACKER_URL).
 */
const WALLET = '0xefe9895559f7b01384a1aaF58164B8bd7636d8FD'.trim();
const PROJECT = 'PREDICT';
const TRACKER_URL = (process.env.TRACKER_URL || 'http://localhost:1337').trim();

async function main() {
  const url = `${TRACKER_URL}/api/setup-project-wallet`;
  const body = {
    walletAddress: WALLET.trim(),
    projectName: PROJECT,
    initialPrice: 0.01,
    initialBonus: 0,
    marketCap: 0,
  };
  console.log('Calling', url, 'with', body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('Error:', res.status, text);
    process.exit(1);
  }
  console.log('Response:', text);
  console.log('Done. Wallet', WALLET, 'is now the PREDICT payment wallet.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
