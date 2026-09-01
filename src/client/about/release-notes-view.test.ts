/**
 * Release Notes 纯函数与 API 客户端测试（Node 直接运行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReleasesApiUrl,
  deriveReleasesUrl,
  fetchReleases,
  formatReleaseDate,
  parseGitHubRepo,
  parseMarkdownBlocks,
  parseReleaseItem,
  parseReleasesResponse,
} from './release-notes-view.ts';

test('parseGitHubRepo: 正确解析 GitHub 仓库 URL', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/xiajiajun516/dsh-config-manager'), {
    owner: 'xiajiajun516',
    repo: 'dsh-config-manager',
  });
  assert.deepEqual(parseGitHubRepo('https://github.com/xiajiajun516/dsh-config-manager.git'), {
    owner: 'xiajiajun516',
    repo: 'dsh-config-manager',
  });
  assert.deepEqual(parseGitHubRepo('http://github.com/foo/bar/'), {
    owner: 'foo',
    repo: 'bar',
  });
  assert.equal(parseGitHubRepo('invalid-url'), null);
  assert.equal(parseGitHubRepo(''), null);
});

test('buildReleasesApiUrl: 构造分页 API URL', () => {
  assert.equal(
    buildReleasesApiUrl('https://github.com/xiajiajun516/dsh-config-manager', 1, 5),
    'https://api.github.com/repos/xiajiajun516/dsh-config-manager/releases?page=1&per_page=5',
  );
  assert.equal(
    buildReleasesApiUrl('https://github.com/xiajiajun516/dsh-config-manager', 3, 10),
    'https://api.github.com/repos/xiajiajun516/dsh-config-manager/releases?page=3&per_page=10',
  );
});

test('deriveReleasesUrl: 派生 Releases 网页地址', () => {
  assert.equal(
    deriveReleasesUrl('https://github.com/xiajiajun516/dsh-config-manager/'),
    'https://github.com/xiajiajun516/dsh-config-manager/releases',
  );
});

test('formatReleaseDate: 格式化发布日期', () => {
  assert.equal(formatReleaseDate('2026-08-28T14:09:00Z'), '2026-08-28');
  assert.equal(formatReleaseDate(null), '');
  assert.equal(formatReleaseDate(''), '');
});

test('parseReleaseItem: 提取关键信息并过滤草稿', () => {
  const item = {
    id: 101,
    tag_name: 'v0.1.54',
    name: 'v0.1.54 - Web Video Presentation',
    body: '## 更新内容\n- 支持视频演示\n- 修复 Bug',
    published_at: '2026-08-28T12:00:00Z',
    html_url: 'https://github.com/xiajiajun516/dsh-config-manager/releases/tag/v0.1.54',
    prerelease: false,
    draft: false,
  };
  const parsed = parseReleaseItem(item);
  assert.ok(parsed !== null);
  assert.equal(parsed.id, 101);
  assert.equal(parsed.tag, 'v0.1.54');
  assert.equal(parsed.title, 'v0.1.54 - Web Video Presentation');
  assert.equal(parsed.body, '## 更新内容\n- 支持视频演示\n- 修复 Bug');
  assert.equal(parsed.publishedDateStr, '2026-08-28');
  assert.equal(parsed.isPrerelease, false);

  // 草稿过滤
  assert.equal(parseReleaseItem({ ...item, draft: true }), null);
  // 无 tag 过滤
  assert.equal(parseReleaseItem({ ...item, tag_name: '' }), null);
  // 非对象输入过滤
  assert.equal(parseReleaseItem(null), null);
});

test('parseReleasesResponse: 批量解析并过滤无效条目', () => {
  const data = [
    { id: 1, tag_name: 'v1.0.0', name: 'v1.0.0', draft: false },
    { id: 2, tag_name: 'v1.0.1-draft', draft: true },
    { id: 3, tag_name: 'v0.9.0', name: 'v0.9.0', draft: false },
  ];
  const list = parseReleasesResponse(data);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.tag, 'v1.0.0');
  assert.equal(list[1]!.tag, 'v0.9.0');
  assert.deepEqual(parseReleasesResponse(null), []);
});

test('fetchReleases: 正常分页拉取与 hasMore 判定', async () => {
  const mockFetcher = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => [
      { id: 1, tag_name: 'v1.0.0' },
      { id: 2, tag_name: 'v0.9.0' },
    ],
  }) as unknown as Response;

  // perPage=2 返回 2 条 → hasMore=true
  const res1 = await fetchReleases('https://github.com/xiajiajun516/dsh-config-manager', 1, 2, mockFetcher as typeof fetch);
  assert.equal(res1.releases.length, 2);
  assert.equal(res1.hasMore, true);
  assert.equal(res1.page, 1);

  // perPage=5 返回 2 条 → hasMore=false
  const res2 = await fetchReleases('https://github.com/xiajiajun516/dsh-config-manager', 1, 5, mockFetcher as typeof fetch);
  assert.equal(res2.releases.length, 2);
  assert.equal(res2.hasMore, false);
});

test('fetchReleases: 错误处理（403 限流 / 404 / 500）', async () => {
  const mock403 = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
  }) as unknown as Response;
  await assert.rejects(
    () => fetchReleases('https://github.com/foo/bar', 1, 5, mock403 as typeof fetch),
    /速率限制|Rate limit/,
  );

  const mock404 = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  }) as unknown as Response;
  const res404 = await fetchReleases('https://github.com/foo/bar', 1, 5, mock404 as typeof fetch);
  assert.deepEqual(res404.releases, []);
  assert.equal(res404.hasMore, false);
});

test('parseMarkdownBlocks: 解析标题、列表、引用、代码块与段落', () => {
  const md = [
    '# Release 1.0',
    '> 核心架构重构',
    '',
    '### 新增特性',
    '- 支持坚果云自定义目录',
    '* 支持版本更新查看弹窗',
    '1. 第一项',
    '2. 第二项',
    '---',
    '```ts',
    'const a = 1;',
    '```',
    '欢迎体验！',
  ].join('\n');

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0]!.type, 'heading');
  assert.equal((blocks[0] as { level: number }).level, 1);
  assert.equal(blocks[1]!.type, 'quote');
  assert.equal(blocks[2]!.type, 'heading');
  assert.equal((blocks[2] as { level: number }).level, 3);
  assert.equal(blocks[3]!.type, 'list-item');
  assert.equal(blocks[4]!.type, 'list-item');
  assert.equal(blocks[5]!.type, 'list-item');
  assert.equal((blocks[5] as { ordered?: boolean }).ordered, true);
  assert.equal(blocks[7]!.type, 'hr');
  assert.equal(blocks[8]!.type, 'code-block');
  assert.equal((blocks[8] as { code: string }).code, 'const a = 1;');
  assert.equal(blocks[9]!.type, 'paragraph');
});
