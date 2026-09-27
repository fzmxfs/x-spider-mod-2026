/**
 * 从 X 返回的推文对象里取出干净的推文文字。
 * 这个文件不依赖 Tauri / React，方便单独测试。
 */

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function extractPostText(item: any): string | undefined {
  const legacy = item?.legacy;
  // 超过 280 字的长推文，完整文字放在 note_tweet 里，legacy.full_text 是被截断的
  const note = item?.note_tweet?.note_tweet_results?.result;

  let text: string | undefined;
  let urls: any[] = [];
  let mediaUrls: string[] = [];

  if (typeof note?.text === 'string' && note.text) {
    text = note.text;
    urls = note?.entity_set?.urls ?? [];
  } else if (typeof legacy?.full_text === 'string') {
    // full_text 里的 & < > 是被转义过的，display_text_range 按转义前的字符数计算
    const unescaped = unescapeHtml(legacy.full_text);
    const range = legacy?.display_text_range;
    if (Array.isArray(range) && typeof range[1] === 'number') {
      // 只裁掉末尾（末尾是媒体/引用推文的短链），保留开头的 @用户
      text = Array.from(unescaped).slice(0, range[1]).join('');
    } else {
      text = unescaped;
    }
    urls = legacy?.entities?.urls ?? [];
    mediaUrls = (legacy?.entities?.media ?? [])
      .map((m: any) => m?.url)
      .filter(Boolean);
  }

  if (text === undefined) return undefined;

  for (const u of urls) {
    if (u?.url && u?.expanded_url) {
      text = text.split(u.url).join(u.expanded_url);
    }
  }
  for (const u of mediaUrls) {
    text = text.split(u).join('');
  }
  return text.trim();
}
