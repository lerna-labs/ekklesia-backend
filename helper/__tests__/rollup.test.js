import {rollupBallot} from "../rollupBallot.js";

import * as results from "./test_results.json";

import * as weights from "./dreps_epoch_556.json";

import fs from "fs";

describe("test ballot rollup functions", () => {
    test("basic ballot", async () => {
        const [
            ballot, ballot_results
        ] = await rollupBallot(results.default, weights.default);
        fs.writeFileSync("./helper/__tests__/ballot_output.json", JSON.stringify(ballot));
        fs.writeFileSync("./helper/__tests__/ballot_results.json", JSON.stringify(ballot_results));

        /**
         * Output a CSV of the results as well
         */
        const csvStream = fs.createWriteStream("./helper/__tests__/ballot_results.csv");
        ballot_results.proposals.map((proposal) => {
            csvStream.write([
                proposal.ballot_id,
                proposal.proposal_id,
                `"${proposal.name}"`,
                proposal.results["-1"] || 0,
                proposal.results["0"] || 0,
                proposal.results["1"] || 0,
                proposal.weighted_results["-1"] || 0,
                proposal.weighted_results["0"] || 0,
                proposal.weighted_results["1"] || 0,
                proposal.stats.total,
                proposal.stats.thresholds["-1"]?.toFixed(6) || 0,
                proposal.stats.thresholds["1"]?.toFixed(6) || 0
            ].join(",") + `\n`);
        });

        expect(ballot.root)
            .toEqual("0xc7c0fe0a7a047a96414c5b9c7cf7850f567a03c48e67f6d48b34404736d86d0b");
    });
});