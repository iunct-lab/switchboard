# sb-gh-guard — /etc/profile.d/sb-gh-guard.sh (#824), put there by bootstrap.sh with @REPO@ / @HOME@ / @USER@ replaced: the
# host's interactive shells (the terminal tab's `bash -i` through /etc/bashrc, a login shell through /etc/profile) find
# the kit's `gh` first, so a `claude` / `codex` started by hand posts through the same check as a Task's
# (docs/design/secret-guard.md). The same order as a Task's PATH (packages/core/src/tasks.ts): the kit's bin first, bun
# last (the guard runs on bun). Sourced, so no `set -e` and no exit; read twice, PATH holds each once; without the
# checkout PATH is left as it is. Only the host user's shells: the checkout is writable by the agents, so root's PATH
# (and any other user's) never puts it first.
if [ "$(id -un 2>/dev/null)" = "@USER@" ] && [ -x "@REPO@/ops-kit/bin/gh" ]; then
  case ":$PATH:" in
    *":@REPO@/ops-kit/bin:"*) ;;
    *) PATH="@REPO@/ops-kit/bin:$PATH" ;;
  esac
  case ":$PATH:" in
    *":@HOME@/.bun/bin:"*) ;;
    *) PATH="$PATH:@HOME@/.bun/bin" ;;
  esac
  export PATH
fi
