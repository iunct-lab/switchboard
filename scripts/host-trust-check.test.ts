import { describe, expect, test } from "bun:test";
import { alreadyFiled } from "./file-request";
import { judge, parseResponse, requestFor } from "./host-trust-check";

describe("host-trust-check (#852)", () => {
  test("judge: the plan's 403 is no trigger, 200 is the trigger, anything else cannot tell (#852)", () => {
    expect(judge({ status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." }).code).toBe(0);
    expect(judge({ status: 200, message: "" }).code).toBe(1);
    for (const r of [{ status: 401, message: "Bad credentials" }, { status: 404, message: "Not Found" }, { status: 403, message: "Resource not accessible by personal access token" }, { status: 0, message: "" }]) {
      expect(judge(r).code).toBe(2);
    }
  });

  test("requestFor: the title is fixed so an open request is not filed twice (#852)", () => {
    const a = requestFor({ date: "2026-11-01", repo: "o/r" });
    const b = requestFor({ date: "2026-12-01", repo: "o/r" });
    expect(a.title).toBe(b.title);
    expect(alreadyFiled(a.title, [{ ref: "#9", title: b.title }])).toBe("#9");
  });

  test("requestFor: the 出典 says 誰の言葉: 定期の検査 (#1818)", () => {
    expect(requestFor({ date: "2026-11-01", repo: "o/r" }).body).toContain("## 出典\n- 誰の言葉: 定期の検査\n");
  });

  test("parseResponse reads the status line and the message of gh api -i", () => {
    const out = 'HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"message":"Upgrade to GitHub Pro or make this repository public","status":"403"}';
    expect(parseResponse(out)).toEqual({ status: 403, message: "Upgrade to GitHub Pro or make this repository public" });
    expect(parseResponse('HTTP/2.0 200 OK\r\n\r\n[]')).toEqual({ status: 200, message: "" });
    expect(parseResponse("HTTP/2.0 200 OK\r\n\r\n[", 1).status).toBe(0);
    expect(parseResponse(out, 1).status).toBe(403);
    expect(parseResponse("error connecting to api.github.com")).toEqual({ status: 0, message: "" });
  });
});
