import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
const __repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(__repoRoot, ".env.development") });
// Overlay .env.local if present so developers can override API_URL/API_TOKEN
// without editing the container-written .env.development.
dotenv.config({ path: path.join(__repoRoot, ".env.local"), override: true });

import {verifySignature} from "../verifySignature";

const generic_payload = '616263313233'; // abc123 in hex
const mainnet_stake_address = 'stake1uyvx67glm2hdjcfp9pg0d59x0595n372k8sh437vk3hda0gmuz8dq';
const testnet_stake_address = 'stake_test1uqvx67glm2hdjcfp9pg0d59x0595n372k8sh437vk3hda0gukg9fa';
const mainnet_cip129_drep_id = 'drep1ytdnkw2l4q7uy2d7d7sj9fhgsun56zg2uleqlfqx2lvcc6gusnw9c';
const mainnet_cip105_drep_id = 'drep1mvanjhag8hpzn0n05y32d6y8yaxsjzh87g86gpjhmxxxj4qq0e5';
const mainnet_pool_id = 'pool1v4a76mt3fqhg64qja6r2rk8d65g0h7a3qjd9ykay3wqvy2h9cff';

const basic_signing_stake_key = {
    "signature": "3e1c1169a2f7141756f4f4331523fbdbf9884d4e8621ee8a703c70f5d621cd386588bdce9246a0e68d460fb09c83f03a57f077a8336a1dbbf201f98e7e66d204",
    "publicKey": "4aaff6858aecf6aa6a4ce241b3a8c16ccc1c18684604beeb39ba92ced2f1f5b0"
};

const browser_payload = '5369676e20696e212031374a79754f63726772345239724f684b5977436c7637497737336e72596671';

const browser_basic_signing_stake_key = {
    signature: '84582aa201276761646472657373581de01d81d875c5e0b39a76a4335ad549152dca66c0feab5165d4fd38e839a166686173686564f458295369676e20696e212031374a79754f63726772345239724f684b5977436c7637497737336e72596671584063fae2ecc3dc5b0fd5bab0a91c03ec17933255463e6b76459d481704468173d7f19535f4da3d875e989bc78c0f401757f532c8d4ce41938ddb5b3fe4f32dee05',
    key: 'a40101032720062158208e86cd7dadb2b5ae4222b0c63ffc1216970a5fff44d71c5ed2634a26d685f2f6'
}

const browser_stake_address = 'stake_test1uqwcrkr4chst8xnk5se4442fz5ku5ekql644zew5l5uwswgf643wf';

const cip8_signing_stake_key = {
    "COSE_Sign1_hex": "84582aa201276761646472657373581de1186d791fdaaed961212850f6d0a67d0b49c7cab1e17ac7ccb46edebda166686173686564f44661626331323358407dd6f3ae68f2b7ab791d89c37d2d3e00b5a10c36b4b560091aa644aa15e0f00f6ce933399573a65112f2aacae9fe5d44a517fe6398452b6f8972006c9f5bd800",
    "COSE_Key_hex": "a40101032720062158204aaff6858aecf6aa6a4ce241b3a8c16ccc1c18684604beeb39ba92ced2f1f5b0"
}

const cip30_signing_stake_key = {
    "COSE_Sign1_hex": "84582aa201276761646472657373581de1186d791fdaaed961212850f6d0a67d0b49c7cab1e17ac7ccb46edebda166686173686564f44661626331323358407dd6f3ae68f2b7ab791d89c37d2d3e00b5a10c36b4b560091aa644aa15e0f00f6ce933399573a65112f2aacae9fe5d44a517fe6398452b6f8972006c9f5bd800",
    "COSE_Key_hex": "a40101032720062158204aaff6858aecf6aa6a4ce241b3a8c16ccc1c18684604beeb39ba92ced2f1f5b0"
}

const basic_signing_drep_key = {
    "signature": "5f61149ce87f9adc32f50edd6225c05da7284878bfd2d67a60c9c96eb7c0be254774a4741755741f710ad6ab5bbcf7266e9a6f6ec961f66dfe9ce3846f52aa04",
    "publicKey": "9d3c60458a81854624924a59544ee278ec1c7fa1ea69d0c4a3f27fcce5274dd8"
};

const cip8_signing_drep_key = {
    "COSE_Sign1_hex": "845829a201276761646472657373581cdb3b395fa83dc229be6fa122a6e887274d090ae7f20fa40657d98c69a166686173686564f44661626331323358406fe4f7e5c587c6ec339c596bae4edba1f396b9645a6349388c331a90e98f9429a6279f610bf2e5615e15ed6c3e4659f97bf3f03480f0d2402287c60a4d2cc90f",
    "COSE_Key_hex": "a40101032720062158209d3c60458a81854624924a59544ee278ec1c7fa1ea69d0c4a3f27fcce5274dd8"
};

const cip30_signing_drep_key = {
    "COSE_Sign1_hex": "845829a201276761646472657373581cdb3b395fa83dc229be6fa122a6e887274d090ae7f20fa40657d98c69a166686173686564f44661626331323358406fe4f7e5c587c6ec339c596bae4edba1f396b9645a6349388c331a90e98f9429a6279f610bf2e5615e15ed6c3e4659f97bf3f03480f0d2402287c60a4d2cc90f",
    "COSE_Key_hex": "a40101032720062158209d3c60458a81854624924a59544ee278ec1c7fa1ea69d0c4a3f27fcce5274dd8"
};

const basic_signing_pool_key = {
    "signature": "ad1111b77f3b447a1193d3d2671f89618a972e97c2fe68e25dbf36eb4cd6a416ae31c50c94ca3a08ff42ab034b8820deb5ff0ddf0446afa9ef4e1d44ba2e4e0e",
    "publicKey": "9189bac720795cd578ebe3062936c22d694fe0b40497556e0b74bf2f3907158a"
};

const cip8_signing_pool_key = {
    "COSE_Sign1_hex": "845829a201276761646472657373581c657bed6d71482e8d5412ee86a1d8edd510fbfbb1049a525ba48b80c2a166686173686564f4466162633132335840c09458485165d473bb695a8c51daf1ff7df1667ec4e1055923473c3450b630c934eb5aaa611c05821781d9aba601321edf28bb415197532f2c829ceb3043f50a",
    "COSE_Key_hex": "a40101032720062158209189bac720795cd578ebe3062936c22d694fe0b40497556e0b74bf2f3907158a"
}

const cip30_signing_pool_key = {
    "COSE_Sign1_hex": "845829a201276761646472657373581c657bed6d71482e8d5412ee86a1d8edd510fbfbb1049a525ba48b80c2a166686173686564f4466162633132335840c09458485165d473bb695a8c51daf1ff7df1667ec4e1055923473c3450b630c934eb5aaa611c05821781d9aba601321edf28bb415197532f2c829ceb3043f50a",
    "COSE_Key_hex": "a40101032720062158209189bac720795cd578ebe3062936c22d694fe0b40497556e0b74bf2f3907158a"
}

const valid_calidus_payload = {
    "COSE_Sign1_hex": "84582aa201276761646472657373581da1c4342b0b1bfa15c5ba43a3fba9ed6accf22ca00638f98661df4335c9a166686173686564f458496c6f67696e5f706f6f6c31726b667339676c6d667661336a64307139766e6c717675686e72666c707a6a346c303775367361796678356b376437383875735f313233343536373839305840028a77482a8aa04e7ca903ed8f164160ee73bd5eafe9e41192a17d64865ba537cc7acf8b0c9bbc6e7b0a61c11098e4a65522a6a5f8c1a05f9099d9670f3e310f",
    "COSE_Key_hex": "a40101032720062158208afb6bfa5d87d5a798a4d794a2f7921c8857e6c386704ef6bea6ad84ef153aa6",
    "payload": "6c6f67696e5f706f6f6c31726b667339676c6d667661336a64307139766e6c717675686e72666c707a6a346c303775367361796678356b376437383875735f31323334353637383930",
    "pool_id": "pool1rkfs9glmfva3jd0q9vnlqvuhnrflpzj4l07u6sayfx5k7d788us",
}

const invalid_calidus_payload = {
    "COSE_Sign1_hex": "84582aa201276761646472657373581da1c4342b0b1bfa15c5ba43a3fba9ed6accf22ca00638f98661df4335c9a166686173686564f458496c6f67696e5f706f6f6c31726b667339676c6d667661336a64307139766e6c717675686e72666c707a6a346c303775367361796678356b376437383875735f313233343536373839305840028a77482a8aa04e7ca903ed8f164160ee73bd5eafe9e41192a17d64865ba537cc7acf8b0c9bbc6e7b0a61c11098e4a65522a6a5f8c1a05f9099d9670f3e310f",
    "COSE_Key_hex": "a40101032720062158208afb6bfa5d87d5a798a4d794a2f7921c8857e6c386704ef6bea6ad84ef153aa6",
    "payload": "6164616d20697320617765736f6d65",
    "pool_id": "pool1rkfs9glmfva3jd0q9vnlqvuhnrflpzj4l07u6sayfx5k7d788us",
}

const unregistered_calidus_payload = {
    "COSE_Sign1_hex": "84582aa201276761646472657373581da1b188ec376bb87eec662ef4c2b2b4a283c40d48c4255d9fa396cd113ba166686173686564f458496c6f67696e5f706f6f6c316d38676c61643430347a68777361366b326c616c6d367175393570746666666a39756b35647270686d753072736a336d6e617a5f313233343536373839305840362029479183ba70f4f44004157db685f58061b487db92c4afb33cf6cc63c82a9c68ac2a857c2bce238f9c653476741f68d19401799b2563785684170b72e107",
    "COSE_Key_hex": "a40101032720062158202819290ac05b4a49331d1781ce1dfc04cddfa8875abee8303ea5311878f12daf",
    "payload": "login_pool1m8glad404zhwsa6k2lalm6qu95ptfffj9uk5drphmu0rsj3mnaz_1234567890",
    "pool_id": "pool1m8glad404zhwsa6k2lalm6qu95ptfffj9uk5drphmu0rsj3mnaz",
}

describe('General Tests', () => {
    test('Empty Signature', async () => {
        expect(await verifySignature(generic_payload, mainnet_stake_address)).toEqual({
            error: "Signature is not a valid JSON object",
        });
    })

    test('Missing address', async () => {
        expect(await verifySignature(generic_payload)).toEqual({
            error: "Signer address is not provided"
        })
    })

    test("Invalid Address with Basic Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_cip129_drep_id, basic_signing_stake_key)).toEqual({
            "error": "The key used for signing does not match the address provided!"
        });
    })
})

describe("Verifying Stake Based Signatures", () => {
    test("Basic Mainnet Stake Key Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_stake_address, basic_signing_stake_key)).toBe(true)
    })

    test("CIP-8 Stake Key Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_stake_address, cip8_signing_stake_key)).toBe(true)
    })

    test("CIP-30 Stake Key Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_stake_address, cip30_signing_stake_key)).toBe(true)
    })

    test("Basic Testnet Stake Key Signature", async () => {
        expect(await verifySignature(generic_payload, testnet_stake_address, basic_signing_stake_key)).toBe(true);
    })

    test('Browser-based stake key signature', async () => {
        expect(await verifySignature(browser_payload, browser_stake_address, browser_basic_signing_stake_key)).toBe(true);
    })
})

describe("Verifying DRep Signatures", () => {

    test("Basic DRep Signature with CIP-105 ID", async () => {
        expect(await verifySignature(generic_payload, mainnet_cip105_drep_id, basic_signing_drep_key));
    })

    test("Basic DRep Signature with CIP-129 ID", async () => {
        expect(await verifySignature(generic_payload, mainnet_cip129_drep_id, basic_signing_drep_key));
    })

    test("CIP-8 Drep Signature with CIP-105 ID", async () => {
        expect(await verifySignature(generic_payload, mainnet_cip105_drep_id, cip8_signing_drep_key))
    })

    test("CIP-8 DRep Signature with CIP-129 ID", async () => {
        expect(await verifySignature(generic_payload, mainnet_cip129_drep_id, cip8_signing_drep_key))
    })
})

describe("Verifying Pool Signatures", () => {
    test("Basic Pool Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_pool_id, basic_signing_pool_key))
    })

    test("CIP-8 Pool Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_pool_id, cip8_signing_pool_key))
    })

    test("CIP-30 Pool Signature", async () => {
        expect(await verifySignature(generic_payload, mainnet_pool_id, cip30_signing_pool_key))
    })

    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
    })


    test("Valid Calidus Key Signature", async () => {
        process.env.NETWORK_NAME = 'preprod';
        const response = await verifySignature(valid_calidus_payload.payload, valid_calidus_payload.pool_id, valid_calidus_payload)
        expect(response).toBe(true);
    });

    test("Invalid Calidus Key Payload", async () => {
        process.env.NETWORK_NAME = 'preprod';
        const response = await verifySignature(invalid_calidus_payload.payload, invalid_calidus_payload.pool_id, invalid_calidus_payload)
        expect(response).toBe(false);
    })

    // Skipped: fixture decay. The fixture pool_id had no Calidus key registered
    // when this test was written; the same pool now has a registered Calidus
    // (verified via Koios on preprod). The verifier therefore takes the
    // "registration found" path and returns plain `false` from the underlying
    // ed25519 verify rather than the "key does not match" error.
    // TODO: replace the fixture with a pool that genuinely has no Calidus
    // registration, OR mock fetchCalidusKey to deterministically return null
    // and re-enable this test.
    test.skip("Unregistered Calidus Key", async () => {
        process.env.NETWORK_NAME = 'preprod';
        const response = await verifySignature(unregistered_calidus_payload.payload, unregistered_calidus_payload.pool_id, unregistered_calidus_payload);
        expect(response.error).toBe("The key used for signing does not match the address provided!");
    });
})