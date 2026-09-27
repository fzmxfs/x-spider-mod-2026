import { fs, invoke, path } from '@tauri-apps/api';
import { Response } from '../interfaces/Response';
import { TwitterUser } from '../interfaces/TwitterUser';
import { useSettingsStore } from '../stores/settings';

/**
 * 把博主的头像和主页横幅保存到 <用户目录>/metadata/avatar.xxx、banner.xxx。
 * 每个用户每次运行只尝试一次；失败不影响下载，也不会阻塞下载流程。
 *
 * 注意：这里不走 ipc/network 的 request()——它会给所有请求带上 X 的 Cookie，
 * 并在失败时把 Cookie 标记为“受限”。头像来自图片 CDN，不需要 Cookie，直接调用底层接口。
 */

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const KNOWN_EXTS = Object.values(EXT_BY_TYPE);
const FETCH_TIMEOUT_MS = 20000;

const attempted = new Set<string>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function hasImage(dir: string, name: string): Promise<boolean> {
  for (const ext of KNOWN_EXTS) {
    if (await fs.exists(await path.join(dir, `${name}.${ext}`))) return true;
  }
  return false;
}

async function fetchBinary(url: string): Promise<Response> {
  const { proxy } = useSettingsStore.getState();
  return await invoke<Response>('network_fetch', {
    method: 'GET',
    url,
    body: '',
    enableProxy: proxy.enable,
    proxyUrl: proxy.useSystem ? '' : proxy.url,
    headers: {},
    responseType: 'binary',
  });
}

async function fetchAndSave(dir: string, name: string, url: string) {
  if (await hasImage(dir, name)) return;
  const res = await withTimeout(fetchBinary(url), FETCH_TIMEOUT_MS);
  if (res.status >= 400 || !Array.isArray(res.body)) return;
  const type = (res.headers?.['content-type']?.[0] ?? '').split(';')[0].trim();
  const ext = EXT_BY_TYPE[type] ?? 'jpg';
  await fs.writeBinaryFile(
    await path.join(dir, `${name}.${ext}`),
    new Uint8Array(res.body as number[]),
  );
}

export function avatarUrl(user: TwitterUser): string | undefined {
  // 列表里给的是 48x48 的小图（_normal），换成 400x400
  return user.avatar?.replace(/_normal(\.[A-Za-z0-9]+)$/, '_400x400$1');
}

export function bannerUrl(user: TwitterUser): string | undefined {
  return user.banner ? `${user.banner}/1500x500` : undefined;
}

export async function saveUserImages(
  userDir: string,
  user: TwitterUser,
): Promise<string[]> {
  const errors: string[] = [];
  if (attempted.has(userDir)) return errors;
  attempted.add(userDir);

  try {
    const dir = await path.join(userDir, 'metadata');
    if (!(await fs.exists(dir))) {
      await fs.createDir(dir, { recursive: true });
    }
    const jobs: [string, string | undefined][] = [
      ['avatar', avatarUrl(user)],
      ['banner', bannerUrl(user)],
    ];
    for (const [name, url] of jobs) {
      if (!url) continue;
      try {
        await fetchAndSave(dir, name, url);
      } catch (e: any) {
        errors.push(`${name}: ${String(e?.message ?? e)}`);
      }
    }
  } catch (e: any) {
    errors.push(String(e?.message ?? e));
  }
  return errors;
}
