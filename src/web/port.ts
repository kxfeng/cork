import net from "node:net";

/** Whether we could bind this port on this host right now. */
function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * The first free port at or after `from`. Used only to seed the config on first
 * run: if the default is already taken, cork picks a neighbour and writes THAT
 * down, so the port stays stable across restarts instead of drifting whenever
 * something else grabs it. A port the user has explicitly configured is never
 * second-guessed — if it is busy, the server fails and says so.
 */
export async function findFreePort(
  from: number,
  host = "127.0.0.1",
  attempts = 20
): Promise<number> {
  for (let port = from; port < from + attempts; port++) {
    if (await isFree(port, host)) return port;
  }
  return from; // give up and let the bind fail loudly
}
