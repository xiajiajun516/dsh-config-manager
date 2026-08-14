/**
 * sessions 分区 adapter（默认关，设计 §3.3/§15）：
 * 数据源 = ~/.dsh/sessions/<projectKey>/<sessionId>/…（zstd jsonl，含敏感信息）。
 * defaultIncluded=false：Quick Export 不包含，用户显式勾选才导出（v1 文件级复制）。
 * 研究报告 §4.9：DSH 无会话批量导出 API，逐会话文件复制是唯一通道。
 */
import { FileCollectionAdapter } from './file-collection.ts';

export class SessionsAdapter extends FileCollectionAdapter {
  readonly id = 'sessions' as const;
  readonly displayName = 'Sessions';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  readonly baseDir = 'sessions';
}
