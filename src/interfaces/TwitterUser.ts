import { Dayjs } from 'dayjs';

export interface TwitterUser {
  screenName: string;
  avatar: string;
  name: string;
  id: string;
  mediaCount?: number;
  registerTime: Dayjs;
  /** 个人主页横幅图地址（不含尺寸后缀） */
  banner?: string;
  description?: string;
  followersCount?: number;
  friendsCount?: number;
  /** 是否受保护（私密）账户 */
  protected?: boolean;
}
