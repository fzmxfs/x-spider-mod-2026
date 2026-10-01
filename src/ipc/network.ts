import { invoke } from '@tauri-apps/api';
import { Response } from '../interfaces/Response';
import { RequestOptions } from '../interfaces/RequestOptions';
import * as R from 'ramda';
import { useSettingsStore } from '../stores/settings';
import { useAppStateStore } from '../stores/app-state';
import { delay } from '../utils';
import { cookieManager } from '../utils/cookie-manager';
import { parseCookie } from '../utils/cookie';

/**
 * 重试策略分两类（为了“发送的全部都必须下载，网络问题绝不跳过用户”）：
 * - 网络类错误（连接失败/超时/代理/DNS/重置、HTTP 429、HTTP 5xx，
 *   以及 Cookie 池冷却期间“无凭据请求”收到的 401）：无限重试，
 *   间隔逐步加大、封顶 60s，直到成功为止。429 时 Cookie 池即使全部进入
 *   冷却（10 分钟自动恢复）也继续等，不放弃。
 * - 账户/凭据类错误（带有效 Cookie 仍返回的 HTTP 401/403、queryId 失效
 *   400/404 等）：重试无意义，维持有限的 3 次重试（含 Cookie 轮换），
 *   用尽后抛错，由上层记入失败清单。
 */
const NETWORK_RETRY_DELAYS = [5000, 10000, 20000, 30000, 60000];
const ACCOUNT_RETRY_DELAYS = [2000, 4000, 8000];

function networkRetryDelay(attempt: number): number {
  if (attempt < NETWORK_RETRY_DELAYS.length) return NETWORK_RETRY_DELAYS[attempt];
  return NETWORK_RETRY_DELAYS[NETWORK_RETRY_DELAYS.length - 1];
}

let log: ICategoriedLogger;
/** 最近一次把 Cookie 标记为受限的状态码：用于区分“429 限流冷却”（应等待）与“401 死 Cookie”（应放弃） */
let lastLimitedStatus: number | null = null;

/** 将 app-state 中的 Cookie 池同步到 CookieManager（含单条兼容） */
function syncCookiesFromStore() {
  const { cookieStrings, cookieString } = useAppStateStore.getState();
  const rotationEnabled =
    useSettingsStore.getState().app.enableCookieRotation !== false;
  const allPool =
    Array.isArray(cookieStrings) && cookieStrings.length > 0
      ? cookieStrings
      : cookieString
        ? [cookieString]
        : [];
  // 关闭自动轮换时，仅使用当前激活 Cookie 构成单账号池
  const cookies = rotationEnabled
    ? allPool
    : cookieString
      ? [cookieString]
      : [];
  cookieManager.setCookies(cookies);
}

export async function request(options: RequestOptions) {
  if (!log) {
    log = window.log.category('NET');
  }
  const url = new URL(options.url);

  if (options.query) {
    Object.entries(options.query).forEach(([k, v]) => {
      url.searchParams.append(k, v);
    });
  }

  syncCookiesFromStore();

  const settings = useSettingsStore.getState();
  // 显式固定使用的 Cookie（用于验证某条 Cookie），不参与自动轮换
  const fixedCookie = options.cookie || undefined;
  const authCookie = options.cookie != null;

  // 依据当前选中的 Cookie 组装请求头（Cookie + X-Csrf-Token）
  const buildHeaders = (cookie?: string): Record<string, string> => {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (cookie) {
      headers.Cookie = cookie;
      const ct0 = parseCookie(cookie).ct0;
      if (ct0) {
        headers['X-Csrf-Token'] = ct0;
      }
    } else {
      delete headers.Cookie;
      delete headers['X-Csrf-Token'];
    }
    return headers;
  };

  const method = R.defaultTo('GET', options.method);
  const body = R.defaultTo('', options.body);
  const proxyUrl = settings.proxy.useSystem ? '' : settings.proxy.url;
  let lastErr: any;
  let attempt = 0;
  // 账户/凭据类错误：初始 1 次 + 重试 3 次后放弃；网络类错误不设上限
  const maxAccountAttempts = 1 + ACCOUNT_RETRY_DELAYS.length;

  while (true) {
    // 选择本轮 Cookie：固定，或从池中轮换取号
    const cookie = fixedCookie || cookieManager.nextCookie() || undefined;
    let networkClass = false;
    let giveUp = false;

    try {
      const res = await requestInternal(
        method,
        url.href,
        body,
        settings.proxy.enable,
        proxyUrl,
        buildHeaders(cookie),
        options.responseType,
      );

      // 请求成功（2xx）
      if (res.status < 400) {
        if (cookie && !authCookie) cookieManager.markSuccess(cookie);
        lastLimitedStatus = null;
        return res;
      }

      const limited = !authCookie && (res.status === 401 || res.status === 429);
      lastErr = new Error(`HTTP ${res.status}`);

      if (limited && cookie) {
        // 标记当前账号受限，下一次取号自动轮换到下一条（冷却 10 分钟后自动恢复可用）
        cookieManager.markLimited(cookie);
        lastLimitedStatus = res.status;
      }

      // 命中跳过重试的状态码（如 queryId 已失效）→ 立即抛错交给上层换候选
      if (options.skipRetryStatuses?.includes(res.status)) {
        giveUp = true;
      } else {
        // 网络类：429（触发限额，等一会自动恢复）、5xx（服务器错误）；
        // 另外“本轮没带上 Cookie”（池子全在冷却中）时收到的 401：若是 429 限流导致的
        // 冷却，属假 401，等冷却结束 Cookie 复活后会恢复 → 也按网络类无限重试；
        // 若是 401 死 Cookie 导致（最近受限并非 429），则按凭据类处理，避免活锁。
        networkClass =
          res.status === 429 ||
          res.status >= 500 ||
          (res.status === 401 &&
            cookie == null &&
            cookieManager.count > 0 &&
            lastLimitedStatus === 429);
        // 401/403 等凭据类（本轮确实带上了 Cookie 仍失败）：有限重试已用尽 → 抛错交上层记入失败清单
        if (!networkClass && attempt >= maxAccountAttempts - 1) giveUp = true;
      }
    } catch (err: any) {
      // 请求抛异常（reqwest：连接被重置、超时、代理、DNS 等）→ 网络类，无限重试直到网络恢复
      lastErr = err;
      networkClass = true;
    }

    // 账户/凭据类已到终点：抛错（不被上面的 catch 捕获）
    if (giveUp) throw lastErr;

    const wait = networkClass
      ? networkRetryDelay(attempt)
      : ACCOUNT_RETRY_DELAYS[attempt];
    if (networkClass) {
      log.warn(
        `网络异常，自动重试第 ${attempt + 1} 次（${wait / 1000}s 后再试），直到网络恢复不跳过`,
        lastErr,
      );
    } else {
      log.warn(
        `Request failed (凭据/账户类), attempt=${attempt + 1}/${maxAccountAttempts}, retry in ${wait}ms`,
        lastErr,
      );
    }
    await delay(wait);
    attempt++;
  }
}

let reqIdGlobal = 0;

async function requestInternal(
  method: string,
  url: string,
  body: string,
  enableProxy: boolean,
  proxyUrl: string,
  headers: Record<string, string>,
  responseType: string,
): Promise<Response> {
  const startTs = Date.now();
  const reqId = reqIdGlobal++;
  log.info(`REQ_${reqId}`, method, url, {
    body,
    enableProxy,
    proxyUrl,
    headers: {
      ...headers,
      Cookie: headers.Cookie ? '******' : undefined,
    },
    responseType,
  });

  const res = await invoke<Response>('network_fetch', {
    method,
    url,
    body,
    enableProxy,
    proxyUrl,
    headers,
    responseType,
  });

  const endTs = Date.now() - startTs;
  log.info(`RES_${reqId}(+${endTs}ms)`, res.status, url, res);

  return res;
}

export async function getSystemProxy(): Promise<string> {
  const map: Record<string, string> = await invoke(
    'network_get_system_proxy_url',
  );
  const value = map.https || map.http;
  if (value) {
    return `http://${value}`;
  }
  return '';
}
