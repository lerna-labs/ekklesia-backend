import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read pools from file
let pools = null;
try {
  const poolsPath = path.join(__dirname, 'pools.json');
  pools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
} catch (error) {
  console.error('Error reading pools from file: ', error);
  process.exit(1);
}

// Test runner
let hasFailures = false;

function runTest(testName, testFunction) {
  console.log(testName);
  const failures = testFunction();
  if (failures.length > 0) {
    hasFailures = true;
    failures.forEach((f) => {
      if (f.koiosValue !== undefined && f.blockfrostValue !== undefined) {
        const label1 = f.label1 || 'Koios';
        const label2 = f.label2 || 'Blockfrost';
        console.error(
          `🔴 FAIL: ${f.ticker} (${f.poolId}) - ${label1}: ${f.koiosValue}, ${label2}: ${f.blockfrostValue}`,
        );
      } else {
        console.error(`🔴 FAIL: ${f.ticker} (${f.poolId})`);
      }
    });
  } else {
    console.log(`🟢 PASS`);
  }
  console.log('--------------------------------');
}

// TEST1: Compare pool_status between /pool_info and /pool_calidus_keys
runTest('TEST1: pool_status comparison between /pool_info and /pool_calidus_keys', () => {
  const mismatches = [];
  for (const pool of pools) {
    const koiosStatus = pool.koios_pool_info?.pool_status;
    const calidusStatus = pool.koios_calidus_key?.pool_status;
    if (koiosStatus !== calidusStatus) {
      mismatches.push({
        ticker: pool.ticker,
        poolId: pool.pool_id_bech32,
        koiosValue: koiosStatus,
        blockfrostValue: calidusStatus,
        label1: '/pool_info',
        label2: '/pool_calidus_keys',
      });
    }
  }
  return mismatches;
});

// TEST2: Compare Koios pool_status to Blockfrost retirement array
runTest(
  "TEST2: Koios pool_status 'registered' should have empty Blockfrost retirement array",
  () => {
    const mismatches = [];
    for (const pool of pools) {
      const koiosStatus = pool.koios_pool_info?.pool_status;
      const blockfrostRetirement = pool.blockfrost_pool_info?.retirement;

      // If Koios says pool_status is "registered", Blockfrost retirement should be empty
      if (koiosStatus === 'registered') {
        if (
          blockfrostRetirement &&
          Array.isArray(blockfrostRetirement) &&
          blockfrostRetirement.length > 0
        ) {
          mismatches.push({
            ticker: pool.ticker,
            poolId: pool.pool_id_bech32,
            koiosValue: koiosStatus,
            blockfrostValue: `retirement: [${blockfrostRetirement.join(', ')}]`,
            label1: 'Koios pool_status',
            label2: 'Blockfrost retirement',
          });
        }
      }
    }
    return mismatches;
  },
);

// TEST3: Compare calidus key ID between Blockfrost and Koios
runTest('TEST3: calidus key ID comparison between Blockfrost and Koios', () => {
  const mismatches = [];
  for (const pool of pools) {
    // Check if both sources have calidus key data
    const koiosCalidusId = pool.koios_calidus_key?.calidus_id_bech32;
    const blockfrostCalidusId = pool.blockfrost_pool_info?.calidus_key?.id;

    // Only compare if both exist
    if (koiosCalidusId && blockfrostCalidusId) {
      if (koiosCalidusId !== blockfrostCalidusId) {
        mismatches.push({
          ticker: pool.ticker,
          poolId: pool.pool_id_bech32,
          koiosValue: koiosCalidusId,
          blockfrostValue: blockfrostCalidusId,
        });
      }
    }
  }
  return mismatches;
});

// TEST4: Compare live_pledge between Koios and Blockfrost
runTest('TEST4: live_pledge comparison between Koios and Blockfrost', () => {
  const mismatches = [];
  for (const pool of pools) {
    const koiosLivePledge = pool.koios_pool_info?.live_pledge;
    const blockfrostLivePledge = pool.blockfrost_pool_info?.live_pledge;

    // Convert both to strings for comparison (handle null as "null" or empty string)
    const koiosValue =
      koiosLivePledge !== null && koiosLivePledge !== undefined ? String(koiosLivePledge) : null;
    const blockfrostValue =
      blockfrostLivePledge !== null && blockfrostLivePledge !== undefined
        ? String(blockfrostLivePledge)
        : null;

    // Only compare if both exist
    if (koiosValue !== null && blockfrostValue !== null) {
      if (koiosValue !== blockfrostValue) {
        mismatches.push({
          ticker: pool.ticker,
          poolId: pool.pool_id_bech32,
          koiosValue: koiosValue,
          blockfrostValue: blockfrostValue,
        });
      }
    }
  }
  return mismatches;
});

// TEST5: Compare pledge between Koios and Blockfrost
runTest('TEST5: pledge comparison between Koios (pledge) and Blockfrost (declared_pledge)', () => {
  const mismatches = [];
  for (const pool of pools) {
    const koiosPledge = pool.koios_pool_info?.pledge;
    const blockfrostPledge = pool.blockfrost_pool_info?.declared_pledge;

    // Convert both to strings for comparison (handle null as "null" or empty string)
    const koiosValue =
      koiosPledge !== null && koiosPledge !== undefined ? String(koiosPledge) : null;
    const blockfrostValue =
      blockfrostPledge !== null && blockfrostPledge !== undefined ? String(blockfrostPledge) : null;

    // Only compare if both exist
    if (koiosValue !== null && blockfrostValue !== null) {
      if (koiosValue !== blockfrostValue) {
        mismatches.push({
          ticker: pool.ticker,
          poolId: pool.pool_id_bech32,
          koiosValue: koiosValue,
          blockfrostValue: blockfrostValue,
        });
      }
    }
  }
  return mismatches;
});

// TEST6: Check if live_pledge is smaller than pledge/declared_pledge
runTest('TEST6: live_pledge should not be smaller than pledge/declared_pledge', () => {
  const mismatches = [];
  for (const pool of pools) {
    // Check Koios: live_pledge vs pledge
    // Use 0 if field is null, undefined, or empty string
    const koiosLivePledge = pool.koios_pool_info?.live_pledge;
    const koiosPledge = pool.koios_pool_info?.pledge;

    const koiosLivePledgeValue =
      koiosLivePledge === null || koiosLivePledge === undefined || koiosLivePledge === ''
        ? '0'
        : String(koiosLivePledge);
    const koiosPledgeValue =
      koiosPledge === null || koiosPledge === undefined || koiosPledge === ''
        ? '0'
        : String(koiosPledge);

    try {
      const livePledgeNum = BigInt(koiosLivePledgeValue);
      const pledgeNum = BigInt(koiosPledgeValue);
      if (livePledgeNum < pledgeNum) {
        mismatches.push({
          ticker: pool.ticker,
          poolId: pool.pool_id_bech32,
          koiosValue: koiosLivePledge ?? 'null',
          blockfrostValue: koiosPledge ?? 'null',
          label1: 'Koios live_pledge',
          label2: 'Koios pledge',
        });
      }
    } catch (error) {
      // Skip if values cannot be converted to BigInt (e.g., invalid format)
      // This silently handles cases where values might be invalid
    }

    // Check Blockfrost: live_pledge vs declared_pledge
    // Use 0 if field is null, undefined, or empty string
    const blockfrostLivePledge = pool.blockfrost_pool_info?.live_pledge;
    const blockfrostDeclaredPledge = pool.blockfrost_pool_info?.declared_pledge;

    const blockfrostLivePledgeValue =
      blockfrostLivePledge === null ||
      blockfrostLivePledge === undefined ||
      blockfrostLivePledge === ''
        ? '0'
        : String(blockfrostLivePledge);
    const blockfrostDeclaredPledgeValue =
      blockfrostDeclaredPledge === null ||
      blockfrostDeclaredPledge === undefined ||
      blockfrostDeclaredPledge === ''
        ? '0'
        : String(blockfrostDeclaredPledge);

    try {
      const livePledgeNum = BigInt(blockfrostLivePledgeValue);
      const declaredPledgeNum = BigInt(blockfrostDeclaredPledgeValue);
      if (livePledgeNum < declaredPledgeNum) {
        mismatches.push({
          ticker: pool.ticker,
          poolId: pool.pool_id_bech32,
          koiosValue: blockfrostLivePledge ?? 'null',
          blockfrostValue: blockfrostDeclaredPledge ?? 'null',
          label1: 'Blockfrost live_pledge',
          label2: 'Blockfrost declared_pledge',
        });
      }
    } catch (error) {
      // Skip if values cannot be converted to BigInt (e.g., invalid format)
      // This silently handles cases where values might be invalid
    }
  }
  return mismatches;
});

// TEST7: Compare live_stake between Koios and Blockfrost
runTest('TEST7: live_stake comparison between Koios and Blockfrost', () => {
  const mismatches = [];
  for (const pool of pools) {
    const koiosLiveStake = pool.koios_pool_info?.live_stake;
    const blockfrostLiveStake = pool.blockfrost_pool_info?.live_stake;

    // Convert both to strings for comparison (handle null as "null" or empty string)
    const koiosValue =
      koiosLiveStake !== null && koiosLiveStake !== undefined ? String(koiosLiveStake) : null;
    const blockfrostValue =
      blockfrostLiveStake !== null && blockfrostLiveStake !== undefined
        ? String(blockfrostLiveStake)
        : null;

    // Only compare if both exist
    if (koiosValue !== null && blockfrostValue !== null) {
      if (koiosValue !== blockfrostValue) {
        mismatches.push({
          ticker: pool.ticker,
          poolId: pool.pool_id_bech32,
          koiosValue: koiosValue,
          blockfrostValue: blockfrostValue,
        });
      }
    }
  }
  return mismatches;
});

// Exit with appropriate code
process.exit(hasFailures ? 1 : 0);
