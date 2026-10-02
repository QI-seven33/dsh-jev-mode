// Deterministic first; the semantic model sees only a bounded unresolved case.
// No task IDs, expected answers, file contents or model-generated paths here.
import { eligibleRequest } from './controlled.js';

export function planInspection(text, candidates) {
  if (!eligibleRequest(text)) return { kind: 'ordinary', reason: 'ineligible_request' };
  const manifest = /package\.json|\b(?:dependencies|framework|scripts)\b|依赖|框架|脚本|项目清单/i.test(text);
  const readme = /README(?:\.md)?|项目说明/i.test(text);
  if (manifest !== readme) {
    const id = manifest ? 'project_manifest' : 'project_readme';
    const action = candidates.find(item => item.id === id);
    return action ? { kind: 'code', action, reason: 'explicit_family' }
      : { kind: 'ordinary', reason: 'explicit_target_unavailable' };
  }
  // Two requested files require ordinary multi-step planning. Only an explicit
  // contrast/exclusion with both safe candidates is a semantic selection case.
  if (manifest && readme && candidates.length === 2 &&
      /无需|无须|不必|不用|而非|而不是|instead of|rather than|\bonly\b/i.test(text) &&
      !/分别|各自|两[个份]|\bboth\b|respectively/i.test(text)) {
    return { kind: 'semantic', reason: 'contrastive_single_read' };
  }
  return { kind: 'ordinary', reason: 'compound_or_no_single_target' };
}
