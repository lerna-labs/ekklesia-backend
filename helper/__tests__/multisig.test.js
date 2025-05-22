import {validateAddress} from "../validateAddress.js";
import {
    isPartyToScript, validateScriptSignatures,
} from "../verifySignature.js";

const generic_payload = "616263313233"; // abc123 in hex

const ms = {
    one: {
        cip129: "drep1yv4vp94cvr45qllmf2y4tmc4cdm5hexxxtmdxvgfyheqymcz7rw5m",
        cip105: "drep_script19tqfdwrqadq8l762392779wrwa97f33j7mfnzzf97gpx7n6h8n2",
        script: {
            script_hash: "2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f",
            type: "timelock",
            value: {
                "type": "all",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "slot": 1,
                        "type": "after"
                    }
                ]
            }
        }
    },
    two: {
        cip129: "drep1ywmcuyry2hffh00c0jgu6yvmu726az6q0tra7udtjnua75ce4sj4y",
        cip105: "drep_script1k78pqez462dmm7ruj8x3rxl8jkhgksr6cl0hr2u5l804x39wg2p",
        script: {
            script_hash: "b78e106455d29bbdf87c91cd119be795ae8b407ac7df71ab94f9df53",
            type: "timelock",
            value: {
                "type": "all",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "type": "sig",
                        "keyHash": "898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682"
                    }
                ]
            }
        }
    },
    three: {
        cip129: "drep1y09t02jgq3m3tkl5qufq263ps8hwlkdyp0na2fxfvrp280qtck9lt",
        cip105: "drep_script1e2m65jqywu2ahaq8zgzk5gvpamhanfqtul2jfjtqc23mc2x4m04",
        script: {
            script_hash: "cab7aa48047715dbf40712056a2181eeefd9a40be7d524c960c2a3bc",
            type: "timelock",
            value: {
                "type": "all",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    }
                ]
            }
        }
    },
    four: {
        cip129: "drep1yvy0zyhz8f2vul0w80zdt663653jykggkm7lsnlccvtmwjq9ggwnt",
        cip105: "drep_script1prc39c362n88mm3mcn27k5w4yv39jz9klhuyl7xrz7m5s6lwyjn",
        script: {
            script_hash: "08f112e23a54ce7dee3bc4d5eb51d523225908b6fdf84ff8c317b748",
            type: "timelock",
            value: {
                "type": "atLeast",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "type": "sig",
                        "keyHash": "898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682"
                    },
                    {
                        "type": "sig",
                        "keyHash": "061bb6b5389d20a43fc0f7c29c0172ab601f7387eb6e91953149f84f"
                    }
                ],
                "required": 1
            }
        }
    },
    five: {
        cip129: "drep1y07lewz4r9svtyymalt0a8x0uapsra7xfwtu4df3n9mna2quw7syr",
        cip105: "drep_script1lh7ts4gevrzepxl06mlfenl8gvql03jtjl9t2vvewul2s29tyth",
        script: {
            script_hash: "fdfcb8551960c5909befd6fe9ccfe74301f7c64b97cab53199773ea8",
            type: "timelock",
            value: {
                "type": "atLeast",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "type": "sig",
                        "keyHash": "898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682"
                    },
                    {
                        "type": "sig",
                        "keyHash": "061bb6b5389d20a43fc0f7c29c0172ab601f7387eb6e91953149f84f"
                    }
                ],
                "required": 2
            }
        }
    },
    six: {
        cip129: "drep1ywl9h4y6lzskqsp8rjnws9fas84ad4j9tgh2e4uxvp3k2pcx5mqtx",
        cip105: "drep_script1hedafxhc59syqfcu5m5p20vpa0tdv32696kd0pnqvdjswcteyyf",
        script: {
            script_hash: "be5bd49af8a16040271ca6e8153d81ebd6d6455a2eacd78660636507",
            type: "timelock",
            value: {
                "type": "atLeast",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "type": "sig",
                        "keyHash": "898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682"
                    },
                    {
                        "type": "sig",
                        "keyHash": "061bb6b5389d20a43fc0f7c29c0172ab601f7387eb6e91953149f84f"
                    }
                ],
                "required": 3
            }
        }
    },
    seven: {
        cip129: "drep1ywxpj2ktns07rd9t6t45hzht4fk4x8lscj8ldatvqyuz35qsej0em",
        cip105: "drep_script13svj4juurlsmf27jad9c46a2d4f3luxy3lm02mqp8q5dq2aaks6",
        script: {
            script_hash: "8c192acb9c1fe1b4abd2eb4b8aebaa6d531ff0c48ff6f56c013828d0",
            type: "timelock",
            value: {
                "type": "any",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "type": "sig",
                        "keyHash": "898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682"
                    },
                    {
                        "type": "sig",
                        "keyHash": "061bb6b5389d20a43fc0f7c29c0172ab601f7387eb6e91953149f84f"
                    }
                ]
            }
        }
    },
    eight: {
        cip129: "drep1y0eqqva8t7s8d0e7eevz3s57plwwp9s8nf8zpxywz3e4lmglans2z",
        cip105: "drep_script17gqr8f6l5pmt70kwtq5v98s0mnsfvpu6fcsf3rs5wd076htz7fx",
        script: {
            script_hash: "f20033a75fa076bf3ece5828c29e0fdce096079a4e20988e14735fed",
            type: "timelock",
            value: {
                "type": "any",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83"
                    },
                    {
                        "type": "sig",
                        "keyHash": "898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682"
                    }
                ]
            }
        }
    },
    mesh: {
        cip129: "drep1ywn6ay0jca8v5lft9rk83dqtdqglx0ts9mkjq4ela47gyxgalt7ps",
        cip105: "drep_script157hfruk8fm9862ega3utgzmgz8en6upwa5s9w0ld0jppj30eew7",
        script: {
            script_hash: "a7ae91f2c74eca7d2b28ec78b40b6811f33d702eed20573fed7c8219",
            type: "timelock",
            value: {
                "type": "atLeast",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "4a38eddcc72ee01251623c86fc9dda8dc1db8f34b492811ddde8cca7"
                    }
                ],
                "required": 1
            }
        }
    },
    mesh2: {
        cip129: "drep1yv0adahffetszp9fg84qj8lek7vpvr5chga2ljtumu6fx0q2kggvm",
        cip105: "drep_script1rlt0d62w2uqsf22pagy3l7dhnqtqax9682hujlxlxjfnc3js8ug",
        script: {
            script_hash: "1fd6f6e94e570104a941ea091ff9b798160e98ba3aafc97cdf34933c",
            type: "timelock",
            value: {
                "type": "any",
                "scripts": [
                    {
                        "type": "sig",
                        "keyHash": "4a38eddcc72ee01251623c86fc9dda8dc1db8f34b492811ddde8cca7"
                    },
                    {
                        "type": "sig",
                        "keyHash": "bcf124a342874cc5c8e19db96ea7666ea62f5629e7ea29144a75e0b2"
                    },
                    {
                        "type": "sig",
                        "keyHash": "beab3ad938572f7483bda198447f7f26e396655fd29e0a43ba3a0030"
                    }
                ]
            }
        }
    }
};

const std_signatures = {
    one: {
        "signature": "83d60deffe16a3c053faa991096fffea143df6c750747240db44637c35b3609e144b780fba125c06ed44fd5800cec6538482bad177956b479acb32498fb99504",
        "publicKey": "3cb9bff98ca7a6f9cd71fae753545db5b791a0878ba5a59d3bcc9f820a36d038"
    },
    two: {
        "signature": "8fb3aa7884e2ee7ca61a27f56a5a642a44fadd3316e6fbe6642e149693aa7586e4df089101e7f5a49ae9bd3a89b69a5ea5cc3d5b17aa6450ad23ec3f2fad4a07",
        "publicKey": "2bf511b2895d8fd02acaf022f4196c26b711b33ec7a99f70079a532ffa9c3a3d"
    },
    three: {
        "signature": "30c78d57e4f476b714ac77cf6d47e9becb091a04644deb359a71ab0c17aa4277f42a84c0e939d9697b4aabd574b8d06b422ea6704097bf2d7fc0bc3452ff960a",
        "publicKey": "a4246f0b211fb0e956b5a2facd1353a861dfab5a11905e04190f1636fd16a2a4"
    },
    mesh: {
        "signature": "968d02da829617b99ac25cd3040e2af7caa6b2c5be2de946381340a6abf1d2f2f49abcc16394e471270efb052336383d3cf02861f584a3c6f3dcbc859da54a0f",
        "publicKey": "698fb01ab6dadc46816b5cceb24eccfa1a38957006d1e130c9d8d50feb43f4da"
    }
};

const cose_signatures = {
    one: {
        "COSE_Sign1_hex": "84582aa201276761646472657373581d2240f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83a166686173686564f4466162633132335840099035b23470465470ff3709568f3132931ccd8d4ecc5dd7b217f3ebd4cbb385a52d80aa5d77e1673037e66a755a65840b8576652200ba0a6d89600e2bf37207",
        "COSE_Key_hex": "a40101032720062158203cb9bff98ca7a6f9cd71fae753545db5b791a0878ba5a59d3bcc9f820a36d038"
    },
    two: {
        "COSE_Sign1_hex": "84582aa201276761646472657373581d22898d1847ebb5236ddd3d3d0c5cef0cc1d28ae7ff7a5db5a530d51682a166686173686564f44661626331323358407b2d7c5495e05f1a6c20f860391f7637a1f3a026de0dbbeb53c12ec0c28a095a1076e9d05c44d90d133b65c573e033bce4aef793224d012f9571ec66ecf6600a",
        "COSE_Key_hex": "a40101032720062158202bf511b2895d8fd02acaf022f4196c26b711b33ec7a99f70079a532ffa9c3a3d"
    },
    three: {
        "COSE_Sign1_hex": "84582aa201276761646472657373581d22061bb6b5389d20a43fc0f7c29c0172ab601f7387eb6e91953149f84fa166686173686564f44661626331323358407f35cbdd7b20e7f07bcfa74ceb48d508389cd1bbdb170c4a41d8be1f9ee112f4fdfe9201676c44564322d7e84bec428cf51f2127101fcdbbcf1c318d9850970c",
        "COSE_Key_hex": "a4010103272006215820a4246f0b211fb0e956b5a2facd1353a861dfab5a11905e04190f1636fd16a2a4"
    },
    mesh: {}
};

describe("Native Script Tests", () => {
    beforeAll(() => {
        process.env.API_URL = "https://preprod.koios.rest/api/v1";
    });

    describe("invalid arguments", () => {
        test("Missing payload", async () => {
            expect(await validateScriptSignatures())
                .toEqual({
                    error: "Payload is missing"
                });
        });

        test("Missing address", async () => {
            expect(await validateScriptSignatures(generic_payload))
                .toEqual({
                    error: "Signer address is not provided",
                });
        });

        test("Missing signatures", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.one.cip105))
                .toEqual({
                    error: "Signatures must be an array"
                });
        });

        test("Signature must be an array", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.one.cip105, std_signatures.one))
                .toEqual({
                    error: "Signatures must be an array"
                });
        });
    });

    describe("native script scenario #1: Time-locked Single Signer", () => {

        test("Key cannot sign in to Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.one.cip129, std_signatures.two, ms.one.script))
                .toEqual({
                    error: "The signature is not part of the script"
                });
        });

        test("Key cannot authenticate script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.one.cip129, [std_signatures.three], ms.one.script))
                .toEqual(false);
        });

        test("COSE Key cannot authenticate script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.one.cip105, [cose_signatures.two], ms.one.script))
                .toEqual(false);
        });

        describe("CIP-105 Tests", () => {
            test("Address Validation", () => {
                expect(validateAddress(ms.one.cip105, "drep"))
                    .toEqual({
                        "cip105": "drep_script19tqfdwrqadq8l762392779wrwa97f33j7mfnzzf97gpx7n6h8n2",
                        "cip129": "drep1yv4vp94cvr45qllmf2y4tmc4cdm5hexxxtmdxvgfyheqymcz7rw5m",
                        "isScript": true
                    });
            });

            test("Can Sign in with Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.one.cip105, std_signatures.one, ms.one.script))
                    .toEqual(true);
            });

            test("Can Authenticate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.one.cip105, [std_signatures.one], ms.one.script))
                    .toEqual(true);
            });

            test("COSE Sign can sign in with Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.one.cip105, cose_signatures.one, ms.one.script))
                    .toEqual(true);
            });
        });

        describe("CIP-129 Tests", () => {
            test("Address Validation", () => {
                expect(validateAddress(ms.one.cip129, "drep"))
                    .toEqual({
                        "cip105": "drep_script19tqfdwrqadq8l762392779wrwa97f33j7mfnzzf97gpx7n6h8n2",
                        "cip129": "drep1yv4vp94cvr45qllmf2y4tmc4cdm5hexxxtmdxvgfyheqymcz7rw5m",
                        "isScript": true
                    });
            });

            test("Can Sign In with Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.one.cip129, std_signatures.one, ms.one.script))
                    .toEqual(true);
            });

            test("Can Authenticate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.one.cip129, [std_signatures.one], ms.one.script))
                    .toEqual(true);
            });

            test("COSE Sign can sign in with Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.one.cip129, cose_signatures.one, ms.one.script))
                    .toEqual(true);
            });
        });
    });

    describe("native script scenario #2: All of Two Signers", () => {

        test("Not enough signatures to authenticate script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.two.cip105, [cose_signatures.one], ms.two.script))
                .toEqual(false);
        });

        describe("CIP-105", () => {
            test("Signer #1 Can Authenticate Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.two.cip105, std_signatures.one, ms.two.script))
                    .toBe(true);
            });

            test("Signer #2 Can Authenticate Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.two.cip105, std_signatures.two, ms.two.script))
                    .toBe(true);
            });

            test("Signer #3 Cannot Authenticate Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.two.cip105, std_signatures.three, ms.two.script))
                    .toEqual({"error": "The signature is not part of the script"});
            });

            test("Signers Can Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip105, [
                    std_signatures.one,
                    std_signatures.two
                ], ms.two.script))
                    .toBe(true);
            });

            test("Wrong Signers Cannot Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip105, [
                    std_signatures.one,
                    std_signatures.three
                ], ms.two.script))
                    .toBe(false);
            });

            test("Mixed Signature Types Can Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip105, [
                    std_signatures.one,
                    cose_signatures.two
                ], ms.two.script))
                    .toBe(true);
            });

            test("COSE Signatures Can Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip105, [
                    cose_signatures.one,
                    cose_signatures.two
                ], ms.two.script))
                    .toBe(true);
            });
        });

        describe("CIP-129", () => {
            test("Signer #1 Can Authenticate Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.two.cip129, std_signatures.one, ms.two.script))
                    .toBe(true);
            });

            test("Signer #2 Can Authenticate Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.two.cip129, std_signatures.two, ms.two.script))
                    .toBe(true);
            });

            test("Signer #3 Cannot Authenticate Script", async () => {
                expect(await isPartyToScript(generic_payload, ms.two.cip129, std_signatures.three, ms.two.script))
                    .toEqual({"error": "The signature is not part of the script"});
            });

            test("Signers Can Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip129, [
                    std_signatures.one,
                    std_signatures.two
                ], ms.two.script))
                    .toBe(true);
            });

            test("Wrong Signers Cannot Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip129, [
                    std_signatures.one,
                    std_signatures.three
                ], ms.two.script))
                    .toBe(false);
            });

            test("Mixed Signature Types Can Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip129, [
                    std_signatures.one,
                    cose_signatures.two
                ], ms.two.script))
                    .toBe(true);
            });

            test("COSE Signatures Can Validate Script", async () => {
                expect(await validateScriptSignatures(generic_payload, ms.two.cip129, [
                    cose_signatures.one,
                    cose_signatures.two
                ], ms.two.script))
                    .toBe(true);
            });
        });
    });
    describe("native script scenario #3: All of One Signer", () => {
        test("Signer Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.three.cip105, std_signatures.one, ms.three.script))
                .toBe(true);
        });

        test("Signer #2 Cannot Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.three.cip129, std_signatures.two, ms.three.script))
                .toEqual({"error": "The signature is not part of the script"});
        });

        test("Signer Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.three.cip129, [std_signatures.one], ms.three.script))
                .toBe(true);
        });

        test("COSE Signer Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.three.cip129, [cose_signatures.one], ms.three.script))
                .toBe(true);
        });

        test("Signer #2 Cannot Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.three.cip129, [std_signatures.two], ms.three.script))
                .toBe(false);
        });
    });
    describe("native script scenario #4: At Least One Signer", () => {
        test("Signer #1 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.four.cip105, std_signatures.one, ms.four.script))
                .toBe(true);
        });

        test("COSE Signer #2 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.four.cip129, cose_signatures.two, ms.four.script))
                .toBe(true);
        });

        test("Signer #3 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.four.cip105, std_signatures.three, ms.four.script))
                .toBe(true);
        });

        test("Signer #1 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.four.cip129, [std_signatures.one], ms.four.script))
                .toBe(true);
        });

        test("Signer #1 and #2 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.four.cip105, [
                std_signatures.one,
                cose_signatures.two
            ], ms.four.script))
                .toBe(true);
        });

        test("All Signers Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.four.cip129, [
                std_signatures.one,
                cose_signatures.two,
                cose_signatures.three
            ], ms.four.script))
                .toBe(true);
        });
    });
    describe("native script scenario #5: At Least Two Signers", () => {
        test("Signer #1 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.five.cip105, std_signatures.one, ms.five.script))
                .toBe(true);
        });

        test("COSE Signer #2 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.five.cip129, cose_signatures.two, ms.five.script))
                .toBe(true);
        });

        test("Signer #3 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.five.cip105, std_signatures.three, ms.five.script))
                .toBe(true);
        });

        test("Signer #1 Cannot Validate Script Alone", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.five.cip129, [std_signatures.one], ms.five.script))
                .toBe(false);
        });

        test("Signer #2 and #3 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.five.cip105, [
                cose_signatures.two,
                std_signatures.three
            ], ms.five.script))
                .toBe(true);
        });

        test("All Signers Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.four.cip129, [
                std_signatures.one,
                cose_signatures.two,
                cose_signatures.three
            ], ms.four.script))
                .toBe(true);
        });
    });
    describe("native script scenario #6: At Least All Signers", () => {
        test("Signer #1 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.six.cip105, std_signatures.one, ms.six.script))
                .toBe(true);
        });

        test("COSE Signer #2 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.six.cip129, cose_signatures.two, ms.six.script))
                .toBe(true);
        });

        test("Signer #3 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.six.cip105, std_signatures.three, ms.six.script))
                .toBe(true);
        });

        test("Signer #1 Cannot Validate Script Alone", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.six.cip129, [std_signatures.one], ms.six.script))
                .toBe(false);
        });

        test("Signer #2 and #3 Cannot Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.six.cip105, [
                cose_signatures.two,
                std_signatures.three
            ], ms.six.script))
                .toBe(false);
        });

        test("All Signers Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.four.cip129, [
                std_signatures.one,
                cose_signatures.two,
                cose_signatures.three
            ], ms.four.script))
                .toBe(true);
        });
    });
    describe("native script scenario #7: Any of Three Signers", () => {
        test("Signer #1 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.seven.cip105, std_signatures.one, ms.seven.script))
                .toBe(true);
        });

        test("COSE Signer #2 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.seven.cip129, cose_signatures.two, ms.seven.script))
                .toBe(true);
        });

        test("Signer #3 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.seven.cip105, std_signatures.three, ms.seven.script))
                .toBe(true);
        });

        test("Signer #1 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.seven.cip129, [std_signatures.one], ms.seven.script))
                .toBe(true);
        });

        test("Signer #1 and #2 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.seven.cip105, [
                std_signatures.one,
                cose_signatures.two
            ], ms.seven.script))
                .toBe(true);
        });

        test("All Signers Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.seven.cip129, [
                std_signatures.one,
                cose_signatures.two,
                cose_signatures.three
            ], ms.seven.script))
                .toBe(true);
        });
    });
    describe("native script scenario #8: Any of Two Signer", () => {
        test("Signer #1 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.eight.cip105, std_signatures.one, ms.eight.script))
                .toBe(true);
        });

        test("COSE Signer #2 Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.eight.cip129, cose_signatures.two, ms.eight.script))
                .toBe(true);
        });

        test("Signer #3 Cannot Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.eight.cip105, std_signatures.three, ms.eight.script))
                .toEqual({"error": "The signature is not part of the script"});
        });

        test("Signer #1 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.eight.cip129, [std_signatures.one], ms.eight.script))
                .toBe(true);
        });

        test("Signer #1 and #2 Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.eight.cip105, [
                std_signatures.one,
                cose_signatures.two
            ], ms.eight.script))
                .toBe(true);
        });
    });

    describe("native script scenario #9: Mesh Single Key", () => {
        test("CLI-Key Signature Can Authenticate Script", async () => {
            expect(await isPartyToScript(generic_payload, ms.mesh.cip129, std_signatures.mesh, ms.mesh.script))
                .toBe(true);
        });

        test("CLI-Key Signature Can Validate Script", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.mesh.cip105, [std_signatures.mesh], ms.mesh.script))
                .toBe(true);
        });

        test("CLI-Key Signature Can Authenticate Script #2", async () => {
            expect(await isPartyToScript(generic_payload, ms.mesh2.cip129, std_signatures.mesh, ms.mesh2.script))
                .toBe(true);
        });

        test("CLI-Key Signature Can Authenticate Script #2", async () => {
            expect(await validateScriptSignatures(generic_payload, ms.mesh2.cip105, [std_signatures.mesh], ms.mesh2.script))
                .toBe(true);
        });
    });
});