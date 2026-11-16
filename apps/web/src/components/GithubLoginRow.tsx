import { useEffect, useState } from "react";
import { api, type GithubStatus } from "../api.ts";
import { githubRowView } from "../loginRow.ts";
import { RunnerLogin } from "./RunnerLogin.tsx";

/**
 * gh's login above the workspace's add form: cloning from GitHub and making a new repository run `gh`, and a machine
 * with no stored token (a container on a PC) starts with gh logged out. Logged out → the login button (gh's own login,
 * relayed like a runner's); logged in → the account, nothing to press; no gh → says so, nothing to press. Read once when
 * the Settings screen mounts it (the folded card's content is mounted too) and again after a login.
 */
export function GithubLoginRow(props: { onError: (msg: string) => void }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const read = () => {
    api.githubStatus().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(read, []);
  if (!status) return null;
  const v = githubRowView(status);
  return (
    <div className="row runner-login">
      <span className="hint">{v.text}</span>
      {v.login && <RunnerLogin runner="gh" onDone={read} onError={props.onError} />}
    </div>
  );
}
