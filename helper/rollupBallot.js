import {getAddressType} from "./validateAddress.js";
import {MerkleTree} from "merkletreejs";
import crypto from "crypto";

const hashFunction = (data) => {
    return crypto.createHash("sha256")
        .update(data)
        .digest();
};

export async function rollupBallot($results, $weight, $epoch_no) {

    const ballot_id = $results.ballotId;
    const num_proposals = $results.proposals.length;

    const ballot = {
        ballot_id,
        proposals: [],
    };

    const results = {
        voter_weights: {},
        proposals: []
    };

    const ballot_proposals = [];
    const proposal_count_odd = num_proposals % 2;

    for (const proposal of $results.proposals) {
        const proposal_id = proposal.proposalId;

        const ballot_proposal = {
            ballot_id,
            proposal_id,
            votes: [],
        };

        const result_proposal = {
            ballot_id,
            proposal_id,
            name: proposal.name,
            results: {},
            weighted_results: {},
            stats: {
                total: 0,
                thresholds: {}
            }
        };

        for (const [key, option] of Object.entries(proposal.voteOptions)) {
            const label = option.value ?? option.id;
            result_proposal.results[label] = 0;
            result_proposal.weighted_results[label] = 0;
            result_proposal.stats.thresholds[label] = 0;
        }

        const num_votes = proposal.votes.length;
        const odd_num_votes = num_votes % 2;
        const prepared_votes = [];
        const proposal_voters = [];

        for (const vote of proposal.votes) {
            const id_parts = getAddressType(vote.userId);
            const voter_key_id = id_parts.keyHash;

            // Prefer submittedVote (schema field); accept legacy submittedValue for backward compatibility
            const submitted = vote.submittedVote ?? vote.submittedValue;
            if (submitted === undefined || submitted === null) {
                console.error("The vote does not have a submitted value!");
                throw new Error("Vote does not have a submitted value!");
            }

            if (proposal_voters.includes(voter_key_id)) {
                console.error(`How did this voter vote already?!`, proposal_id, vote);
                throw new Error("Duplicate voter!");
            }

            let vote_value;
            const submittedArr = Array.isArray(submitted) ? submitted : [submitted];

            switch (proposal.voteType) {
                case 'default':
                    vote_value = submittedArr[0].toString();
                    break;
                default:
                    // Convert submitted vote array to a string representation for use as object key
                    vote_value = submittedArr.length > 1
                        ? JSON.stringify(submittedArr)
                        : submittedArr[0].toString();
                    break;
            }

            const formatted_vote = [
                proposal_id,
                voter_key_id,
                vote_value
            ];

            if (result_proposal.results[vote_value] === undefined) {
                result_proposal.results[vote_value] = 0;
            }

            if (result_proposal.weighted_results[vote_value] === undefined) {
                result_proposal.weighted_results[vote_value] = 0;
            }

            if (results.voter_weights[voter_key_id] === undefined) {
                if ($weight) {
                    // If weights are supplied, find the voter's weight
                    const voter = $weight.find(v => v.drep_key_id === voter_key_id);

                    if (voter) {
                        let voter_power = 0;
                        if ($epoch_no) {
                            if ($epoch_no > voter.active_until) {
                                console.log(`Voter ${voter_key_id} is inactive at epoch ${$epoch_no}!`);
                                voter_power = 0;
                            } else {
                                voter_power = voter.amount;
                            }
                        } else {
                            voter_power = voter.amount;
                        }
                        results.voter_weights[voter_key_id] = voter_power.toString();
                    }

                    if (results.voter_weights[voter_key_id] === undefined) {
                        // If the voter weight is still undefined, they are a
                        // zero-weight voter
                        results.voter_weights[voter_key_id] = Number(0)
                            .toString();
                    }
                } else {
                    // If no weights are supplied, all voters have 1 "weight"
                    results.voter_weights[voter_key_id] = Number(1)
                        .toString();
                }
            }

            const voter_weight = results.voter_weights[voter_key_id];

            result_proposal.results[vote_value]++;
            result_proposal.weighted_results[vote_value] += Number(voter_weight);

            ballot_proposal.votes.push(formatted_vote);

            prepared_votes.push(prepare_vote(formatted_vote));
            proposal_voters.push(voter_key_id);

        }

        for (const [key, val] of Object.entries(result_proposal.weighted_results)) {
            // Handle array votes: parse JSON string if it's an array, otherwise treat as a number
            let key_val;
            let numeric_value;
            try {
                const parsed = JSON.parse(key);
                if (Array.isArray(parsed)) {
                    // For arrays, use the sum of absolute values, or first element if single-item
                    numeric_value = parsed.length === 1
                        ? Math.abs(Number(parsed[0]))
                        : parsed.reduce((sum, v) => sum + Math.abs(Number(v)), 0);
                    key_val = parsed;
                } else {
                    numeric_value = Math.abs(Number(key));
                    key_val = Number(key);
                }
            } catch (e) {
                // Not a JSON string, treat as number
                numeric_value = Math.abs(Number(key));
                key_val = Number(key);
            }

            // result_proposal.stats.total += numeric_value * Number(val);
            result_proposal.stats.total += Number(val);
            if (key_val !== 0 && result_proposal.stats.thresholds[key] === undefined) {
                result_proposal.stats.thresholds[key] = 0;
            }
        }

        for (const [key, val] of Object.entries(result_proposal.stats.thresholds)) {
            result_proposal.stats.thresholds[key] = result_proposal.weighted_results[key] / result_proposal.stats.total;
        }

        if (odd_num_votes) {
            // Preventing a strange error w/ odd-numbered merkle trees
            prepared_votes.push(prepare_vote([
                null,
                null,
                null
            ]));
        }

        const proposalTree = new MerkleTree(prepared_votes, hashFunction, {
            sortPairs: true,
            hashLeaves: true,
        });

        ballot_proposal.root = proposalTree.getHexRoot();

        ballot.proposals.push(ballot_proposal);

        ballot_proposals.push(proposalTree.getRoot());

        results.proposals.push(result_proposal);
    }

    if (proposal_count_odd) {
        ballot_proposals.push(Buffer.from(""));
    }

    const ballotTree = new MerkleTree(ballot_proposals, hashFunction, {
        sortPairs: true,
    });

    ballot.root = ballotTree.getHexRoot();
    for (const proposal of ballot.proposals) {
        proposal.proof = ballotTree.getHexProof(proposal.root);
        const prepared_votes = proposal.votes.map(prepare_vote);
        if (proposal.votes.length % 2) {
            // Odd number of votes, add an extra, blank entry at the end
            prepared_votes.push(prepare_vote([
                null,
                null,
                null
            ]));
        }
        const proposalTree = new MerkleTree(prepared_votes, hashFunction, {
            sortPairs: true,
            hashLeaves: true
        });
        proposal.votes = proposal.votes.map((vote) => {
            const prepared = prepare_vote(vote);
            return [
                vote,
                proposalTree.getHexProof(hashFunction(prepared))
            ];
        });
    }

    return [
        ballot,
        results
    ];
}

export function prepare_vote(vote) {
    return Buffer.from(JSON.stringify(vote));
}