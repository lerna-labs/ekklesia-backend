/**
 * Unit tests for buildMineView() — the selection logic behind
 * GET /api/v1/votes/:ballotId/mine.
 *
 * Regression: a DRep whose ballot was confirmed at nonce 6 still had six
 * stale `failed` packages at nonce 1 (his first attempts). Those were
 * surfaced in `inFlight`, and the frontend editor rehydrated from them —
 * so he saw his first-version vote instead of the latest, even though the
 * voter directory (which reads the mirrored Vote.submittedVote) was
 * correct. Hydra enforces strict nonce === currentVersion + 1, so a
 * package at/below the confirmed head is permanently unsubmittable and
 * must not appear in inFlight. Pure + DB-free, so no Mongo needed.
 */

import { buildMineView } from '../routes/api/v1/votes.js';

const Q = '6a1512d73ea9a75799cf8f0a'; // a representative questionId

function pkg(id, nonce, status, selection, extra = {}) {
  return {
    _id: id,
    nonce,
    status,
    confirmedAt: status === 'hydra-confirmed' ? new Date('2026-06-07') : null,
    createdAt: new Date('2026-05-28'),
    hydraTxId: status === 'hydra-confirmed' ? `tx_${id}` : null,
    signingPayload: { votes: [{ questionId: Q, selection }] },
    ...extra,
  };
}

describe('buildMineView', () => {
  test('superseded failed packages (nonce <= confirmed head) are dropped from inFlight', () => {
    // The reported shape: confirmed at nonce 6, plus six failed nonce-1
    // corpses carrying the first version (selection [1]).
    const packages = [
      pkg('c1', 1, 'hydra-confirmed', [1]),
      pkg('c2', 2, 'hydra-confirmed', [2]),
      pkg('c3', 3, 'hydra-confirmed', [2]),
      pkg('c4', 4, 'hydra-confirmed', [2]),
      pkg('c5', 5, 'hydra-confirmed', [2]),
      pkg('c6', 6, 'hydra-confirmed', [2]), // latest, the real current vote
      pkg('f1', 1, 'failed', [1]),
      pkg('f2', 1, 'failed', [1]),
      pkg('f3', 1, 'failed', [1]),
      pkg('f4', 1, 'failed', [1]),
      pkg('f5', 1, 'failed', [1]),
      pkg('f6', 1, 'failed', [1]),
    ];

    const view = buildMineView(packages);

    expect(view.confirmed.nonce).toBe(6);
    expect(view.confirmed.packageId).toBe('c6');
    expect(view.confirmed.votes[Q]).toEqual({ selection: [2] });
    // The bug: these used to leak into inFlight and rehydrate [1].
    expect(view.inFlight).toEqual([]);
    // Summary still reports the full historical tally.
    expect(view.summary).toMatchObject({ confirmed: 6, failed: 6 });
  });

  test('a failed package ABOVE the confirmed head stays actionable for retry', () => {
    const packages = [
      pkg('c6', 6, 'hydra-confirmed', [2]),
      pkg('f1', 1, 'failed', [1]), // superseded -> dropped
      pkg('f7', 7, 'failed', [1]), // genuine latest attempt -> kept
    ];

    const view = buildMineView(packages);

    expect(view.confirmed.nonce).toBe(6);
    expect(view.inFlight).toHaveLength(1);
    expect(view.inFlight[0].packageId).toBe('f7');
    expect(view.inFlight[0].nonce).toBe(7);
  });

  test('with no confirmed package, all non-terminal packages remain in flight', () => {
    const packages = [
      pkg('d1', 1, 'draft', [1]),
      pkg('a2', 2, 'awaiting-signatures', [2]),
      pkg('x', 1, 'abandoned', [1]), // terminal -> always dropped
    ];

    const view = buildMineView(packages);

    expect(view.confirmed).toBeNull();
    expect(view.inFlight.map((p) => p.packageId)).toEqual(['a2', 'd1']); // newest first
  });

  test('string-typed nonces are compared numerically, not lexically', () => {
    // Legacy rows can store nonce as a string; "10" must beat "9".
    const packages = [
      pkg('c9', '9', 'hydra-confirmed', [1]),
      pkg('c10', '10', 'hydra-confirmed', [2]),
      pkg('f9', '9', 'failed', [1]), // <= head(10) -> dropped
    ];

    const view = buildMineView(packages);

    expect(view.confirmed.nonce).toBe(10);
    expect(view.confirmed.packageId).toBe('c10');
    expect(view.inFlight).toEqual([]);
  });
});
