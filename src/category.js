/**
 * 书签自动分类：内置固定分类词典 + 域名/关键词匹配。
 *
 * 规则：
 *  1. 命中 CATEGORIES[i].domains（子域后缀或全等匹配）→ 直接返回
 *  2. 在 title + description 上做不区分大小写扫描，命中关键词最多的类别胜出
 *  3. 都没命中 → 'other'
 *
 * 设计取舍：词典只在 Worker 内存中加载一次，无外部依赖。关键词刻意只保留高置信词，
 * 防止误判；冷门站点落入 'other'，可由用户在编辑框手动覆盖。
 *
 * 前端 public/app.js 中维护了一份同源字典 CATEGORIES，部署时需随 Worker 一起发版。
 */

const CATEGORIES = [
  {
    id: 'tech',
    label: '技术',
    color: '#3b82f6', // blue
    domains: [
      'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com',
      'stackexchange.com', 'mozilla.org', 'developer.mozilla.org',
      'npmjs.com', 'pypi.org', 'crates.io', 'docker.com', 'kubernetes.io',
      'dev.to', 'hashnode.com', 'medium.com', 'hackernoon.com',
      'infoq.cn', 'juejin.cn', 'csdn.net', 'cnblogs.com', 'segmentfault.com',
    ],
    keywords: [
      'github', 'gitlab', '开源', '程序员', '代码', '开发', '编程', 'api', 'sdk',
      'framework', '库', '源码', 'commit', 'pull request', 'developer', 'dev',
      'javascript', 'typescript', 'python', 'rust', 'golang', 'java', 'kotlin',
      'react', 'vue', 'svelte', 'node', 'deno', 'linux', 'kernel', 'docker',
      'kubernetes', 'k8s', 'devops', 'ci/cd', '编译器', '数据库', 'sql', 'nosql',
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    color: '#a855f7', // purple
    domains: [
      'openai.com', 'chatgpt.com', 'chat.openai.com', 'anthropic.com',
      'claude.ai', 'huggingface.co', 'replicate.com', 'midjourney.com',
      'stability.ai', 'perplexity.ai', 'gemini.google.com',
    ],
    keywords: [
      'ai', 'gpt', 'chatgpt', 'claude', 'llm', '大模型', '大语言模型', 'llama',
      'gemini', '文心一言', '通义千问', '深度学习', 'deep learning', '神经网络',
      'machine learning', '机器学习', 'midjourney', 'stable diffusion',
      'prompt', '提示词', 'rag', 'embedding', 'transformer', '扩散模型',
      '人工智能', 'agi', 'agent', '智能体',
    ],
  },
  {
    id: 'design',
    label: '设计',
    color: '#ec4899', // pink
    domains: [
      'dribbble.com', 'behance.net', 'figma.com', 'sketch.com', 'framer.com',
      'invisionapp.com', 'uxdesign.cc', 'smashingmagazine.com',
      'awwwards.com', 'siteinspire.com', 'land-book.com', 'httpster.net',
      'zcool.com.cn', 'shejipi.com', 'uisdc.com',
    ],
    keywords: [
      '设计', 'design', 'ui', 'ux', 'figma', 'sketch', '原型', '交互', '视觉',
      '插画', 'illustration', '海报', '海报设计', '配色', '排版',
      '字体', 'typography', 'logo', '品牌', '动效', 'motion',
      'icon', '图标', 'icon design',
    ],
  },
  {
    id: 'tools',
    label: '工具',
    color: '#10b981', // emerald
    domains: [
      'regex101.com', 'json.cn', 'base64.us', 'crontab.guru', 'carbon.now.sh',
      'excalidraw.com', 'notion.so', 'obsidian.md', 'typora.io', 'draw.io',
      'app.diagrams.net', 'canva.com', 'remove.bg', 'tinypng.com', 'squoosh.app',
      'cloudconvert.com', 'convertio.co', 'pdf24.org', 'smallpdf.com',
      'pixlr.com', 'photopea.com', 'coolors.co',
    ],
    keywords: [
      'tool', '工具', '在线工具', 'utility', 'converter', '转换', '压缩', 'compress',
      'json', 'base64', 'url encode', '正则', 'regex', 'markdown', '编辑器', 'editor',
      '效率', 'productivity', 'todo', '待办', '笔记', 'notes',
    ],
  },
  {
    id: 'news',
    label: '新闻',
    color: '#f59e0b', // amber
    domains: [
      'news.ycombinator.com', 'hn.now.sh', 'lobste.rs', 'reddit.com',
      'bbc.com', 'bbc.co.uk', 'cnn.com', 'reuters.com', 'apnews.com',
      'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'bloomberg.com',
      '36kr.com', 'ithome.com', 'huxiu.com', 'sspai.com', 'geekpark.net',
      'qq.com', 'sina.com.cn', '163.com', 'sohu.com', 'rfi.fr',
    ],
    keywords: [
      'news', '新闻', '时政', '国际', '财经新闻', '科技媒体', '媒体', 'press',
      'breaking', '头条', '报道', '热点',
    ],
  },
  {
    id: 'life',
    label: '生活',
    color: '#f97316', // orange
    domains: [
      'meituan.com', 'dianping.com', 'ele.me', 'smzdm.com', 'what.zhihu.com',
      'xiachufang.com', 'douguo.com', 'mafengwo.com', 'qyer.com', 'ctrip.com',
      'booking.com', 'airbnb.com', 'expedia.com', 'tripadvisor.com',
      'dianping.com', 'tianqi.com',
    ],
    keywords: [
      '生活', 'life', '美食', '菜谱', '餐厅', '外卖', '旅游', 'travel', '酒店',
      'hotel', '机票', '签证', '攻略', '亲子', '宠物', '健康', '养生', '健身',
      'fitness', '跑步', '跑步机', '瑜伽', '减肥',
    ],
  },
  {
    id: 'study',
    label: '学习',
    color: '#0ea5e9', // sky
    domains: [
      'coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org',
      'ocw.mit.edu', 'chinaunix.net', 'bilibili.com', 'icourse163.org',
      'mooc.cn', 'xuetangx.com', 'runoob.com', 'w3school.com.cn', 'w3schools.com',
    ],
    keywords: [
      '教程', 'tutorial', '课程', 'course', '学习', 'study', 'learn',
      '文档', 'docs', 'documentation', 'guide', '指南', '入门', '教科书',
      'mooc', '公开课', '培训', '教学', 'lecture', '教材',
    ],
  },
  {
    id: 'shopping',
    label: '购物',
    color: '#ef4444', // red
    domains: [
      'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'suning.com',
      'amazon.com', 'amazon.cn', 'ebay.com', 'aliexpress.com', '1688.com',
      'shopify.com', 'etsy.com', 'rakuten.co.jp', 'coupang.com',
      'walmart.com', 'bestbuy.com', 'target.com',
    ],
    keywords: [
      '购物', 'shopping', '商城', '电商', '价格', '优惠', '折扣', 'discount',
      'coupon', '优惠券', '拼团', '秒杀', '旗舰店', '品牌官网',
      'shop', 'store', 'mall',
    ],
  },
  {
    id: 'video',
    label: '视频',
    color: '#dc2626', // rose
    domains: [
      'youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'vimeo.com',
      'bilibili.com', 'b23.tv', 'youku.com', 'iqiyi.com', 'qq.com', 'mgtv.com',
      'tv.cctv.com', 'ted.com', 'dailymotion.com', 'tiktok.com',
    ],
    keywords: [
      '视频', 'video', '直播', 'live', '短视频', 'shorts', 'reels', '剧集',
      'anime', '番剧', '动漫', '电影', 'movie', 'tv', '综艺', 'entertainment',
      '纪录片', 'documentary',
    ],
  },
  {
    id: 'social',
    label: '社交',
    color: '#22c55e', // green
    domains: [
      'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com',
      'threads.net', 'mastodon.social', 'discord.com', 'discord.gg',
      'telegram.org', 't.me', 'weibo.com', 'weibo.cn', 'zhihu.com',
      'xiaohongshu.com', 'xhs.com', 'douban.com', 'quora.com', 'bsky.app',
    ],
    keywords: [
      '社交', 'social', '微博', '朋友圈', '论坛', 'forum', '社区', 'community',
      'chat', '聊天', 'im', '群组', '小组', 'subreddit',
    ],
  },
  {
    id: 'reading',
    label: '阅读',
    color: '#8b5cf6', // violet
    domains: [
      'wikipedia.org', 'zh.wikipedia.org', 'en.wikipedia.org',
      'wiki.com', 'baike.baidu.com', 'yuque.com', 'jianshu.com',
      'zhuanlan.zhihu.com', 'weread.qq.com', 'kindle.amazon.com',
      'goodreads.com', 'archive.org', 'arxiv.org', 'cnki.net',
    ],
    keywords: [
      '阅读', 'reading', '书', 'book', '小说', 'novel', '文学', 'literature',
      'essay', '随笔', '专栏', '长文', 'wiki', '百科', '知识', 'knowledge',
      '论文', 'paper', 'pdf', '杂志', 'magazine',
    ],
  },
  {
    id: 'other',
    label: '其他',
    color: '#64748b', // slate
    domains: [],
    keywords: [],
  },
];

/** 按 id 索引的字典，方便前端按 id 取 label/color */
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/** 解析 URL 的 hostname（含子域），失败时返回空串 */
function getHost(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 检查 host 是否命中 domains 中某一项：
 *   - 完全相等 → 命中
 *   - host 以 '.' + domain 结尾 → 命中（处理 blog.github.com 命中 github.com）
 */
function matchDomain(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith('.' + domain);
}

/** 把关键词编译成可在小写文本上做"边界匹配"的安全正则（ASCII token 用 \b 包裹，CJK 直接子串包含） */
function buildMatcher(kw) {
  const lower = kw.toLowerCase();
  if (/^[\w.-]+$/.test(lower)) {
    // 纯 ASCII/数字/点号/连字符：用单词边界，避免 "ai" 命中 "main"、"api" 命中 "rapid"
    return new RegExp('\\b' + lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  }
  // 含中文或空格的多字词：直接子串匹配（CJK 没有词边界概念）
  return { test: (s) => s.includes(lower) };
}

const CATEGORY_MATCHERS = CATEGORIES.map((c) => ({
  id: c.id,
  matchers: c.keywords.filter(Boolean).map(buildMatcher),
}));

/**
 * 给书签分类。返回分类 id（如 'tech'）。
 * @param {{ url: string, title?: string, description?: string }} bm
 */
export function classifyBookmark(bm) {
  const host = getHost(bm?.url);
  if (host) {
    for (const c of CATEGORIES) {
      if (c.domains.some((d) => matchDomain(host, d))) return c.id;
    }
  }

  const text = `${bm?.title || ''} ${bm?.description || ''}`.toLowerCase();
  if (!text.trim()) return 'other';

  let best = 'other';
  let bestScore = 0;
  for (const cm of CATEGORY_MATCHERS) {
    if (cm.id === 'other') continue;
    let score = 0;
    for (const re of cm.matchers) {
      if (re.test(text)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cm.id;
    }
  }
  return best;
}

export { CATEGORIES, CATEGORY_MAP };
