import {
  checkVoterValidation,
  saveVoterValidation,
  checkVotingPower,
  saveVotingPower,
} from "../helper/voterValidation.js";
// const API_URL = process.env.API_URL; // not needed for this one

const VOTERS = [
  {
    drep_id: "drep1ygpuetneftlmufa97hm5mf3xvqpdkyw656hyg6h20qaewtg3csnkc",
    registered: true,
    active: true,
    amount: "37621811427",
  },
  {
    drep_id: "drep1ygzqwwtgcewhzvxu942xufzl4pg7gnttw9h4e0agm30fnwsqcv00v",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1ygzgs3qcrxct09tx0av04lfm85d6mdxlds2haccs4maavvskytcpk",
    registered: true,
    active: true,
    amount: "3098070",
  },
  {
    drep_id: "drep1ygytfjy863rx34wqlhjs3kpk8sxzehl2dullf7h0kpdajdgrga7lc",
    registered: true,
    active: false,
    amount: "5121523137",
  },
  {
    drep_id: "drep1ygxsm0d0uhcpppsc02s4vjmfare09vt4ggayc3ec7550cmgkjghed",
    registered: true,
    active: false,
    amount: "6974778923",
  },
  {
    drep_id: "drep1yg8yhhtf3dxv9uh9rz6tr7j3jrgtc4n2cshe8snfsmk257gl87pyg",
    registered: true,
    active: true,
    amount: "10740338189",
  },
  {
    drep_id: "drep1yv8emzd9yc5g3sqlwkv2rucmr56xfadsujke6x6knz58kks38c0gq",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1ygg7ul4yxxvdwfj7der264k2lag4h96d62h5luwz2c4y7sctvw67v",
    registered: true,
    active: false,
    amount: "10185139800",
  },
  {
    drep_id: "drep1yg2l5w3hfzy3ww7anmhap7y2dcdjhlfu2s3hr4zpsyks9sqv2s5sf",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1ygv58mrmlrye9vu0tussycey3vm2rva2c5djx0e66r3wzuqq5w275",
    registered: true,
    active: false,
    amount: "4288399486438",
  },
  {
    drep_id: "drep1yvdqkkms3pj32u4w50w6gevjpaec9a4j28erzgcacdmzsqcagvlf2",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1ygwr9f9uze80w492tagl3s76njc2zpr52f4jkyy4rsrtdhc3jdgjf",
    registered: true,
    active: false,
    amount: "10214176454",
  },
  {
    drep_id: "drep1yg0uxpuek2g5xtc64hnn5n5kpckjy5glrfuh6lz8545ahgg5yd4tg",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1yg3mcc7w6njqkgkafes9rsjchgud2euas83n7d87tewdkngpgk07n",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1yvj9cn7cwc3wyrt3lclk2ua92lxd8uxqzju0qza8ky380uqjpzm8s",
    registered: true,
    active: false,
    amount: "9513941434",
  },
  {
    drep_id: "drep1ygnl9fjlz3pahx5vd2m6y4ya0562n8ttqzss9ncacu6l6pqwm2php",
    registered: true,
    active: false,
    amount: "8105089107119",
  },
  {
    drep_id: "drep1yvk5ed5qkh6qp56jr5njks546cg4pc807w2saapg2sr2j5c940gff",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1ygc02uul808jejn9lc8k0acs7eflvqd6tt0qdn0jv697fdc5e5qp5",
    registered: true,
    active: false,
    amount: "6854895162",
  },
  {
    drep_id: "drep1yge5qzj9ggvk77rz0vcmq2rpzcgq563e6fmydjngelxtnmgz2g54e",
    registered: true,
    active: false,
    amount: "126773903979",
  },
  {
    drep_id: "drep1yvmeer7fcwng5ea3v7cw2g2uq352sm58xtmaphp5vqvcxycrzszhz",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1yg72tju5h0wjky7w3etzc5esjss2zlajnq4v6jw3v0h73agp97k0g",
    registered: true,
    active: false,
    amount: "9497813687",
  },
  {
    drep_id: "drep1yfrud5mk40ttv4z5l4ltvcgfstmjzwyv73hczmmpue4dv0gus8kge",
    registered: true,
    active: false,
    amount: "485024006",
  },
  {
    drep_id: "drep1yfy9wajz7mrc6x5a4s23x5vttztqea6ajx9v83xcr6c5xlqxjx05p",
    registered: true,
    active: false,
    amount: "3921975425",
  },
  {
    drep_id: "drep1yfxnlm9dpw6v9xlwkxmzrfw3awdtlrmyuw3ruzpzv2u4cqqa74ck9",
    registered: true,
    active: true,
    amount: "18469567057",
  },
  {
    drep_id: "drep1yfxavrjwluy2yzdgfun94sjxkvxgygn5j6tvke9u6enyw6s3323mw",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1yffg8vgrnwh5azd74t94j5pquwqad98r3dzpt0hw3da0res4yp97l",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1yftr2094dxeszxy944y9n5ms5eg3md28adlvk0vqwcn4pgc7kq6wr",
    registered: true,
    active: false,
    amount: "2499597848",
  },
  {
    drep_id: "drep1yfvt035glmmvejkudm9z44xhgzpv8scppmgpujgnn7tzygsk0aypg",
    registered: true,
    active: false,
    amount: "11621378039",
  },
  {
    drep_id: "drep1yfdlaustgvf3ch9gwzzxk4s77neettw3yqv7n3ay0a6k63qw9dmhd",
    registered: true,
    active: false,
    amount: "23685225311970",
  },
  {
    drep_id: "drep1yfs2e9c42nq5fv2ac9ygxrhxllgaz9ms2g0xynaj7dpd58qwg2030",
    registered: true,
    active: false,
    amount: "14900059995",
  },
  {
    drep_id: "drep1yf36e6gz9qp6sa3nfktwwy06n7x5wyzzckakdw5l4md027sfqrr27",
    registered: true,
    active: false,
    amount: "10707079094",
  },
  {
    drep_id: "drep1yf58yyq70kh5pwnmll80pcgyjzml45az4n2c7pfffd7gxng24wp2s",
    registered: true,
    active: false,
    amount: "12467603158",
  },
  {
    drep_id: "drep1yf526lwk7u9psnjqe6ad6t9cujy68vecmk8tkuzv5vczdxgxkmlrk",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1yf49tsm8w6f2tepdmwg7kkjjfj32x60xnmyuknfskq3mskgfvuvhp",
    registered: true,
    active: true,
    amount: "124500301180",
  },
  {
    drep_id: "drep1yfcc3krxw9tssn9rwqn5rtqfuq4cwckx7a69vct54jmy5cqkneh34",
    registered: true,
    active: false,
    amount: "187760363319",
  },
  {
    drep_id: "drep1yf6rudz7w9kz4etshj0njg7fjtd0c4frgsds6f8e6ep47ygl6sw74",
    registered: true,
    active: false,
    amount: "9692770299",
  },
  {
    drep_id: "drep1ydmraa6kv8cvmry059v608tehl50nfmg0z764lmsqkvwurs40sw2z",
    registered: true,
    active: false,
    amount: "5344952790684",
  },
  {
    drep_id: "drep1yfm474fdqxgnnynxdyg99ll2ad3x0cjuuyqeyxdumarl6xcfe4tyr",
    registered: true,
    active: false,
    amount: "310992972644",
  },
  {
    drep_id: "drep1yfuems4sqpzfmg0ux90mq2nv8k9zl2fyz5z35dfh90r6z8c7ddcme",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1yf778zjm3mtd4rxcpc0gez0x8kc80chxpyphesd4sdetwtswl0wwt",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1y2qn0rf74zdk3u8upx2yk8un7tlts5f33uvklx96gq5a32qmwj3xg",
    registered: true,
    active: true,
    amount: "2145253081796",
  },
  {
    drep_id: "drep1y29h2q6cst2pvkl2sqqvf5ljcy36uv7pmy482xnczddzgqshus24w",
    registered: true,
    active: false,
    amount: "1276671443159",
  },
  {
    drep_id: "drep1ywxwg66ujf7wgycagwe3qpqruu83f97yt0e9dxprz8wpqzscc5q5t",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1y2xuj82kwvjrnrgzsesh2yezg30neehkzwd9ed9kd20f2asze2l6z",
    registered: true,
    active: false,
    amount: "216647819082",
  },
  {
    drep_id: "drep1y28wyfxwyywajenkfcy0s9r3fqkvufm4stpxy80j4234qzsl80wwe",
    registered: true,
    active: false,
    amount: "8452496675",
  },
  {
    drep_id: "drep1y2g0k5ygsf9pcm7klft5vw5684e9e2u93uzzml6vauj2j4qmhr6m5",
    registered: true,
    active: false,
    amount: "140085898294",
  },
  {
    drep_id: "drep1y2fgxycu78q496nj2mzkf2qqedfhv8evw46jd6nus659z0g3n4n6r",
    registered: true,
    active: false,
    amount: "25264354273",
  },
  {
    drep_id: "drep1y2tc5kv5nspwutasa44c5qrlznt7h7vulxqhvr3005czsnsghulqt",
    registered: true,
    active: true,
    amount: "2616983944",
  },
  {
    drep_id: "drep1y2dy2zzfy4jqzfq6tkensdrcmt50d4sv63q62wqek0dgaus24jr6j",
    registered: true,
    active: true,
    amount: "61761106627",
  },
  {
    drep_id: "drep1y20pfp4s4h4l7karnc2v04y0nc7ru5ar65n9xptp3sjdz4gmjfpre",
    registered: true,
    active: true,
    amount: "39658713449",
  },
  {
    drep_id: "drep1y20snwn9zyycd9muqr0umlk3pmrlllrx50lrxjfe2ja3qkqtymdys",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1y23k2z86wejlcssndz5xtt35hm3h8q4tnp8yqkm47ecx2ss4a3rcg",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1y2j502uqsjl7ujrg5e73mxc2up2wu963r6eg44zdglzanncytjpxy",
    registered: true,
    active: false,
    amount: "10346213516",
  },
  {
    drep_id: "drep1yw50yenfxldukk9u5cxv3pjpdnlecpt0mz5dyz8n8h3p8qcw8d2hm",
    registered: true,
    active: true,
    amount: "2954237157",
  },
  {
    drep_id: "drep1y25j98kvqf7t3tj4pvxwrjr2728dsrfekptgg3kxqrr56qqcny8sn",
    registered: true,
    active: false,
    amount: "110004760575",
  },
  {
    drep_id: "drep1y24dr4fp3c2xyamt2rmpzsvj4x8uwqeuteuk6tljhzm4mrgtd720a",
    registered: true,
    active: true,
    amount: "9497482597",
  },
  {
    drep_id: "drep1yw4543wxryyfhayplasch6gjmhht73ufn7d2l47jghf43rcxtwee6",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1y2cpz8kmr83z0vumpq5r8zxqpcjnhaqg8h4tt5u4wlhntssndylla",
    registered: true,
    active: false,
    amount: "187438378090",
  },
  {
    drep_id: "drep1y2chj5wktflvn8gq35au3z93npsg3vnvg3ujvvdahv5u30g4azqte",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1y2e20afmrjh8wz02w92880qwdqephacyqlahqyp5n6rgnhg2egjc8",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1y26fjl28ps423ccyxfvvcvjzsjedcaa8mvuqzxrxxc9nwjglc0uju",
    registered: true,
    active: true,
    amount: "152989832747",
  },
  {
    drep_id: "drep1y2urtnpqef68w3dm2xrggdsfpp98h00xmkf4qj78r70r3xq8lekef",
    registered: true,
    active: true,
    amount: "984369430386",
  },
  {
    drep_id: "drep1y2uccen8sqvdgp0z9d2c0rf57mh2vq85yesmjnqcqvv0szcq9nxvv",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1y2aas36r3epqrz0gehkkkjm9yerwngm53lfsp83szymdtdq2whufp",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1y2lff3fpxdkhema82seuw96w0pdnxzmpgp4j6mk6pa333ms0sc6qn",
    registered: true,
    active: true,
    amount: "27378081157",
  },
  {
    drep_id: "drep1ytqdcp8h75nlr6lvqamp5nztn7ce2m7yjt9hdqmn7565uhgmmudx6",
    registered: true,
    active: true,
    amount: "70875671395",
  },
  {
    drep_id: "drep1ytp6z22jf7gckpsla6k0dwkv88zhgwvqzhdmvgyggjdvvdg885jvw",
    registered: true,
    active: true,
    amount: "104586074394",
  },
  {
    drep_id: "drep1ytrs50sd7xvzklj988f8ar34drz4223ahdl7p60rqzhccusgnk04w",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1yt9s73nt6388jgalpp3dz60qnwchhw5xcatfqmw7pg6ay9c2ztrt5",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1y09hnm54lxqfhjp7arnzef68ucwsd7t3nq4yvvej94t8f8qg0tqdt",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1ytxptk94rze67kzxcmfe3wmvudatj409f756zhhd986l9ec03e37k",
    registered: true,
    active: true,
    amount: "4497813423",
  },
  {
    drep_id: "drep1ytxlknra9m637sdg078mgpmqu0xut3wmeadjp9dc7x4pv6qwhvj2c",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1y0gy6wwyuj6za8kamwm5rwmxxe5rk6pz4ckx3hmsfdjuujsr70shz",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1ytg3f3uc0xda26q0q5fkg47dhlmdspm4hl3md8k6gcjk7zccfvsqc",
    registered: true,
    active: false,
    amount: "9914098417",
  },
  {
    drep_id: "drep1ytgmll84qz9qt7gs8smfqn66drfk9t4d0dpen3dpeepqu5q2gp8d4",
    registered: true,
    active: false,
    amount: "11463533415",
  },
  {
    drep_id: "drep1ytvk344upvkmxpnucggm4usffgvgf4ytrrudpnu5d2685cc3xkedh",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1ytvawtjqsp9zlkcazx07644dhusaxtrct0z53mzpq4fdgzqqd9g7f",
    registered: true,
    active: false,
    amount: "27468986389",
  },
  {
    drep_id: "drep1y0wymd8w6f073j94hpnv9uekwy2y7f4cytnez4q0uze4wkczp53sn",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1ytw4sejk7q74kwc3t8wx6e7rn9lx8tcdvlss47hh48ck34cm8p9hw",
    registered: true,
    active: false,
    amount: "2986710059",
  },
  {
    drep_id: "drep1ytsy6uatehlmxymymrwuycph0s6ewwn0jxsnyfq6vs47h4sflw0dg",
    registered: true,
    active: false,
    amount: "9142338514",
  },
  {
    drep_id: "drep1yt5trmh3zk8gunqn6qs2w5h8acpsssax4z07meem529zgkcrz3fmy",
    registered: true,
    active: true,
    amount: "151416711064",
  },
  {
    drep_id: "drep1yt5vg6rkd5666m9cvns5llfahfw4q94j00ren47t6njtlxq29m2t6",
    registered: true,
    active: true,
    amount: "19019642458",
  },
  {
    drep_id: "drep1yt5498apq2xmuvugmf0jdd5kp5zd3ccpezn6m2mzsvuh3pqn8x06l",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1ytkyws3l7mu3zj3kll704k3w5x2kq280nleg0j3s7j5xp3cdh6r7m",
    registered: true,
    active: false,
    amount: "0",
  },
  {
    drep_id: "drep1ytk3r5ddfk2cq66ygdtkwf9yck6hhy7uzhk2tgl5d53448skyutw7",
    registered: true,
    active: false,
    amount: "1096520169",
  },
  {
    drep_id: "drep1ytcw6qzpqqclx2yd0zy64ztvlkkhnf6yrzza8whgnq4vz5gh89626",
    registered: true,
    active: false,
    amount: "927496686421",
  },
  {
    drep_id: "drep1ytett72fzlmudmq55sn95lm5qcks3ekmwpzq5czfswtustqkxs77v",
    registered: true,
    active: false,
    amount: "9497460993",
  },
  {
    drep_id: "drep1ytesfw7n2pq5ys2rk0m7fxxd2dyagf820wy24d82rdd9yxqfm4qjg",
    registered: true,
    active: true,
    amount: "19860749152",
  },
  {
    drep_id: "drep1ytenukatzrvc2a8kyalzj67us4ms568f6jy8p8qu3luw07gjdmlar",
    registered: true,
    active: false,
    amount: "133693375141",
  },
  {
    drep_id: "drep1yt7sxjtqkp4vvkv8xt3rcj2puhn8t9q0ksdplahqfypy4sgx8syuc",
    registered: true,
    active: true,
    amount: "40066379523",
  },
  {
    drep_id: "drep1ytlf69wakmx78jja8rp6gusx2yprnqvp4zmw3lfwqqednhqnkkjag",
    registered: true,
    active: true,
    amount: "0",
  },
  {
    drep_id: "drep1ytl6uvunzvpy6fc6vv99dqw8qfw5g6htzneevwasd28rrascgdztg",
    registered: true,
    active: false,
    amount: "164369074977",
  },
  {
    drep_id: "drep1ytqc6htdna9x2kklyk35jk6dxwaecqzscrgvtls2mpqje6cuqcl9k",
    registered: true,
    active: false,
    amount: "164369074977",
  },
  {
    drep_id: "drep1ytqc6htdna9x2kklyk35jk6dxwaecqzscrgvtls2mpqje6cuqcl9k",
    registered: true,
    active: false,
    amount: "164369074977",
  },
  {
    drep_id: "drep1ytpk4mka2ccqqtappe5r025cyys4l8rmq7eufkzg4208hhgdyyz3u",
    registered: true,
    active: false,
    amount: "164369074977",
  },
];

/**
 * Validate if the given address is a registered drep.
 * @param {string} address - The address to validate.
 * @throws {Error} If the address is not registered.
 * @throws {Error} If the API request fails.
 * @returns {boolean} True if the address is registered, false otherwise.
 */
export async function validateVoter(voterId, ballotId) {
  let validated = false;

  // Check if the address is already validated
  const existingValidation = await checkVoterValidation(voterId, ballotId);
  if (existingValidation !== null) {
    return existingValidation;
  }

  // check if drep is in VOTER snapshot
  const voter = VOTERS.find((v) => v.drep_id === voterId);
  if (voter) {
    validated = true;
  } else {
    validated = false;
  }

  // Save the validation to the database
  await saveVoterValidation(voterId, ballotId, validated);

  // return the validation status
  return validated;
}

/**
 * Get the allowed voter count and cache the result.
 * @returns {Promise<Number>} - The total count of registered DReps
 */
export async function allowedVoterCount() {
  return VOTERS.length;
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of registered DReps
 */
export async function getTotalWeight() {
  return VOTERS.reduce((acc, voter) => {
    return acc + parseInt(voter.amount);
  }, 0);
}

/**
 * Get the total weight of all registered DReps.
 * @returns {Promise<Number>} - The total weight of a specific DRep
 */
export async function getWeight(voterId, ballotId) {
  const cachedVotingPower = await checkVotingPower(voterId, ballotId);
  if (cachedVotingPower) {
    return cachedVotingPower;
  }

  let votingPower = 0;
  votingPower = VOTERS.find((v) => v.drep_id === voterId)?.amount;

  // Save the voting power to the database
  await saveVotingPower(voterId, ballotId, votingPower);

  return votingPower;
}
