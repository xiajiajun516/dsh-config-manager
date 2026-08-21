/**
 * m-market：GitHub 仓库 URL 解析（纯函数，node 可测）。
 * docs/design/2026-08-21-market-star-filter-sort-design.md §3.1.2。
 *
 * 职责：从条目来源仓库 URL（`https://github.com/<owner>/<repo>[.git]`）解析出
 * `{ owner, repo }`，供 star 查询（getRepoStarsPublic）使用。
 *
 * 边界语义：
 * - 仅接受 `github.com` / `www.github.com` 域名（市场 repo 只要求 http(s)，可能是 GitLab 等 →
 *   返回 null，该条目 star 显示「—」）；
 * - 路径必须恰好 `<owner>/<repo>` 两段（多余段/子路径 → 非仓库根，返回 null）；
 * - 尾部 `.git` 后缀剥离；owner/repo 过宽松安全字符校验（字母数字开头，仅 . _ -）；
 * - 输入 URL 已由 validateRepoUrl 拒绝 userinfo（含凭据的 URL 走不到这里），解析过程零凭据。
 */
/** GitHub 仓库 URL 解析结果 */
export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** owner/repo 安全字符（与 SAFE_ITEM_ID_RE 同构：字母数字开头，仅 . _ -） */
const GITHUB_REPO_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 解析 GitHub 仓库 URL → { owner, repo }；非 GitHub 仓库（域名不符 / 路径不是两段 /
 * 段名非法）→ null。
 */
export function parseGitHubRepoUrl(url: string): GitHubRepoRef | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return null;
  const owner = segments[0]!;
  const repoRaw = segments[1]!;
  const repo = repoRaw.endsWith('.git') ? repoRaw.slice(0, -4) : repoRaw;
  if (!GITHUB_REPO_SEG_RE.test(owner) || !GITHUB_REPO_SEG_RE.test(repo)) return null;
  return { owner, repo };
}
