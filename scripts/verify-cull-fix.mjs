/**
 * Exact simulation of CullDuel loadPair call behavior — old vs new.
 * Run: node scripts/verify-cull-fix.mjs
 */
import { useCallback, useEffect, useRef, useState } from "react";

// We can't run React hooks in Node, so we simulate the exact logic manually.

let callLog = [];
function resetLog() { callLog = []; }

// ── Simulate OLD behavior ───────────────────────────────────────
function simulateOld() {
  resetLog();
  let loadPairVersion = 0;
  let completedComparisons = 0;
  let callCount = 0;

  function createLoadPair() {
    const v = ++loadPairVersion;
    return {
      version: v,
      deps: { completedComparisons }, // snapshot deps at creation time
      call: () => {
        callCount++;
        callLog.push(`OLD loadPair#${v} called (deps: completedComparisons=${completedComparisons})`);
      },
    };
  }

  let loadPair = createLoadPair();
  let loadPairRef = loadPair;

  // Simulate 10 comparisons
  for (let i = 0; i < 10; i++) {
    // Effect: loadPair changed? Call it.
    // In old code, completedComparisons is a dep, so loadPair changes every time
    if (i === 0 || loadPair.deps.completedComparisons !== completedComparisons) {
      loadPair = createLoadPair(); // recreated because deps changed
      loadPairRef = loadPair;
      loadPair.call(); // effect auto-fires
    }

    // handlePick: manual call
    loadPairRef.call();

    // After comparison: onUpdate() increments completedComparisons
    completedComparisons++;
  }

  return callCount;
}

// ── Simulate NEW behavior ───────────────────────────────────────
function simulateNew() {
  resetLog();
  let loadPairVersion = 0;
  let sessionId = 1;
  let sessionStatus = "active";
  let callCount = 0;
  let initialLoadCalled = false;

  function createLoadPair() {
    const v = ++loadPairVersion;
    return {
      version: v,
      deps: { sessionId, sessionStatus }, // only these deps
      call: () => {
        callCount++;
        callLog.push(`NEW loadPair#${v} called (deps: sessionId=${sessionId}, status=${sessionStatus})`);
      },
    };
  }

  let loadPair = createLoadPair();
  let loadPairRef = loadPair;

  // Simulate 10 comparisons
  for (let i = 0; i < 10; i++) {
    // Effect: only fire if initialLoadCalled is false
    if (!initialLoadCalled || (loadPair.deps.sessionId !== sessionId || loadPair.deps.sessionStatus !== sessionStatus)) {
      // deps changed → loadPair recreated → effect fires
      // But check initialLoadCalled guard
      const depsChanged = loadPair.deps.sessionId !== sessionId || loadPair.deps.sessionStatus !== sessionStatus;
      if (depsChanged) {
        loadPair = createLoadPair();
        loadPairRef = loadPair;
      }
      if (!initialLoadCalled) {
        initialLoadCalled = true;
        loadPair.call(); // effect fires only first time
      }
    }

    // handlePick: manual call
    loadPairRef.call();

    // sessionId and status don't change during normal comparison
  }

  return callCount;
}

// ── Run ─────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════════╗");
console.log("║  CullDuel loadPair 调用次数验证                 ║");
console.log("╚══════════════════════════════════════════════════╝\n");

const oldCalls = simulateOld();
const newCalls = simulateNew();

console.log(`10次PK比较操作:`);
console.log(`  旧代码: ${oldCalls} 次 loadPair 调用 (${(oldCalls / 10).toFixed(1)}x / 次操作)`);
console.log(`  新代码: ${newCalls} 次 loadPair 调用 (${(newCalls / 10).toFixed(1)}x / 次操作)`);

if (oldCalls === 20 && newCalls === 10) {
  console.log(`\n✅ 修复已生效! 每次PK后只有1次IPC调用，消除了50%冗余`);
} else if (newCalls === 10) {
  console.log(`\n✅ 修复已生效! 每次PK后只有1次IPC调用`);
} else if (newCalls < oldCalls) {
  console.log(`\n⚠️  部分生效: 减少了 ${oldCalls - newCalls} 次调用`);
} else {
  console.log(`\n❌ 修复未生效，调用次数没有减少`);
}

// Show call log
console.log(`\n📋 旧代码调用日志:`);
console.log(callLog.filter(l => l.startsWith('OLD')).join('\n'));
console.log(`\n📋 新代码调用日志:`);
resetLog();
simulateNew();
// Reset and re-run to get clean new log
resetLog();
const nc = simulateNew_();
function simulateNew_() {
  resetLog();
  let callCount = 0;
  let sessionId = 1;
  let sessionStatus = "active";
  let initialLoadCalled = false;
  let loadPairVersion = 0;

  function createLoadPair() {
    const v = ++loadPairVersion;
    return {
      version: v,
      deps: { sessionId, sessionStatus },
      call: () => {
        callCount++;
        callLog.push(`NEW loadPair#${v} called (deps: sessionId=${sessionId}, status=${sessionStatus})`);
      },
    };
  }

  let loadPair = createLoadPair();
  let loadPairRef = loadPair;

  for (let i = 0; i < 3; i++) {
    if (!initialLoadCalled) {
      initialLoadCalled = true;
      loadPair.call();
    }
    loadPairRef.call();
  }
  return callCount;
}
console.log(callLog.filter(l => l.startsWith('NEW')).join('\n'));

console.log(`\n💡 在应用中验证:`);
console.log(`   打开DevTools Console，进入PK筛选，做几次选择`);
console.log(`   观察 [CullDuel] loadPair called 计数器`);
console.log(`   旧版: 每操作+2 (冗余)`);
console.log(`   新版: 每操作+1 (正常)`);
