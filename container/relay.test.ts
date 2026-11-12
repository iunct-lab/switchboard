import { afterEach, expect, test } from "bun:test";
import type { Socket } from "bun";
import { startRelay } from "./relay";

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

// a real downstream that answers with the address it sees the connection come from
function downstream(onClosed?: () => void) {
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        socket.write(`${socket.remoteAddress}|${Buffer.from(chunk).toString()}`);
      },
      close() {
        onClosed?.();
      },
    },
  });
  stops.push(() => server.stop(true));
  return server;
}

function dial(port: number) {
  const received: string[] = [];
  let closed: () => void = () => {};
  const closedP = new Promise<void>((r) => (closed = r));
  const got = (n: number) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => received.length >= n && (clearInterval(t), resolve()), 5);
    });
  const socket = Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        received.push(Buffer.from(chunk).toString());
      },
      close() {
        closed();
      },
    },
  });
  return { socket, received, got, closedP };
}

test("the downstream sees the connection from 127.0.0.1 and the bytes arrive in both directions", async () => {
  const target = downstream();
  const relay = startRelay(0, target.port, "127.0.0.1");
  stops.push(() => relay.stop(true));
  const c = dial(relay.port);
  const s = await c.socket;
  s.write("hello"); // written before the relay has dialed the target: it is queued, not lost
  await c.got(1);
  expect(c.received.join("")).toBe("127.0.0.1|hello");
  s.end();
});

test("the client closing closes the downstream's side", async () => {
  let closedDown: () => void = () => {};
  const downClosed = new Promise<void>((r) => (closedDown = r));
  const target = downstream(closedDown);
  const relay = startRelay(0, target.port, "127.0.0.1");
  stops.push(() => relay.stop(true));
  const c = dial(relay.port);
  const s = await c.socket;
  s.write("x");
  await c.got(1);
  s.end();
  await downClosed;
});

test("the downstream closing closes the client", async () => {
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end();
      },
    },
  });
  stops.push(() => server.stop(true));
  const relay = startRelay(0, server.port, "127.0.0.1");
  stops.push(() => relay.stop(true));
  const c = dial(relay.port);
  const s = await c.socket;
  s.write("x");
  await c.closedP;
});

test("a client is closed when nothing listens at the target", async () => {
  const dead = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = dead.port;
  dead.stop(true);
  const relay = startRelay(0, port, "127.0.0.1");
  stops.push(() => relay.stop(true));
  const c = dial(relay.port);
  await c.socket;
  await c.closedP;
});

test("a response larger than the socket buffers arrives whole (backpressure loses no byte)", async () => {
  const size = 32 * 1024 * 1024;
  const body = new Uint8Array(size).map((_, i) => i % 251);
  // the downstream itself writes only what the socket takes and the rest on drain
  const pump = (socket: Socket<{ rest: Uint8Array }>) => {
    while (socket.data.rest.length) {
      const n = socket.write(socket.data.rest);
      socket.data.rest = socket.data.rest.subarray(Math.max(n, 0));
      if (n <= 0) return;
    }
    socket.end();
  };
  const server = Bun.listen<{ rest: Uint8Array }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { rest: new Uint8Array(0) };
      },
      data(socket) {
        socket.data.rest = body;
        pump(socket);
      },
      drain: pump,
    },
  });
  stops.push(() => server.stop(true));
  const relay = startRelay(0, server.port, "127.0.0.1");
  stops.push(() => relay.stop(true));
  let got = 0;
  let sum = 0;
  let closed: () => void = () => {};
  const done = new Promise<void>((r) => (closed = r));
  const s = await Bun.connect({
    hostname: "127.0.0.1",
    port: relay.port,
    socket: {
      data(_s, chunk) {
        for (let i = 0; i < chunk.length; i++) sum = (sum + chunk[i]! * ((got + i) % 7)) % 1_000_000_007;
        got += chunk.length;
      },
      close() {
        closed();
      },
    },
  });
  s.write("go");
  await done;
  let want = 0;
  for (let i = 0; i < size; i++) want = (want + body[i]! * (i % 7)) % 1_000_000_007;
  expect(got).toBe(size);
  expect(sum).toBe(want);
}, 30_000);
