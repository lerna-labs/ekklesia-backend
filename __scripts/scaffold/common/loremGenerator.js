// Deterministic lorem-ish content generator for scaffold demos.
// No runtime deps — just a fixed wordlist + a SHA-256-keyed RNG so
// re-runs produce the same descriptions for the same seed.
//
// Sizes target visible UI states across the design system: a tight
// one-liner, a paragraph, a multi-paragraph block, and content at
// the schema limits. Ballot.description / Proposal.description cap
// at 2000 chars (per CompiledBallot MAX); we generate up to ~1900
// for the "limit" size to leave a small safety margin.

import crypto from 'node:crypto';

const WORDS = [
  'governance',
  'treasury',
  'stake',
  'delegation',
  'rewards',
  'epoch',
  'snapshot',
  'validator',
  'proposal',
  'consensus',
  'quorum',
  'threshold',
  'abstain',
  'ratify',
  'veto',
  'amendment',
  'constitution',
  'committee',
  'delegate',
  'stakeholder',
  'transparency',
  'audit',
  'ledger',
  'block',
  'transaction',
  'settlement',
  'finality',
  'protocol',
  'policy',
  'scope',
  'coverage',
  'eligibility',
  'framework',
  'architecture',
  'implementation',
  'specification',
  'metric',
  'outcome',
  'rationale',
  'summary',
  'context',
  'background',
  'objective',
  'deliverable',
  'milestone',
  'participant',
  'community',
  'ecosystem',
  'infrastructure',
  'education',
  'outreach',
  'research',
  'development',
  'operations',
  'maintenance',
  'innovation',
  'sustainability',
  'impact',
  'value',
  'alignment',
  'incentive',
  'alignment',
  'mechanism',
  'design',
  'review',
  'submission',
  'evaluation',
  'selection',
  'approval',
  'rejection',
  'recourse',
  'appeal',
  'amendment',
  'iteration',
  'the',
  'of',
  'to',
  'and',
  'for',
  'in',
  'on',
  'with',
  'by',
  'as',
  'from',
  'this',
  'that',
  'these',
  'those',
  'we',
  'they',
  'their',
  'our',
  'its',
  'should',
  'must',
  'may',
  'will',
  'can',
  'would',
  'could',
  'is',
  'are',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
];

const SENTENCE_TEMPLATES = [
  'The {0} requires careful consideration of {1} and {2}.',
  'We propose to {0} the existing {1} framework with a focus on {2}.',
  'This {0} establishes a clear {1} for ongoing {2} of the system.',
  'Stakeholders will benefit from improved {0} and stronger {1} guarantees.',
  'The {0} of this proposal ensures that {1} remains aligned with {2}.',
  'Implementation begins with {0}, followed by {1} and ongoing {2}.',
  'Each participating voter contributes to {0} via their {1}.',
  '{0} of the resulting {1} will be made available for community {2}.',
  'Failure to address {0} risks {1} of long-term {2}.',
  'This change formalizes {0} that has emerged from prior {1} cycles.',
];

function prand(...parts) {
  const buf = crypto.createHash('sha256').update(parts.join('|')).digest();
  return buf.readUInt32BE(0) / 0xffffffff;
}

function pickWord(seed, i) {
  return WORDS[Math.floor(prand(seed, 'w', i) * WORDS.length)];
}

function fillTemplate(template, seed, i) {
  return template.replace(/\{(\d)\}/g, (_, n) => pickWord(seed, `${i}_${n}`));
}

function sentence(seed, i) {
  const template = SENTENCE_TEMPLATES[Math.floor(prand(seed, 's', i) * SENTENCE_TEMPLATES.length)];
  const s = fillTemplate(template, seed, i);
  // Capitalize first letter (templates already start with capital
  // but tokens may bleed weirdly). No-op for normal cases.
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generate ~targetChars of lorem-ish content as 1+ paragraphs.
 * Deterministic per seed.
 *
 * @param {string} seed         e.g. ballot title or proposal title
 * @param {number} targetChars  approximate length cap (won't exceed)
 * @param {number} [paragraphs] split into N paragraphs (default 1, or
 *                              2-3 for longer content)
 */
export function loremText(seed, targetChars, paragraphs = 1) {
  if (targetChars <= 0) return '';
  const out = [];
  for (let p = 0; p < paragraphs; p++) {
    const target = Math.floor(targetChars / paragraphs);
    const sentences = [];
    let used = 0;
    let i = 0;
    while (used < target && i < 50) {
      const s = sentence(`${seed}|p${p}`, i);
      if (used + s.length + 1 > target) break;
      sentences.push(s);
      used += s.length + 1;
      i++;
    }
    // Guaranteed at least one sentence per paragraph even when target
    // is smaller than the shortest template — truncate to fit.
    if (sentences.length === 0) {
      const s = sentence(`${seed}|p${p}`, 0);
      sentences.push(s.length > target ? s.slice(0, Math.max(20, target - 1)) + '.' : s);
    }
    out.push(sentences.join(' '));
  }
  return out.join('\n\n');
}

// Bucket sizes for demo variety. Tuned so the smallest is under a
// tweet's worth and the largest sits just under the 2000-char schema
// MAX with a safety margin.
export const SIZE_BUCKETS = {
  tiny: { chars: 80, paragraphs: 1 },
  modest: { chars: 280, paragraphs: 1 },
  long: { chars: 900, paragraphs: 2 },
  limit: { chars: 1900, paragraphs: 3 },
};

/**
 * Pick a deterministic size bucket for a seed. Skews toward "modest"
 * so the demo isn't all extremes — most ballots look like real
 * governance proposals, with occasional tiny and limit examples to
 * exercise edge layout.
 */
export function pickSize(seed) {
  const r = prand(seed, 'size');
  if (r < 0.15) return 'tiny';
  if (r < 0.7) return 'modest';
  if (r < 0.92) return 'long';
  return 'limit';
}

/**
 * Convenience: generate a description for a seed at a chosen or
 * deterministic size.
 */
export function describe(seed, sizeOverride) {
  const size = sizeOverride || pickSize(seed);
  const bucket = SIZE_BUCKETS[size];
  return { text: loremText(seed, bucket.chars, bucket.paragraphs), size };
}

const FIRST_NAMES = [
  'Alice',
  'Bob',
  'Carol',
  'Dave',
  'Eve',
  'Frank',
  'Grace',
  'Heidi',
  'Ivan',
  'Judy',
  'Kim',
  'Leo',
  'Maria',
  'Nora',
  'Omar',
  'Priya',
  'Quinn',
  'Riya',
  'Sam',
  'Tara',
  'Uma',
  'Vito',
  'Wei',
  'Xiomara',
  'Yara',
  'Zane',
];
const LAST_NAMES = [
  'Reyes',
  'Tanaka',
  'Okafor',
  'Lindgren',
  'Petrov',
  'Chen',
  'Ahmed',
  'Silva',
  'Müller',
  'Kowalski',
  'Bianchi',
  'Singh',
  'Yusuf',
  'Park',
  'Nakamura',
  'Volkov',
  'Olsen',
  'Cohen',
  'Diaz',
  'Adler',
];

/**
 * Generate N deterministic author names for a seed.
 */
export function authorList(seed, count = 1) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const fi = Math.floor(prand(seed, 'fn', i) * FIRST_NAMES.length);
    const li = Math.floor(prand(seed, 'ln', i) * LAST_NAMES.length);
    out.push(`${FIRST_NAMES[fi]} ${LAST_NAMES[li]}`);
  }
  return out;
}

/**
 * Pick an integer in [min, max] deterministically.
 */
export function pickInt(seed, min, max) {
  return Math.floor(prand(seed, 'int') * (max - min + 1)) + min;
}

/**
 * Pick one item from a pool deterministically.
 */
export function pickOne(seed, pool) {
  return pool[Math.floor(prand(seed, 'one') * pool.length)];
}

/**
 * Generate a snapshot title with a governance-flavored prefix.
 */
const TITLE_PREFIXES = ['Proposal:', 'Initiative:', 'Amendment:', 'Motion:', 'Resolution:'];
const TITLE_TOPICS = [
  'Allocate treasury funds for community education',
  'Establish a new working group on protocol scaling',
  'Update the rewards distribution schedule',
  'Onboard a regional outreach contractor',
  'Fund infrastructure resilience research',
  'Adopt a constitutional amendment on quorum',
  'Approve the next milestone for the audit framework',
  'Sponsor a community-led tooling cohort',
  'Reallocate unused budget to long-term operations',
  'Charter a new oversight committee',
  'Recognize contributors via a non-treasury grant',
];

export function snapshotTitle(seed) {
  const prefix = pickOne(`${seed}|titleprefix`, TITLE_PREFIXES);
  const topic = pickOne(`${seed}|titletopic`, TITLE_TOPICS);
  return `${prefix} ${topic}`;
}
