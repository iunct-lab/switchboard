// A TCP relay for the stand-alone container (#4042): listens on 0.0.0.0:<listen-port> and passes every connection,
// byte for byte, to 127.0.0.1:<target-port>. The daemon only trusts loopback (packages/core/src/auth.ts), and a port
// published by docker reaches it from the bridge's address, so the daemon sees the relay's own 127.0.0.1 instead.
// WebSocket and SSE are bytes to this relay and pass as they are. Usage: bun container/relay.ts <listen-port> <target-port>
import type { Socket } from "bun";

// `out` holds what the socket has not taken yet: Socket.write() may take only part of a chunk when the kernel buffer is
// full, and the rest goes out on `drain`, so no byte is dropped under backpressure. `ending` closes the socket once
// `out` is empty (the other side has closed). Before the target is dialed, the client's bytes wait in `early`.
type Pipe = { peer?: Socket<Pipe>; out: Uint8Array[]; ending: boolean; early: Uint8Array[] };

const pipe = (): Pipe => ({ out: [], ending: false, early: [] });

function flush(socket: Socket<Pipe>) {
  const { out } = socket.data;
  while (out.length) {
    const chunk = out[0]!;
    const n = socket.write(chunk);
    if (n < chunk.length) {
      out[0] = chunk.subarray(Math.max(n, 0));
      return;
    }
    out.shift();
  }
  if (socket.data.ending) socket.end();
}

function send(to: Socket<Pipe>, chunk: Uint8Array) {
  // the chunk's memory is the runtime's and is reused after the callback: keep a copy of what waits
  to.data.out.push(new Uint8Array(chunk));
  if (to.data.out.length === 1) flush(to);
}

function closePeer(socket: Socket<Pipe>) {
  const { peer } = socket.data;
  if (!peer || peer.data.ending) return;
  peer.data.ending = true;
  if (!peer.data.out.length) peer.end();
}

function pipeHandlers() {
  return {
    data(socket: Socket<Pipe>, chunk: Uint8Array) {
      const { peer } = socket.data;
      // the peer is not connected yet (the target is still being dialed): keep the bytes in order
      if (!peer) socket.data.early.push(new Uint8Array(chunk));
      else send(peer, chunk);
    },
    drain: flush,
    close: closePeer,
    error: closePeer,
  };
}

export function startRelay(listenPort: number, targetPort: number, hostname = "0.0.0.0") {
  return Bun.listen<Pipe>({
    hostname,
    port: listenPort,
    socket: {
      ...pipeHandlers(),
      open(client) {
        client.data = pipe();
        void Bun.connect<Pipe>({
          hostname: "127.0.0.1",
          port: targetPort,
          data: pipe(),
          socket: {
            ...pipeHandlers(),
            open(upstream) {
              upstream.data.peer = client;
              client.data.peer = upstream;
              for (const chunk of client.data.early) send(upstream, chunk);
              client.data.early = [];
            },
            connectError() {
              client.end();
            },
          },
        }).catch(() => client.end());
      },
    },
  });
}

if (import.meta.main) {
  const [listenPort, targetPort] = process.argv.slice(2).map(Number);
  if (!listenPort || !targetPort) {
    console.error("usage: bun container/relay.ts <listen-port> <target-port>");
    process.exit(2);
  }
  startRelay(listenPort, targetPort);
}
