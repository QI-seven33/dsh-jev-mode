// Counts/timestamps only. Never retain generated reasoning or visible text.
export function streamMetrics({ now = Date.now } = {}) {
  const started = now();
  const deltas = new Set();
  const row = { firstOutputMs: null, firstReasoningMs: null, firstTextMs: null, firstToolCallMs: null, reasoningChars: 0 };
  const first = key => { row[key] ??= now() - started; };
  return {
    accept(chunk) {
      if (chunk.type === 'reasoning-delta' && chunk.text?.length) {
        first('firstOutputMs'); first('firstReasoningMs');
        row.reasoningChars += chunk.text.length; deltas.add(chunk.index);
      }
      if (chunk.type === 'text-delta' && chunk.text?.length) { first('firstOutputMs'); first('firstTextMs'); }
      if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call') || chunk.type === 'tool-call-delta') {
        first('firstOutputMs'); first('firstToolCallMs');
      }
      if (chunk.type === 'block-end') {
        if (chunk.block?.type === 'reasoning' && chunk.block.text?.length) {
          first('firstOutputMs'); first('firstReasoningMs');
          if (!deltas.has(chunk.index)) row.reasoningChars += chunk.block.text.length;
        }
        if (chunk.block?.type === 'text' && chunk.block.text?.length) { first('firstOutputMs'); first('firstTextMs'); }
        if (chunk.block?.type === 'tool-call') { first('firstOutputMs'); first('firstToolCallMs'); }
      }
    },
    snapshot: () => ({ ...row }),
  };
}
