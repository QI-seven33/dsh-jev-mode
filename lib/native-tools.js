// Native tool execution changed to batches in Desktop 0.2.2. Select the
// contract before dispatch; never retry a failed call through another path.
export async function executeNativeTool(tools, input) {
  if (typeof tools.setExecutor !== 'function') return tools.execute(input);
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name,
      arguments: JSON.stringify(input.arguments) }],
    agent: input.agent,
    signal: input.signal ?? new AbortController().signal,
  });
  if (!Array.isArray(batch?.results) || batch.results.length !== 1
      || batch.results[0].callId !== input.callId || !batch.results[0].result) {
    throw Error('Native tool executor returned an uncorrelated result');
  }
  return { ...batch.results[0].result, additionalContexts: batch.additionalContexts ?? [] };
}
