import { fs, path } from '@tauri-apps/api';
import { TwitterPost } from '../interfaces/TwitterPost';

/**
 * 每条推文保存成 <用户目录>/metadata/<推文ID>.json，
 * 字段名沿用旧工具(gallery-dl)的格式，这样旧的 HTML 生成脚本也能读。
 */
export function buildPostMetadata(post: TwitterPost) {
  const author = {
    id: post.user.id,
    name: post.user.screenName,
    nick: post.user.name,
    profile_image: post.user.avatar,
    profile_banner: post.user.banner,
    description: post.user.description ?? '',
    followers_count: post.user.followersCount ?? 0,
    friends_count: post.user.friendsCount ?? 0,
  };
  return {
    tweet_id: post.id,
    conversation_id: post.conversationId || post.id,
    reply_id: post.inReplyToPostId || '0',
    reply_to: post.inReplyToScreenName || '',
    // 与旧工具一致，使用 UTC 时间
    date: post.createdAt
      ? post.createdAt.toDate().toISOString().replace('T', ' ').slice(0, 19)
      : '',
    author,
    user: author,
    lang: post.lang,
    sensitive: post.possiblySensitive ?? false,
    favorite_count: post.favoriteCount ?? 0,
    retweet_count: post.retweetCount ?? 0,
    reply_count: post.replyCount ?? 0,
    bookmark_count: post.bookmarkCount ?? 0,
    view_count: post.views ?? 0,
    content: post.text ?? post.fullText ?? '',
    hashtags: post.tags ?? [],
    count: post.medias?.length ?? 0,
    category: 'twitter',
    subcategory: 'media',
  };
}

/**
 * 保存一批推文的文字信息。失败不会抛出（不能因为写文字失败而影响图片下载），
 * 返回失败的条数和第一个错误信息。
 */
export async function savePostMetadata(
  userDir: string,
  posts: TwitterPost[],
): Promise<{ saved: number; failed: number; firstError?: string }> {
  const result = {
    saved: 0,
    failed: 0,
    firstError: undefined as string | undefined,
  };
  if (posts.length === 0) return result;

  try {
    const dir = await path.join(userDir, 'metadata');
    if (!(await fs.exists(dir))) {
      await fs.createDir(dir, { recursive: true });
    }
    for (const post of posts) {
      try {
        const file = await path.join(dir, `${post.id}.json`);
        await fs.writeTextFile(
          file,
          JSON.stringify(buildPostMetadata(post), null, 2),
        );
        result.saved++;
      } catch (e: any) {
        result.failed++;
        result.firstError ??= String(e?.message ?? e);
      }
    }
  } catch (e: any) {
    result.failed = posts.length;
    result.firstError = String(e?.message ?? e);
  }
  return result;
}
