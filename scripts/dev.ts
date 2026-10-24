/**
 * Runs the core daemon (bun --watch) and the Vite dev server together with prefixed output.
 * dev.ts is also the daemon's supervisor: when core exits with RESTART_EXIT_CODE (the "適用してデーモン再起動"
 * button under supervision), it is respawned on the current code; any other exit stops everything.
 */
import { join } from "node:path";

const RESTART_EXIT_CODE = 75;
const root = join(import.meta.dir, "..");
const env = { ...process.env, FORCE_COLOR: "1", SWITCHBOARD_SUPERVISED: "1" };

function pipe(name: string, stream: ReadableStream<Uint8Array> | number | null | undefined) {
  if (!stream || typeof stream === "number") return;
  void (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        console.log(`[${name}] ${buf.slice(0, nl)}`);
        buf = buf.slice(nl + 1);
      }
    }
  })();
}

function spawn(name: string, cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env });
  pipe(name, proc.stdout);
  pipe(name, proc.stderr);
  return proc;
}

let core = spawn("core", ["bun", "--watch", "src/main.ts"], join(root, "packages", "core"));
const web = spawn("web ", ["bunx", "vite", "--host", "127.0.0.1", "--port", "5173"], join(root, "apps", "web"));
let stopping = false;

const stop = () => {
  stopping = true;
  core.kill();
  web.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

void (async () => {
  while (!stopping) {
    const code = await core.exited;
    if (stopping) break;
    if (code === RESTART_EXIT_CODE) {
      console.log("[dev ] core asked for a restart; respawning on the current code");
      core = spawn("core", ["bun", "--watch", "src/main.ts"], join(root, "packages", "core"));
      continue;
    }
    console.log(`[dev ] core exited (${code}); stopping`);
    stop();
  }
})();
void web.exited.then((code) => {
  if (!stopping) {
    console.log(`[dev ] web exited (${code}); stopping`);
    stop();
  }
});
