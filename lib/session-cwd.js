// The immutable header names the original project. Newer hosts record current
// working-directory changes as host-owned durable events.
export function sessionCwd(session) {
  const events = session?.snapshotEvents?.() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') return event.data.cwd;
  }
  return session?.header?.cwd;
}
