import fs from 'fs';
const BF_TOKEN = 'preprodGIlmca5o4h5ZqcWRJW71M4tBgDi0ItNa';

// POOLS
const pools = [
  {
    pool_id_bech32: 'pool123e5n6lmmy6hkqgtkrz4ev4wezll9d7x3kff6kklc7xyyj39yts',
    ticker: 'ABLE',
    koios_pool_info: null,
  },
  {
    pool_id_bech32: 'pool1m8glad404zhwsa6k2lalm6qu95ptfffj9uk5drphmu0rsj3mnaz',
    ticker: 'TEST',
    koios_pool_info: null,
  },
  {
    pool_id_bech32: 'pool1jk4gd9cty2n89d6y6m8j3g63mr05drdjvqpgxqzhdzkjq4msndn',
    ticker: 'CALID',
    koios_pool_info: null,
  },
  {
    pool_id_bech32: 'pool1wdxhnkflk78u0h8kymhaga7l22rtk2xdlqrlajt4quagxh63er7',
    ticker: 'CALI2',
    koios_pool_info: null,
  },
];

// KOIOS: GET POOL INFO
try {
  const requestPoolInfo = await fetch(`https://preprod.koios.rest/api/v1/pool_info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      _pool_bech32_ids: pools.map((pool) => pool.pool_id_bech32),
    }),
  });
  const poolInfo = await requestPoolInfo.json();

  pools.forEach((pool) => {
    pool.koios_pool_info = poolInfo.find((p) => p.pool_id_bech32 === pool.pool_id_bech32);
  });
  console.log('Pool info fetched from Koios');
} catch (error) {
  console.error('Error fetching pool info from Koios: ', error);
}
// KOIOS: FETCH CALIDUS KEYS
try {
  for (const pool of pools) {
    const requestCalidusKeys = await fetch(
      `https://preprod.koios.rest/api/v1/pool_calidus_keys?pool_id_bech32=eq.${pool.pool_id_bech32}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    const calidusKey = await requestCalidusKeys.json();
    pool.koios_calidus_key = calidusKey[0];
  }
  console.log('Calidus keys fetched from Koios');
} catch (error) {
  console.error('Error fetching calidus keys from Koios: ', error);
}

// BLOCKFROST: GET POOL INFO
try {
  for (const pool of pools) {
    const requestPoolInfo = await fetch(
      `https://cardano-preprod.blockfrost.io/api/v0/pools/${pool.pool_id_bech32}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          project_id: BF_TOKEN,
        },
      },
    );
    const poolInfo = await requestPoolInfo.json();
    pool.blockfrost_pool_info = poolInfo;
  }
  console.log('Pool info fetched from Blockfrost');
} catch (error) {
  console.error('Error fetching pool info from Blockfrost: ', error);
}

// write pools to file
fs.writeFileSync('pools.json', JSON.stringify(pools, null, 2));
