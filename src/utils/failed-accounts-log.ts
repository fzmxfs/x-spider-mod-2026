import { fs, path } from '@tauri-apps/api';

/**
 * 批量下载“失败用户”落盘记录。
 * 固定存在应用自己的数据目录下（跟设置、批量列表用的是同一个目录，
 * 与下载路径无关——即使经常更换下载目录，这份记录也不受影响）。
 * 全程只有一份文件，不按批次或列表拆分，每次都在同一份上追加/更新。
 *
 * 格式：每行一个账户，account\t失败原因\t时间。
 * 同一账户重复失败时更新这一行（覆盖原因和时间），不会重复。
 * 只有“重新验证成功、任务已创建”这一件事会让某个账户从文件里移除；
 * 其它任何操作（包括从批量列表里手动删除失败账户）都不会动这份文件——
 * 这里只负责如实记录失败，怎么处理失败账户由用户自己决定。
 *
 * 所有操作失败都吞掉不抛出：这只是一份辅助记录，不能因为它出错而打断下载本身。
 */

const FILE_NAME = '下载失败用户.txt';

interface FailedEntry {
  account: string;
  category: string;
  reason: string;
  time: string;
}

/**
 * 根据错误信息粗略分类，写进文件第二列，方便一眼看出该不该重试：
 * - 账户不存在/不可用：账户名打错、已注销——重试没有意义
 * - 疑似账户受限：像是这个具体账户被封禁/保护/无权限查看——重试大概率还是不行，
 *   但不是 100% 确定，因为个别情况下也可能是权限判定有误
 * - Cookie 失效或受限：问题出在你的 Cookie/登录状态，不是这个账户本身——换一个
 *   Cookie 或等一等通常能解决，跟哪个博主无关
 * - 触发限额：临时性的，等一等再重试通常能成功
 * - 网络问题：连接失败、超时、证书校验失败等，多半是本地网络/代理问题，可重试
 * - 未知原因：没能识别的错误，保守起见按“可重试”处理
 *
 * 这只是根据错误文字做的粗略归类，不代表 100% 准确，仅供参考。
 */
function classifyReason(reason: string): string {
  if (/找不到该用户|HTTP 404/.test(reason)) return '账户不存在或不可用';
  if (/HTTP 403/.test(reason)) return '疑似账户受限（可能不必重试）';
  if (/HTTP 401/.test(reason))
    return 'Cookie 失效或受限（换Cookie/等一等再试）';
  if (/HTTP 429/.test(reason)) return '触发限额（可重试）';
  if (/HTTP 5\d\d/.test(reason)) return '服务器错误（可重试）';
  if (!reason || reason === '未知原因') return '未知原因（建议重试确认）';
  return '网络问题（可重试）';
}

function parseLine(line: string): FailedEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 4) {
    // 兼容旧版本（没有分类列）留下的文件：把旧行当成“原因”，现场补一列分类
    const [account, reason = '', time = ''] = parts;
    if (!account) return null;
    return { account, category: classifyReason(reason), reason, time };
  }
  const [account, category, reason, time] = parts;
  if (!account) return null;
  return { account, category, reason, time };
}

function formatLine(e: FailedEntry): string {
  return `${e.account}\t${e.category}\t${e.reason}\t${e.time}`;
}

async function resolveFilePath(): Promise<string> {
  const dir = await path.appDataDir();
  if (!(await fs.exists(dir))) {
    await fs.createDir(dir, { recursive: true });
  }
  return path.join(dir, FILE_NAME);
}

async function readEntries(
  filePath: string,
): Promise<Map<string, FailedEntry>> {
  const map = new Map<string, FailedEntry>();
  if (!(await fs.exists(filePath))) return map;
  const text = await fs.readTextFile(filePath);
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) map.set(entry.account.toLowerCase(), entry);
  }
  return map;
}

async function writeEntries(filePath: string, map: Map<string, FailedEntry>) {
  if (map.size === 0) {
    if (await fs.exists(filePath)) await fs.removeFile(filePath);
    return;
  }
  const header = '# 账户\t分类（是否值得重试仅供参考）\t原因\t时间';
  const lines = [...map.values()]
    .sort((a, b) => a.account.localeCompare(b.account))
    .map(formatLine);
  await fs.writeTextFile(filePath, `${header}\n${lines.join('\n')}\n`);
}

/** 追加或更新失败账户；同一账户再次失败会覆盖原因和时间，而不是重复一行 */
export async function appendFailedAccountsLog(
  items: { account: string; reason: string }[],
): Promise<void> {
  if (items.length === 0) return;
  try {
    const filePath = await resolveFilePath();
    const map = await readEntries(filePath);
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    for (const { account, reason } of items) {
      const finalReason = reason || '未知原因';
      map.set(account.toLowerCase(), {
        account,
        category: classifyReason(finalReason),
        reason: finalReason,
        time,
      });
    }
    await writeEntries(filePath, map);
  } catch {
    // 写入失败不影响下载流程本身
  }
}

/** 重新验证成功、任务已创建后，把对应账户从文档里移除 */
export async function removeFailedAccountsLog(
  accounts: string[],
): Promise<void> {
  if (accounts.length === 0) return;
  try {
    const filePath = await resolveFilePath();
    const map = await readEntries(filePath);
    let changed = false;
    for (const account of accounts) {
      if (map.delete(account.toLowerCase())) changed = true;
    }
    if (changed) await writeEntries(filePath, map);
  } catch {
    // 忽略
  }
}
