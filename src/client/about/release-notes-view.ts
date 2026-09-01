/**
 * GitHub Releases 更新内容纯函数模型与 API 客户端（无 React 依赖，node 可直测）。
 *
 * 职责：
 * - 解析 GitHub 仓库 URL（如 https://github.com/xiajiajun516/dsh-config-manager）
 * - 构造 GitHub Releases API URL（分页支持）
 * - 解析 GitHub Release 数据（过滤 draft，提取 tag、title、body、publishedAt、url 等）
 * - 分页获取 releases 并判断 hasMore
 * - 轻量级安全 Markdown 分块解析器（纯文本结构化，零 dangerouslySetInnerHTML / 零 XSS 风险）
 */

export interface GitHubReleaseRaw {
  id?: number;
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
}

export interface FormattedRelease {
  id: number;
  tag: string;
  title: string;
  body: string;
  publishedAt: string;
  publishedDateStr: string;
  url: string;
  isPrerelease: boolean;
}

export interface FetchReleasesResult {
  releases: FormattedRelease[];
  hasMore: boolean;
  page: number;
}

/**
 * 解析 GitHub 仓库 URL，提取 owner 与 repo。
 * 例如 'https://github.com/xiajiajun516/dsh-config-manager' → { owner: 'xiajiajun516', repo: 'dsh-config-manager' }
 */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  if (typeof repoUrl !== 'string') return null;
  const trimmed = repoUrl.trim().replace(/\/+$/, '');
  const match = trimmed.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!match || !match[1] || !match[2]) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
  };
}

/**
 * 构造 GitHub Releases API URL。
 */
export function buildReleasesApiUrl(repoUrl: string, page = 1, perPage = 5): string {
  const parsed = parseGitHubRepo(repoUrl);
  const safePage = Math.max(1, Math.floor(page));
  const safePerPage = Math.max(1, Math.min(100, Math.floor(perPage)));
  if (!parsed) {
    return `https://api.github.com/repos/xiajiajun516/dsh-config-manager/releases?page=${safePage}&per_page=${safePerPage}`;
  }
  return `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases?page=${safePage}&per_page=${safePerPage}`;
}

/**
 * 由仓库 URL 派生 Releases 页面 URL。
 */
export function deriveReleasesUrl(repoUrl: string): string {
  const base = repoUrl.trim().replace(/\/+$/, '');
  return `${base}/releases`;
}

/**
 * 格式化 ISO 日期为可读字符串（YYYY-MM-DD）。
 */
export function formatReleaseDate(isoDate: string | null | undefined): string {
  if (!isoDate || typeof isoDate !== 'string') return '';
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return isoDate;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return isoDate;
  }
}

/**
 * 解析单个 GitHub Release 原始对象为规范化 FormattedRelease。
 * draft 统一过滤（返回 null）。
 */
export function parseReleaseItem(raw: unknown): FormattedRelease | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as GitHubReleaseRaw;

  // 过滤草稿
  if (item.draft === true) return null;

  const tag = typeof item.tag_name === 'string' && item.tag_name.trim() !== ''
    ? item.tag_name.trim()
    : '';
  if (!tag) return null;

  const id = typeof item.id === 'number' ? item.id : Math.floor(Math.random() * 1000000);
  const title = typeof item.name === 'string' && item.name.trim() !== ''
    ? item.name.trim()
    : tag;
  const body = typeof item.body === 'string' ? item.body : '';
  const publishedAt = item.published_at || item.created_at || '';
  const publishedDateStr = formatReleaseDate(publishedAt);
  const url = typeof item.html_url === 'string' && item.html_url !== ''
    ? item.html_url
    : `https://github.com/xiajiajun516/dsh-config-manager/releases/tag/${encodeURIComponent(tag)}`;
  const isPrerelease = item.prerelease === true;

  return {
    id,
    tag,
    title,
    body,
    publishedAt,
    publishedDateStr,
    url,
    isPrerelease,
  };
}

/**
 * 解析 API 返回的 Releases 数组。
 */
export function parseReleasesResponse(data: unknown): FormattedRelease[] {
  if (!Array.isArray(data)) return [];
  const list: FormattedRelease[] = [];
  for (const item of data) {
    const parsed = parseReleaseItem(item);
    if (parsed !== null) {
      list.push(parsed);
    }
  }
  return list;
}

/**
 * 分页获取 GitHub Releases。
 */
export async function fetchReleases(
  repoUrl: string,
  page = 1,
  perPage = 5,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<FetchReleasesResult> {
  const url = buildReleasesApiUrl(repoUrl, page, perPage);
  const res = await fetcher(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub API 速率限制（Rate limit exceeded），请稍后再试或直接在 GitHub 上查看。');
    }
    if (res.status === 404) {
      return { releases: [], hasMore: false, page };
    }
    throw new Error(`GitHub API 请求失败 (${res.status} ${res.statusText})`);
  }

  const json: unknown = await res.json();
  const releases = parseReleasesResponse(json);

  // 如果返回的有效条目数达到 perPage，则推测还有下一页
  const hasMore = Array.isArray(json) && json.length >= perPage;

  return {
    releases,
    hasMore,
    page,
  };
}

/* ---------------- 轻量级 Markdown 块解析 ---------------- */

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list-item'; text: string; ordered?: boolean; index?: number }
  | { type: 'quote'; text: string }
  | { type: 'code-block'; code: string; lang?: string }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

/**
 * 将 GitHub Release body 纯文本转换为结构化 Markdown 块列表，
 * 供 React 纯组件进行安全渲染，不依赖任何第三方 Markdown 库与 innerHTML。
 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];

  let inCodeBlock = false;
  let codeLang = '';
  let codeBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // 识别代码块 ```
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        blocks.push({
          type: 'code-block',
          code: codeBuffer.join('\n'),
          lang: codeLang || undefined,
        });
        codeBuffer = [];
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    // 空行跳过
    if (trimmed === '') {
      continue;
    }

    // 分割线 --- 或 ***
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      continue;
    }

    // 标题 # ## ###
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    // 引用 >
    if (trimmed.startsWith('>')) {
      blocks.push({
        type: 'quote',
        text: trimmed.replace(/^>\s*/, '').trim(),
      });
      continue;
    }

    // 无序列表 - * +
    const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unorderedMatch && unorderedMatch[1]) {
      blocks.push({
        type: 'list-item',
        text: unorderedMatch[1].trim(),
        ordered: false,
      });
      continue;
    }

    // 有序列表 1. 2.
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch && orderedMatch[1] && orderedMatch[2]) {
      blocks.push({
        type: 'list-item',
        text: orderedMatch[2].trim(),
        ordered: true,
        index: parseInt(orderedMatch[1], 10),
      });
      continue;
    }

    // 普通段落
    blocks.push({
      type: 'paragraph',
      text: trimmed,
    });
  }

  // 收尾未闭合的代码块
  if (inCodeBlock && codeBuffer.length > 0) {
    blocks.push({
      type: 'code-block',
      code: codeBuffer.join('\n'),
      lang: codeLang || undefined,
    });
  }

  return blocks;
}
