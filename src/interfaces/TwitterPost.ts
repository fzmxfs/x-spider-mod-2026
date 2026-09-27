import { Dayjs } from 'dayjs';
import { TwitterMedia } from './TwitterMedia';
import { TwitterUser } from './TwitterUser';

export interface TwitterPost {
  id: string;
  user: TwitterUser;
  createdAt?: Dayjs;
  fullText?: string;
  /** 清理后的推文文字：长推文补全、去掉末尾媒体短链、短链展开 */
  text?: string;
  conversationId?: string;
  inReplyToPostId?: string;
  inReplyToScreenName?: string;
  tags?: string[];
  views?: number;
  lang?: string;
  retweeted?: boolean;
  retweetCount?: number;
  replyCount?: number;
  possiblySensitive?: boolean;
  favorited?: boolean;
  favoriteCount?: number;
  bookmarkCount?: number;
  bookmarked?: boolean;
  medias?: TwitterMedia[];
}
