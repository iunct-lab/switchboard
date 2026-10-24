/** The first line of `ops-kit/bin/docker` after the shebang; realCommand knows another copy of the front by it. */
export const DOCKER_MARK = "// docker-mark";

/** The options of `docker compose` itself that take a value (the same set as aws/host/docker.sh). */
const COMPOSE_VALUE = new Set(["-f", "--file", "-p", "--project-name", "--env-file", "--profile", "--project-directory", "--ansi", "--progress", "--parallel"]);

/** The options of `docker` itself that take a value (a separate argument; `--context=x` is one word and needs nothing). */
const DOCKER_VALUE = new Set(["-c", "--context", "-H", "--host", "-l", "--log-level", "--config", "--tlscacert", "--tlscert", "--tlskey"]);

/** Where the subcommand is: the first word that is neither an option of docker nor the value of one. -1 = none. */
function subcommandAt(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) return i;
    if (DOCKER_VALUE.has(a)) i++;
  }
  return -1;
}

/** `docker run` / `create` (and `container run` / `create`) get `label` (`key=value`) right after the subcommand; anything else is unchanged. */
export function markArgs(argv: string[], label: string): string[] {
  const add = ["--label", label];
  const first = subcommandAt(argv);
  if (first < 0) return argv;
  let at = first;
  if (argv[first] === "container") {
    const rest = subcommandAt(argv.slice(first + 1));
    at = rest < 0 ? -1 : first + 1 + rest;
  }
  if (at < 0 || (argv[at] !== "run" && argv[at] !== "create")) return argv;
  return [...argv.slice(0, at + 1), ...add, ...argv.slice(at + 1)];
}

/** `compose <globals> <sub> …`: the options of compose itself (to hand on to `config`) and its subcommand. */
export function composeTarget(argv: string[]): { globals: string[]; sub: string } | null {
  const at = subcommandAt(argv);
  if (at < 0 || argv[at] !== "compose") return null;
  const globals: string[] = [];
  for (let i = at + 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) return { globals, sub: a };
    globals.push(a);
    if (COMPOSE_VALUE.has(a) && i + 1 < argv.length) globals.push(argv[++i]!);
  }
  return null;
}

/** Subcommands after which the project has containers that the Task made. */
export const COMPOSE_STARTS = new Set(["up", "run", "create", "start"]);
