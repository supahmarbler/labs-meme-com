// Test LMSR math - same functions as app.jsx

const costFn = (qY, qN, B) => {
  const m = Math.max(qY, qN) / B;
  return B * (m + Math.log(Math.exp(qY/B - m) + Math.exp(qN/B - m)));
};

const marketPool = (qY, qN, B) => {
  const current = costFn(qY, qN, B);
  const initial = costFn(B, B, B);
  return Math.max(0, Math.round(current - initial));
};

const yP = (qY, qN, B) => {
  const m = Math.max(qY, qN) / B;
  const eY = Math.exp(qY/B - m), eN = Math.exp(qN/B - m);
  const result = Math.round(eY / (eY + eN) * 100);
  return Math.min(99, Math.max(1, result));
};

const buyShares = (qY, qN, B, cost, side) => {
  if (cost <= 0) return 0;
  const oldCost = costFn(qY, qN, B);
  let lo = 0, hi = cost * 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const newQY = side === "YES" ? qY + mid : qY;
    const newQN = side === "NO" ? qN + mid : qN;
    const newCost = costFn(newQY, newQN, B);
    if (newCost - oldCost < cost) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
};

const sellShares = (qY, qN, B, shares, side) => {
  if (shares <= 0) return 0;
  const oldCost = costFn(qY, qN, B);
  const newQY = side === "YES" ? Math.max(0, qY - shares) : qY;
  const newQN = side === "NO" ? Math.max(0, qN - shares) : qN;
  const newCost = costFn(newQY, newQN, B);
  return Math.max(0, Math.round(oldCost - newCost));
};

// --- SIMULATION ---

console.log("=== LMSR Balance Simulation ===\n");

const B = 30000; // typical B for mid-cap coin
let qY = B, qN = B; // start equal (50/50)
let balance = 10000;
const initialBalance = balance;

console.log(`Initial: bal=${balance}, qY=${qY}, qN=${qN}, B=${B}`);
console.log(`Prob YES: ${yP(qY, qN, B)}%, Pool: ${marketPool(qY, qN, B)}\n`);

// Test 1: Buy YES for 1000
console.log("--- BUY 1000 on YES ---");
const cost1 = 1000;
const shares1 = buyShares(qY, qN, B, cost1, "YES");
const actualCost1 = costFn(qY + shares1, qN, B) - costFn(qY, qN, B);
qY += shares1;
balance -= cost1;
console.log(`Shares received: ${shares1}`);
console.log(`Actual cost (LMSR): ${Math.round(actualCost1)}`);
console.log(`Balance: ${balance}`);
console.log(`Prob YES: ${yP(qY, qN, B)}%, Pool: ${marketPool(qY, qN, B)}`);
const sellValue1 = sellShares(qY, qN, B, shares1, "YES");
console.log(`Sell value of position: ${sellValue1}`);
console.log(`Balance + sell value = ${balance + sellValue1} (started with ${initialBalance})`);
console.log(`Difference: ${balance + sellValue1 - initialBalance}\n`);

// Test 2: Sell immediately
console.log("--- SELL ALL YES SHARES ---");
const refund1 = sellShares(qY, qN, B, shares1, "YES");
qY -= shares1;
balance += refund1;
console.log(`Refund: ${refund1}`);
console.log(`Balance after sell: ${balance}`);
console.log(`Loss from round-trip: ${initialBalance - balance}\n`);

// Reset
balance = 10000;
qY = B; qN = B;

// Test 3: Two players scenario
console.log("=== TWO PLAYER SCENARIO ===\n");
let bal_A = 5000, bal_B = 5000;

console.log("Player A buys 2000 on YES:");
const sharesA = buyShares(qY, qN, B, 2000, "YES");
qY += sharesA;
bal_A -= 2000;
console.log(`A: shares=${sharesA}, bal=${bal_A}`);
console.log(`Prob YES: ${yP(qY, qN, B)}%\n`);

console.log("Player B buys 1500 on NO:");
const sharesB = buyShares(qY, qN, B, 1500, "NO");
qN += sharesB;
bal_B -= 1500;
console.log(`B: shares=${sharesB}, bal=${bal_B}`);
console.log(`Prob YES: ${yP(qY, qN, B)}%\n`);

const sellA = sellShares(qY, qN, B, sharesA, "YES");
const sellB = sellShares(qY, qN, B, sharesB, "NO");
console.log(`A sell value: ${sellA} (invested 2000, PnL: ${sellA - 2000})`);
console.log(`B sell value: ${sellB} (invested 1500, PnL: ${sellB - 1500})`);
console.log(`Pool: ${marketPool(qY, qN, B)}`);
console.log(`Total in: 3500, Total sell values: ${sellA + sellB}`);
console.log(`Market maker profit: ${3500 - sellA - sellB}\n`);

// Test 4: Resolution scenario
console.log("=== RESOLUTION: YES WINS ===");
console.log(`A claimed: ${Math.round(sharesA)} (invested 2000, profit: ${Math.round(sharesA) - 2000})`);
console.log(`B claimed: 0 (invested 1500, loss: -1500)`);
console.log(`A final: ${bal_A + Math.round(sharesA)}, B final: ${bal_B + 0}`);
console.log(`Total: ${bal_A + Math.round(sharesA) + bal_B} (started with ${10000})`);
console.log(`Difference: ${bal_A + Math.round(sharesA) + bal_B - 10000}\n`);

// Test 5: Check buy cost matches balance deduction exactly
console.log("=== PRECISION TEST ===");
qY = B; qN = B;
balance = 10000;
for (const amt of [100, 500, 1000, 2500, 5000]) {
  const before = costFn(qY, qN, B);
  const sh = buyShares(qY, qN, B, amt, "YES");
  const after = costFn(qY + sh, qN, B);
  const actualCost = Math.round(after - before);
  const sv = sellShares(qY + sh, qN, B, sh, "YES");
  console.log(`Buy ${amt}: shares=${sh}, actual_cost=${actualCost}, sell_value=${sv}, spread=${amt - sv}`);
}
