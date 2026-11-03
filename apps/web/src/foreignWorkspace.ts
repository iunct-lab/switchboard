/** The one line above a foreign repository's runner config (#2576). */
export function runnerConfigSummary(files: { path: string }[]): string {
  return files.length ? `設定のファイル ${files.length} 件: ${files.map((f) => f.path).join("、")}` : "ランナーの設定のファイルはありません";
}
