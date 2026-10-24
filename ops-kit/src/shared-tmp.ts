/**
 * The check behind `ops-kit/bin/deny-shared-tmp` (#764, docs/design/shared-tmp-guard.md): which paths a shell command
 * is about to write or remove right under `/tmp` by a fixed name. Two sessions of different repositories on one host
 * that pick the same name overwrite each other's files; `W=$(mktemp -d /tmp/<use>.XXXXXX)` gives each its own place.
 *
 * Not a shell: only what the text of the command names is read. A path built in a variable, `eval`, or a write inside
 * another script is not seen — the skills' rule (`mktemp -d`) comes first, this is the stop for the one who missed it.
 */

/** Right under `/tmp` (or `/private/tmp`), by a name that does not start with a variable. Deeper paths count too. */
const SHARED_TMP = /^(?:\/private)?\/+tmp\/+([^/$][^/]*)/;
/**
 * A name `mktemp` made from a `.XXXXXX` template: a dot, then six or more random letters and digits, at least one of
 * them a capital or a digit, not all `X` (the template itself) nor all digits (a date). Skills hand the printed path
 * from one shell to the next as text, so it is allowed.
 */
const MKTEMP_NAME = /\.([A-Za-z0-9]{6,})$/;

type Token = { op: string } | { word: string };

/** The commands of a command line: split on `;` `&&` `||` `|` `&`, line breaks, and the brackets of `$( )` and `( )`, outside quotes. Here-document bodies and comments are dropped. */
function lex(command: string): { text: string; tokens: Token[] }[] {
  const out: { text: string; tokens: Token[] }[] = [];
  let tokens: Token[] = [];
  let word: string | null = null;
  let start = 0;
  let delimNext = false;
  const heredocs: { delim: string; tabs: boolean }[] = [];
  const endWord = () => {
    if (word === null) return;
    if (delimNext) heredocs[heredocs.length - 1]!.delim = word;
    else tokens.push({ word });
    word = null;
    delimNext = false;
  };
  const endSegment = (end: number) => {
    endWord();
    if (tokens.length > 0) out.push({ text: command.slice(start, end).trim(), tokens });
    tokens = [];
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    const next = command[i + 1];
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close < 0 ? command.length : close;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) {
          s += command[j + 1];
          j += 2;
        } else s += command[j++];
      }
      word = (word ?? "") + s;
      i = j + 1;
    } else if (c === "\\") {
      if (next !== "\n") word = (word ?? "") + (next ?? "");
      i += 2;
    } else if (c === "#" && word === null) {
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? command.length : nl;
    } else if (c === "\n") {
      endSegment(i);
      i++;
      // the lines of each here-document that began on this line, up to its delimiter
      for (const h of heredocs.splice(0)) {
        while (i < command.length) {
          const nl = command.indexOf("\n", i);
          const line = command.slice(i, nl < 0 ? command.length : nl);
          i = nl < 0 ? command.length : nl + 1;
          if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
      start = i;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === ";" || c === "(" || c === ")" || c === "`" || c === "|" || (c === "&" && next !== ">")) {
      endSegment(i);
      i += (c === "|" && (next === "|" || next === "&")) || (c === "&" && next === "&") ? 2 : 1;
      start = i;
    } else if (c === ">" || c === "<" || c === "&") {
      // a redirection; a number right before it is its file descriptor (`2>`)
      let op = word !== null && /^\d+$/.test(word) ? word : "";
      if (op !== "") word = null;
      endWord();
      const m = /^(?:&>>?|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(command.slice(i))!;
      op += m[0];
      tokens.push({ op });
      i += m[0].length;
      if (m[0] === "<<" || m[0] === "<<-") {
        heredocs.push({ delim: "", tabs: m[0] === "<<-" });
        delimNext = true;
      }
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endSegment(command.length);
  return out;
}

/** The commands of a command line, as text (see lex). */
export function segments(command: string): string[] {
  return lex(command).map((s) => s.text);
}

function shared(path: string): boolean {
  const m = SHARED_TMP.exec(path);
  if (!m) return false;
  const made = MKTEMP_NAME.exec(m[1]!);
  return !(made && /[A-Z0-9]/.test(made[1]!) && !/^(X+|\d+)$/.test(made[1]!));
}

/** Words that run the next word as the command: wrappers, and the reserved words a command may follow. */
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "if", "then", "else", "elif", "while", "until", "do", "{", "!"]);
/** Commands that write or remove each operand, and those that write their last operand. */
const WRITE_ALL = new Set(["tee", "rm", "rmdir", "mkdir", "touch", "truncate"]);
const WRITE_LAST = new Set(["cp", "mv", "ln", "install"]);

/** What one command writes or removes, by its words (redirections already taken out). */
function written(words: string[]): string[] {
  let k = 0;
  while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!) || WRAPPERS.has(words[k]!) || (k > 0 && words[k]!.startsWith("-") && WRAPPERS.has(words[k - 1]!)))) k++;
  const name = words[k]?.split("/").pop();
  const args = words.slice(k + 1);
  const operands = (from: string[]) => {
    const dash = from.indexOf("--");
    return [...(dash < 0 ? from : from.slice(0, dash)).filter((a) => !a.startsWith("-")), ...(dash < 0 ? [] : from.slice(dash + 1))];
  };
  if (name === undefined) return [];
  if (WRITE_ALL.has(name)) return operands(args);
  if (WRITE_LAST.has(name)) {
    const ops = operands(args);
    return ops.length >= 2 ? [ops[ops.length - 1]!] : [];
  }
  if (name === "git") {
    let j = 0;
    while (j < args.length && args[j]!.startsWith("-")) j += args[j] === "-C" || args[j] === "-c" ? 2 : 1;
    if (args[j] === "worktree" && args[j + 1] === "add") return operands(args.slice(j + 2));
    if (args[j] === "clone") {
      const ops = operands(args.slice(j + 1));
      return ops.length >= 2 ? [ops[ops.length - 1]!] : [];
    }
  }
  return [];
}

/** The paths right under `/tmp` by a fixed name that the command writes or removes, in order, each once. */
export function sharedTmpWrites(command: string): string[] {
  const hits: string[] = [];
  for (const { tokens } of lex(command)) {
    const words: string[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if ("word" in t) {
        words.push(t.word);
        continue;
      }
      const target = tokens[k + 1];
      if (target === undefined || !("word" in target)) continue;
      k++;
      // `>&1` / `2>&-` duplicate a descriptor; `>& file` writes the file
      if (t.op.includes(">") && !(t.op.endsWith("&") && /^(\d+|-)$/.test(target.word))) hits.push(target.word);
    }
    hits.push(...written(words));
  }
  return [...new Set(hits.filter(shared))];
}
