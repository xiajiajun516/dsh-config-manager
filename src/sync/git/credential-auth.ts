import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * issue #120：**不依赖 shell、不依赖可执行文件**的 git 认证兜底。
 *
 * 真机现场（Android，App 内嵌 `dsh web`）：git 二进制编译期把 GIT_SHELL_PATH 钉成
 * Termux 的 `/data/data/com.termux/files/usr/bin/sh`，该路径在 App 沙箱里不存在，而 git 执行
 * credential helper 的方式是把 helper 值拼成 `sh -c 'git <helper> ...'` —— **没有**「值里不含空格
 * 就不经 shell」这种写法（本机 git trace 实测：`run_command: 'git credential-store get'` 之后紧接
 * `start_command: '<git>/usr/bin/sh.exe' -c 'git credential-store get'`；裸 `credential.helper=store`
 * 也一样）。于是 helper 恒定失败：
 * `fatal: cannot exec 'git credential-store --file=... credential get': No such file or directory`
 * → 无 tty 时退化成 `fatal: could not read Password for 'https://oauth2@github.com': terminal prompts disabled`。
 *
 * 换成 `core.askpass` 躲不开：askpass 是一个**要被 exec 的脚本**，而 Android 10 起 targetSdk ≥ 29
 * 的应用不允许执行自己数据目录里的文件（SELinux untrusted_app_29+ 对 app_data_file 无 execute 权限）。
 *
 * 唯一不需要 exec 的通道是 git 自己从环境变量读配置（git ≥ 2.31 的 GIT_CONFIG_COUNT 协议）：
 * 把 `http.<scope>.extraheader = AUTHORIZATION: basic <base64(user:token)>` 挂进 git 子进程的 env，
 * 凭据既不进 argv、也不落临时文件、更不需要 sh —— token 只出现在 git 子进程的环境里
 * （Android 上 /proc/<pid>/environ 也只有同 uid 可读，比临时凭据文件更窄）。
 *
 * 用法：helper 路线先跑；失败且命中 isCredentialExecFailure() 时换这份 env 重试一次。
 */

/**
 * credential helper 无法被执行时的 git 原文特征：
 * - `cannot exec ...: No such file or directory`：shell 或 helper 二进制不存在；
 * - `could not read Password ...` / `terminal prompts disabled`：helper 没跑成，退化成读终端口令。
 */
const CREDENTIAL_EXEC_FAILURE_RE = /cannot exec|could not read Password|terminal prompts disabled/i;

/** 这条 git 失败是不是「credential helper 根本没能执行」（→ 值得改用 HTTP 认证头重试）。 */
export function isCredentialExecFailure(text: string): boolean {
  return CREDENTIAL_EXEC_FAILURE_RE.test(text);
}

/** 目录是否为空（读不到 = 非空：拿不准时绝不删东西，见 runGit 的 clone 重试）。 */
export async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/** 清空目录内容但保留目录本身（只用于「命令开跑前确认为空」的 clone 重试路径）。 */
export async function clearDirContents(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * 构造「用 HTTP 认证头代替 credential helper」的子进程环境变量。
 *
 * - 顺带把 `credential.helper` 置空：否则全局 `.gitconfig` 里配的 helper 仍会被调用并再次 cannot exec。
 * - 明文 http 常被远端重定向到 https，而 git 是按**每条请求的 URL** 匹配配置的 → 两个前缀都挂一份。
 * - 返回空对象 = 注入不了（repoUrl 不是合法 URL，或令牌为空），调用方保持原有失败路径。
 */
export function credentialHeaderEnv(repoUrl: string, username: string, token: string): Record<string, string> {
  if (token === '') return {};
  let origin: string;
  try {
    const u = new URL(repoUrl);
    // 只取 scheme://host[:port]/ 作作用域：路径无关（同主机全部仓库都用这份令牌）
    origin = `${u.protocol}//${u.host}/`;
  } catch {
    return {};
  }
  const scopes = [origin];
  if (origin.startsWith('http://')) scopes.push(`https://${origin.slice('http://'.length)}`);
  const authorization = `AUTHORIZATION: basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`;
  const pairs: Array<[string, string]> = [['credential.helper', '']];
  for (const scope of scopes) pairs.push([`http.${scope}.extraheader`, authorization]);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  });
  return env;
}
