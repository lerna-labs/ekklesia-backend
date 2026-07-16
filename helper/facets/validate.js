// Facet-definition validator. Used by:
//   - compiledBallot/validator.js at import time
//   - Ballot pre-save (future) to catch hand-edited docs
//
// Intentionally stateless and dependency-free. Returns a flat errors
// array with dotted paths so the caller can surface field-specific
// messages in the API response.

import { MAX } from '../compiledBallot/schema.js';

const FACET_TYPES = new Set(['enum', 'number', 'string', 'boolean', 'date']);
const KEY_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate an array of facet definitions.
 * @param {Array} facets
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string}> }}
 */
export function validateFacets(facets) {
  const errors = [];
  if (facets == null) return { ok: true, errors };
  if (!Array.isArray(facets)) {
    return { ok: false, errors: [{ path: 'facets', message: 'must be an array' }] };
  }
  if (facets.length > MAX.facets) {
    errors.push({ path: 'facets', message: `too many facets (max ${MAX.facets})` });
  }

  const seenKeys = new Set();
  let defaultSortCount = 0;

  facets.forEach((f, i) => {
    const p = `facets[${i}]`;
    if (!f || typeof f !== 'object') {
      errors.push({ path: p, message: 'must be an object' });
      return;
    }
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) {
      errors.push({ path: `${p}.key`, message: 'required, must match [a-zA-Z0-9_-]+' });
    } else if (seenKeys.has(f.key)) {
      errors.push({ path: `${p}.key`, message: `duplicate key "${f.key}"` });
    } else {
      seenKeys.add(f.key);
    }

    if (typeof f.label !== 'string' || f.label.length === 0 || f.label.length > MAX.label) {
      errors.push({ path: `${p}.label`, message: `required, ≤ ${MAX.label} chars` });
    }
    if (!FACET_TYPES.has(f.type)) {
      errors.push({
        path: `${p}.type`,
        message: `must be one of ${[...FACET_TYPES].join(', ')}`,
      });
    }

    const multi = f.multi === true;
    const sortable = f.sortable === true;
    if (multi && sortable) {
      errors.push({
        path: `${p}.sortable`,
        message: 'multi-value facets cannot be sortable',
      });
    }
    if (multi && f.type !== 'enum') {
      errors.push({
        path: `${p}.multi`,
        message: 'multi:true only valid for type:"enum"',
      });
    }

    if (f.type === 'enum') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        errors.push({
          path: `${p}.options`,
          message: 'required for type:"enum"',
        });
      } else {
        if (f.options.length > MAX.options) {
          errors.push({
            path: `${p}.options`,
            message: `too many options (max ${MAX.options})`,
          });
        }
        const optSeen = new Set();
        f.options.forEach((opt, j) => {
          const pp = `${p}.options[${j}]`;
          if (typeof opt !== 'string' || opt.length === 0) {
            errors.push({ path: pp, message: 'must be a non-empty string' });
            return;
          }
          if (opt.includes(',')) {
            errors.push({
              path: pp,
              message: 'option names must not contain a comma — CSV is the wire format',
            });
          }
          if (opt !== opt.trim()) {
            errors.push({ path: pp, message: 'must not have leading/trailing whitespace' });
          }
          if (optSeen.has(opt)) {
            errors.push({ path: pp, message: `duplicate option "${opt}"` });
          } else {
            optSeen.add(opt);
          }
        });
      }
    } else if (f.options != null && (!Array.isArray(f.options) || f.options.length > 0)) {
      errors.push({
        path: `${p}.options`,
        message: `only meaningful for type:"enum"`,
      });
    }

    if (f.defaultSort != null) {
      if (!['asc', 'desc'].includes(f.defaultSort)) {
        errors.push({
          path: `${p}.defaultSort`,
          message: 'must be "asc", "desc", or null',
        });
      } else if (!sortable) {
        errors.push({
          path: `${p}.defaultSort`,
          message: 'defaultSort requires sortable:true',
        });
      }
      defaultSortCount++;
    }
  });

  if (defaultSortCount > 1) {
    errors.push({
      path: 'facets',
      message: 'at most one facet may declare defaultSort',
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Split a CSV value off the wire into a trimmed, deduped string array.
 * Empty tokens are dropped. Consistent shape for both import-time and
 * query-time consumers.
 */
export function splitCsv(raw) {
  if (raw == null) return [];
  const s = String(raw);
  if (s.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const tok of s.split(',')) {
    const t = tok.trim();
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Validate a single proposal's snapshot.facets dict against a ballot's
 * declared facets. Returns { ok, errors[] } with dotted paths relative
 * to the caller-supplied `path` prefix.
 */
export function validateProposalFacetValues(values, facetDefs, { path = 'facets' } = {}) {
  const errors = [];
  if (values == null) return { ok: true, errors };
  if (typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, errors: [{ path, message: 'must be an object' }] };
  }
  const defByKey = new Map(facetDefs.map((f) => [f.key, f]));

  for (const [k, v] of Object.entries(values)) {
    const p = `${path}.${k}`;
    const def = defByKey.get(k);
    if (!def) {
      errors.push({ path: p, message: `unknown facet key "${k}"` });
      continue;
    }
    if (v == null || v === '') continue; // absent is fine

    if (def.type === 'enum') {
      const tokens = splitCsv(v);
      if (!def.multi && tokens.length > 1) {
        errors.push({ path: p, message: 'facet is not multi-valued' });
      }
      const allowed = new Set(def.options || []);
      for (const t of tokens) {
        if (!allowed.has(t)) {
          errors.push({ path: p, message: `"${t}" not in declared options` });
        }
      }
    } else if (def.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push({ path: p, message: 'must be a finite number' });
      }
    } else if (def.type === 'boolean') {
      if (typeof v !== 'boolean') {
        errors.push({ path: p, message: 'must be a boolean' });
      }
    } else if (def.type === 'date') {
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
        errors.push({ path: p, message: 'must be ISO8601 date string' });
      }
    } else if (def.type === 'string') {
      if (typeof v !== 'string') {
        errors.push({ path: p, message: 'must be a string' });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
