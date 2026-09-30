// Assemble the effective policy from all layers.
import { mergeLayers, readRepoPolicy, layerSource } from './policy.js';
import { learnedLayer } from './learn.js';
import { orgLayer } from './org.js';

/**
 * @param {string} root repo root
 * @param {{ managed: any }} config from loadConfig()
 * @param {number} nowTs
 * @param {{ refreshOrg?: boolean }} [o]
 */
export function loadPolicy(root, config, nowTs, o = {}) {
  const layers = [];
  const org = orgLayer(config.managed, nowTs, { refresh: !!o.refreshOrg });
  if (org && org.layer) layers.push(org.layer);
  const repo = readRepoPolicy(root);
  if (repo) layers.push({ name: 'repo', policy: repo.policy, source: layerSource('repo') });
  const learned = learnedLayer(nowTs);
  if (learned.layer) layers.push(learned.layer);
  const merged = mergeLayers(layers, { lockRepoAlternatives: !!(config.managed && config.managed.lock_repo_alternatives) });
  return {
    ...merged,
    suspected: learned.suspected,
    learnedEntries: learned.entries,
    repoProblems: repo ? repo.problems : [],
    org: org ? org.status : null,
  };
}
