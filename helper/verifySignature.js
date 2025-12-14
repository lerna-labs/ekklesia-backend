import {bech32} from "bech32";
import {default as cbor} from "cbor";
import pkg from "blakejs";

const {blake2bHex} = pkg;

import {
    PublicKey,
    Ed25519Signature,
} from "@emurgo/cardano-serialization-lib-nodejs";
import {extractParts, getAddressType} from "./validateAddress.js";
import {getScript} from "./koios.js";

export async function verifySignature(
    payload,
    address,
    signature,
    script_body
) {
    if (!payload) {
        return {
            error: "Payload is missing",
        };
    }

    if (!address) {
        return {
            error: "Signer address is not provided",
        };
    }

    // check if signature is a json object
    if (typeof signature !== "object") {
        return {
            error: "Signature is not a valid JSON object",
        };
    }

    let verification_key, signed_payload_hex, ed_sig;
    let public_key_hex, ed_signature_hex;

    try {
        // Sometimes a witness that looks like a regular Ed25519 signature may actually be cbor-encoded, discover that
        // here and convert to cose-structure if so.
        cbor.decode(signature.key);
        cbor.decode(signature.signature);
        signature.COSE_Sign1_hex = signature.signature;
        signature.COSE_Key_hex = signature.key;
    } catch (e) {
        // fail silently, it's probably a regular ed25519 witness in this case...
    }

    if (signature.COSE_Sign1_hex) {
        if (!regExpHex.test(signature.COSE_Sign1_hex)) {
            return {
                error: "COSE Signature is invalid",
            };
        }

        if (!regExpHex.test(signature.COSE_Key_hex)) {
            return {
                error: "COSE Key is invalid",
            };
        }

        try {
            const cose_key_structure = cbor.decode(
                Buffer.from(signature.COSE_Key_hex, "hex")
            );
            const error = validate_cose_key(cose_key_structure);
            if (error) {
                return error;
            }

            const pub_key_buffer = cose_key_structure.get(-2);
            public_key_hex = pub_key_buffer.toString("hex");
        } catch (error) {
            return {
                error: "COSE Key is invalid",
            };
        }

        try {
            const cose_sign1_structure = cbor.decode(
                Buffer.from(signature.COSE_Sign1_hex, "hex")
            );

            const error = validate_cose_sign1(cose_sign1_structure);
            if (error) {
                return error;
            }

            let unprotectedHeader = cose_sign1_structure[1];
            if (
                !(unprotectedHeader instanceof Map) &&
                typeof unprotectedHeader === "object"
            ) {
                unprotectedHeader = new Map(Object.entries(unprotectedHeader));
            }

            if (!(unprotectedHeader instanceof Map)) {
                return {
                    error: "Unprotected header is not a map",
                };
            }

            const isHashed = unprotectedHeader.get("hashed");
            if (isHashed) {
                payload = getHash(payload, 28);
            }

            signed_payload_hex = make_cose1_sig_structure(
                payload,
                cose_sign1_structure
            );

            ed_signature_hex = cose_sign1_structure[3].toString("hex");
        } catch (error) {
            return {
                error: "COSE Signature is invalid",
            };
        }
    } else {
        if (regExpHex.test(payload)) {
            signed_payload_hex = payload;
        } else {
            signed_payload_hex = Buffer.from(payload).toString("hex");
        }

        // Do regular key shit here...
        if (!regExpHex.test(signature.signature)) {
            // The signature is not hex, maybe it's CBOR?
            try {
                signature.signature = Buffer.from(
                    bech32.fromWords(bech32.decode(signature.signature, 128).words)
                ).toString("hex");
            } catch (error) {
                return {
                    error: "Signature is invalid",
                };
            }
        }

        ed_signature_hex = signature.signature;
        public_key_hex = signature.publicKey || signature.key;
    }

    try {
        verification_key = PublicKey.from_hex(public_key_hex);
    } catch (error) {
        return {
            error: "Invalid signature key",
        };
    }

    try {
        ed_sig = Ed25519Signature.from_hex(ed_signature_hex);
    } catch (error) {
        return {
            error: "Invalid signature",
        };
    }

    const type_details = getAddressType(address);

    // Checking that the provided address matches the signing key used
    const {words} = bech32.decode(address, 1000); // <-- edit by Martin
    const body_hex = Buffer.from(bech32.fromWords(words)).toString("hex");
    let keyHash;
    if (body_hex.length > 56) {
        // This is a type of key that has a prefix/header byte
        const [, keyBody] = extractParts(body_hex);
        keyHash = keyBody;
    } else {
        keyHash = body_hex;
    }
    const SignatureKeyHash = verification_key.hash();

    switch (type_details.type) {
        case "pool":
            // In the case of a stake pool, we need to look up their Calidus key!
            // const latest_calidus = await fetch(`https://sentinel.veriglyph.io/certificates/latest?scope=pool&id=${keyHash}`);
            let koios_endpoint = 'https://api.koios.rest';
            switch (process.env.NETWORK_NAME) {
                case 'preprod':
                    koios_endpoint = 'https://preprod.koios.rest';
                    break;
                case 'preview':
                    koios_endpoint = 'https://preview.koios.rest';
                    break;
            }

            const latest_calidus = await fetch(`${koios_endpoint}/api/v1/pool_calidus_keys?pool_id_bech32=eq.${address}`);
            const latest_calidus_body = await latest_calidus.json();
            const calidus_key = latest_calidus_body[0];

            if (calidus_key !== undefined && calidus_key.pool_status === 'registered') {
                keyHash = PublicKey.from_hex(calidus_key.calidus_pub_key).hash().to_hex();
            }
            break;
        default:
            break;
    }
    if (!keyHash.includes(SignatureKeyHash.to_hex())) {
        return {
            error: "The key used for signing does not match the address provided!",
        };
    }

    return verification_key.verify(
        Buffer.from(signed_payload_hex, "hex"),
        ed_sig
    );
}

export async function isPartyToScript(
    payload,
    address,
    signature,
    script_body
) {
    if (!payload) {
        return {
            error: "Payload is missing",
        };
    }

    if (!address) {
        return {
            error: "Signer address is not provided",
        };
    }

    // check if signature is a json object
    if (typeof signature !== "object") {
        return {
            error: "Signature is not a valid JSON object",
        };
    }

    const address_type = getAddressType(address);
    if (address_type.hashType !== "script") {
        return {
            error: "Address is not script-based",
        };
    }

    if (!script_body) {
        script_body = await getScript(address_type.keyHash);
    }

    if (script_body.type !== "timelock") {
        return {
            error: "Only native scripts are supported",
        };
    }

    const criteria = getScriptCriteria(script_body.value);

    signature = standardize_signature(signature);

    const {verification_key, ed_sig, signed_payload_hex} =
        get_key_signature_and_payload(signature, payload);

    const SignatureKeyHash = verification_key.hash();
    if (criteria.keys.includes(SignatureKeyHash.to_hex())) {
        return verification_key.verify(
            Buffer.from(signed_payload_hex, "hex"),
            ed_sig
        );
    } else {
        return {
            error: "The signature is not part of the script",
        };
    }
}

export async function validateScriptSignatures(
    payload,
    address,
    signatures,
    script_body
) {
    if (!payload) {
        return {
            error: "Payload is missing",
        };
    }

    if (!address) {
        return {
            error: "Signer address is not provided",
        };
    }

    if (!Array.isArray(signatures)) {
        return {
            error: "Signatures must be an array",
        };
    }

    const address_type = getAddressType(address);

    if (!script_body) {
        script_body = await getScript(address_type.keyHash);
    }

    if (script_body.type !== "timelock") {
        return {
            error: "Only native scripts are supported",
        };
    }

    const script_criteria = getScriptCriteria(script_body.value);

    for (let signature of signatures) {
        signature = standardize_signature(signature);
        const is_signature_in_script = await isPartyToScript(
            payload,
            address,
            signature,
            script_body
        );
        if (is_signature_in_script === true) {
            const {verification_key} = get_key_signature_and_payload(
                signature,
                payload
            );
            const SignatureKeyHash = verification_key.hash().to_hex();
            if (script_criteria.signers.includes(SignatureKeyHash)) {
                // Double signer... do not count it
                continue;
            }

            script_criteria.signers.push(SignatureKeyHash);
            script_criteria.signed++;
        }
    }

    return script_criteria.signed >= script_criteria.required;
}

export function getScriptCriteria(
    script_contents,
    carry = {keys: [], signers: [], signed: 0, required: 1, count: 0}
) {
    script_contents.scripts.forEach((script) => {
        switch (script.type) {
            case "sig":
                carry.keys.push(script.keyHash);
                carry.count++;
                break;
            case "after":
            case "before":
                // Ignore
                break;
            default:
                carry = getScriptCriteria(script, carry);
                break;
        }
    });

    switch (script_contents.type) {
        case "all":
            carry.required = carry.count;
            break;
        case "any":
            carry.required = 1;
            break;
        case "atLeast":
            carry.required = script_contents.required;
            break;
        default:
            console.error("Unexpected script contents type!", script_contents.type);
            break;
    }

    return carry;
}

// Borrowed from cardano signer
const regExpHex = /^[0-9a-fA-F]+$/;

// Also borrowed from cardano signer
function getHash(content, digestLengthBytes = 32) {
    //hashes a given hex-string content with blake2b_xxx, digestLength is given via the digestLengthBytes parameter, key = null
    // if no digestLength is specified, use the default of 256bits/32bytes -> blake2b_256
    return blake2bHex(Buffer.from(content, "hex"), null, digestLengthBytes);
}

function validate_cose_key(cose_key_structure) {
    if (!cose_key_structure instanceof Map || cose_key_structure.size < 4) {
        return {
            error: "COSE Key is invalid",
        };
    }

    if (cose_key_structure.get(1) !== 1) {
        return {
            error: "COSE Key map label '1' (kty) is not '1' (OKP)",
        };
    }

    if (cose_key_structure.get(3) !== -8) {
        return {
            error: "COSE Key map label '3' (alg) is not '-8' (EdDSA)",
        };
    }

    if (cose_key_structure.get(-1) !== 6) {
        return {
            error: "COSE Key map label '-1' (crv) is not '6' (Ed25519)",
        };
    }

    if (!cose_key_structure.has(-2)) {
        return {
            error: "COSE Key map label '-2' (public key) is missing",
        };
    }

    const pub_key_buffer = cose_key_structure.get(-2);
    if (!Buffer.isBuffer(pub_key_buffer)) {
        return {
            error: "PublicKey entry of COSE Key is not a bytearray",
        };
    }

    return false;
}

function validate_cose_sign1(cose_sign1_structure) {
    if (
        !(cose_sign1_structure instanceof Array) ||
        cose_sign1_structure.length !== 4
    ) {
        return {
            error: "COSE Signature is invalid",
        };
    }

    const protectedHeader_buffer = cose_sign1_structure[0];
    if (!Buffer.isBuffer(protectedHeader_buffer)) {
        return {
            error: "COSE Signature protected Header is invalid",
        };
    }
    const protectedHeader = cbor.decode(protectedHeader_buffer);
    if (!protectedHeader.has(1)) {
        return {
            error: "Protected Header map label '1' i missing'",
        };
    }

    if (protectedHeader.get(1) !== -8) {
        return {
            error: "Protected Header map label '1' (alg) is not '-8' (EdDSA)",
        };
    }

    if (!protectedHeader.has("address")) {
        return {
            error: "Protected Header does not have 'address' label",
        };
    }

    const sign_addr_buffer = protectedHeader.get("address");
    if (!Buffer.isBuffer(sign_addr_buffer)) {
        return {
            error: "Protected Header signer address is not a bytearray",
        };
    }

    return false;
}

// updated make_cose1_sig_structure with kind regards of mr lang (/mad)
function make_cose1_sig_structure(payload, cose_sign1_structure) {
    const protectedHeader_cbor_hex = cose_sign1_structure[0].toString("hex");

    const sig_structure = [
        "Signature1",
        Buffer.from(protectedHeader_cbor_hex, "hex"),
        Buffer.from(""),
        Buffer.from(payload, "hex"),
    ];

    return cbor.encode(sig_structure).toString("hex");
}

function standardize_signature(signature) {
    if (typeof signature !== "object") {
        throw new Error("Signature is not a valid JSON object");
    }

    try {
        cbor.decode(signature.key);
        cbor.decode(signature.signature);
        signature.COSE_Sign1_hex = signature.signature;
        signature.COSE_Key_hex = signature.key;
    } catch (e) {
        // fail silently, it's probably a regular ed25519 witness in this case...
    }

    if (signature.signature) {
        if (!regExpHex.test(signature.signature)) {
            // The signature is not hex, maybe it's CBOR?
            try {
                signature.signature = Buffer.from(
                    bech32.fromWords(bech32.decode(signature.signature, 128).words)
                ).toString("hex");
            } catch (error) {
                throw new Error("Signature is invalid");
            }
        }
    }

    return signature;
}

function get_cose_public_key(signature) {
    if (!regExpHex.test(signature.COSE_Sign1_hex)) {
        throw new Error("COSE Signature is invalid");
    }

    if (!regExpHex.test(signature.COSE_Key_hex)) {
        throw new Error("COSE Key is invalid");
    }

    const cose_key_structure = cbor.decode(
        Buffer.from(signature.COSE_Key_hex, "hex")
    );
    const error = validate_cose_key(cose_key_structure);
    if (error) {
        throw new Error(error.error);
    }

    const pub_key_buffer = cose_key_structure.get(-2);
    return pub_key_buffer.toString("hex");
}

function get_cose_header(data) {
    let unprotectedHeader = data[1];
    if (
        !(unprotectedHeader instanceof Map) &&
        typeof unprotectedHeader === "object"
    ) {
        unprotectedHeader = new Map(Object.entries(unprotectedHeader));
    }

    if (!(unprotectedHeader instanceof Map)) {
        throw new Error("Unprotected header is not a map");
    }

    return unprotectedHeader;
}

function parse_cose_signature(signature, payload) {
    const cose_sign1_structure = cbor.decode(
        Buffer.from(signature.COSE_Sign1_hex, "hex")
    );

    const error = validate_cose_sign1(cose_sign1_structure);
    if (error) {
        throw new Error(error.message);
    }

    const unprotectedHeader = get_cose_header(cose_sign1_structure);

    const isHashed = unprotectedHeader.get("hashed");
    if (isHashed) {
        payload = getHash(payload, 28);
    }

    const payload_hex = make_cose1_sig_structure(payload, cose_sign1_structure);

    const signature_hex = cose_sign1_structure[3].toString("hex");

    return {payload_hex, signature_hex};
}

function get_key_signature_and_payload(signature, payload) {
    let public_key_hex, ed_signature_hex, signed_payload_hex;
    let verification_key, ed_sig;

    try {
        if (signature.COSE_Sign1_hex) {
            public_key_hex = get_cose_public_key(signature);
            const {payload_hex, signature_hex} = parse_cose_signature(
                signature,
                payload
            );
            signed_payload_hex = payload_hex;
            ed_signature_hex = signature_hex;
        } else {
            if (regExpHex.test(payload)) {
                signed_payload_hex = payload;
            } else {
                signed_payload_hex = Buffer.from(payload).toString("hex");
            }

            ed_signature_hex = signature.signature;
            public_key_hex = signature.publicKey || signature.key;
        }

        try {
            verification_key = PublicKey.from_hex(public_key_hex);
        } catch (error) {
            throw new Error("Invalid signature key");
        }

        try {
            ed_sig = Ed25519Signature.from_hex(ed_signature_hex);
        } catch (error) {
            throw new Error("Invalid signature");
        }
    } catch (error) {
        throw new Error(error.error);
    }

    return {
        verification_key,
        ed_sig,
        signed_payload_hex,
    };
}
