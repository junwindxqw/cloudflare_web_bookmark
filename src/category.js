/**
 * 书签自动分类：内置固定分类词典 + 域名/关键词匹配。
 *
 * 匹配规则（按顺序短路）：
 *  1. 命中 CATEGORIES[i].domains → 直接返回；精确命中（host === domain）
 *     优先于子域后缀命中（platform.openai.com 先于 openai.com 判定）
 *  2. 在 title（权重 2）/ description（权重 1）上做不区分大小写扫描，
 *     加权得分最高的类别胜出（得分为 0 视为无信号）
 *  3. 都没命中 → 退回 weakDomains（内容平台兜底：medium / 公众号 / B 站等
 *     域名本身不代表主题，只在没有更强信号时使用）
 *  4. 仍然没有 → 'other'
 *
 * 设计取舍：词典只在 Worker 内存中加载一次，无外部依赖。关键词刻意只保留高置信词，
 * 防止误判；冷门站点落入 'other'，可由用户在编辑框手动覆盖。
 *
 * AI 细分为 对话 / 创作 / 开发 三个子类：具体产品名进子类，'ai' 保留给综合资讯、
 * 公司官网与研究动态；通用词（大模型 / 深度学习 / transformer）归 'ai'。
 *
 * 前端 public/app.js 中维护了一份同源字典 CATEGORIES（仅 id/label/color），
 * 部署时需随 Worker 一起发版；任何 id/label/颜色变更需两端同步。
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
    ],
    weakDomains: [
      // 内容平台：域名不代表主题，仅在标题/描述无信号时兜底
      'medium.com', 'dev.to', 'hashnode.com', 'hackernoon.com',
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
    // 综合资讯 / 公司官网 / 研究动态；具体产品见 ai-chat / ai-image / ai-dev
    domains: [
      'openai.com', 'anthropic.com', 'deepmind.google', 'ai.meta.com',
      'jiqizhixin.com', 'qbitai.com', 'the-decoder.com', 'lmsys.org',
      'artificialanalysis.ai', 'epoch.ai',
    ],
    weakDomains: [],
    keywords: [
      'ai', '人工智能', 'agi', 'aigc', '大模型', '大语言模型', 'llm', 'gpt',
      'openai', 'anthropic', 'deepmind', '深度学习', 'deep learning',
      '机器学习', 'machine learning', '神经网络', 'neural network', 'transformer',
      '生成式', 'generative', '基础模型', 'foundation model', '多模态', 'multimodal',
    ],
  },
  {
    id: 'ai-chat',
    label: 'AI 对话',
    color: '#6366f1', // indigo
    domains: [
      'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
      'copilot.microsoft.com', 'poe.com', 'perplexity.ai',
      'deepseek.com', 'chat.deepseek.com', 'kimi.moonshot.cn', 'moonshot.cn',
      'doubao.com', 'yiyan.baidu.com', 'tongyi.aliyun.com', 'chat.qwen.ai',
      'qwen.ai', 'chatglm.cn', 'zhipuai.cn', 'grok.com', 'x.ai',
      'mistral.ai', 'chat.mistral.ai', 'character.ai', 'you.com', 'phind.com',
      'notebooklm.google.com', 'genspark.ai', 'coze.com', 'coze.cn',
      'monica.im', 'yuanbao.tencent.com',
    ],
    weakDomains: [],
    keywords: [
      'chatgpt', 'claude', 'gemini', 'deepseek', 'kimi', '豆包', '文心一言',
      '通义千问', '智谱清言', 'chatglm', 'grok', 'copilot', 'perplexity', '元宝',
      'chatbot', '聊天机器人', '对话式', 'ai 助手', 'ai助手', '智能助手',
      'prompt', '提示词', 'prompt engineering', 'ai 搜索', 'ai搜索',
    ],
  },
  {
    id: 'ai-image',
    label: 'AI 创作',
    color: '#d946ef', // fuchsia
    // AI 绘画 / 视频 / 音乐等生成式创作工具
    domains: [
      'midjourney.com', 'stability.ai', 'runwayml.com', 'pika.art',
      'suno.com', 'suno.ai', 'udio.com', 'leonardo.ai', 'civitai.com',
      'liblib.ai', 'tensor.art', 'seaart.ai', 'jimeng.jianying.com',
      'klingai.com', 'hailuoai.com', 'lumalabs.ai', 'ideogram.ai', 'bfl.ai',
      'getimg.ai', 'firefly.adobe.com', 'pixverse.ai',
    ],
    weakDomains: [],
    keywords: [
      'midjourney', 'stable diffusion', 'dall-e', 'dalle', 'sora', 'runway',
      'suno', 'udio', 'ai绘画', 'ai 绘画', '文生图', '图生图', 'text-to-image',
      '文生视频', '图生视频', 'text-to-video', 'ai视频', 'ai 视频',
      'ai音乐', 'ai 音乐', '语音合成', '语音克隆', 'tts', '数字人', 'ai换脸',
      'lora', '扩散模型', 'diffusion', '生图', '出图',
      '即梦', '可灵', '海螺', 'ideogram', 'firefly',
    ],
  },
  {
    id: 'ai-dev',
    label: 'AI 开发',
    color: '#14b8a6', // teal
    // 大模型平台 / 开发框架 / AI 编程工具
    domains: [
      'huggingface.co', 'hf.co', 'platform.openai.com', 'docs.anthropic.com',
      'console.anthropic.com', 'replicate.com', 'ollama.com', 'langchain.com',
      'llamaindex.ai', 'modelscope.cn', 'openrouter.ai', 'together.ai',
      'groq.com', 'fireworks.ai', 'siliconflow.cn', 'cohere.com',
      'cursor.com', 'windsurf.com', 'codeium.com', 'v0.dev', 'v0.app',
      'bolt.new', 'lovable.dev', 'replit.com', 'modelcontextprotocol.io',
      'kaggle.com', 'paperswithcode.com',
    ],
    weakDomains: [],
    keywords: [
      'huggingface', 'hugging face', 'langchain', 'llamaindex', 'ollama',
      'vllm', 'llama', 'pytorch', 'tensorflow', 'onnx', 'cuda',
      '微调', 'fine-tune', 'fine-tuning', 'fine tuning', 'quantization', '模型量化',
      'rag', '检索增强', 'embedding', '向量数据库', 'vector database',
      'agent', '智能体', 'agentic', 'mcp', 'model context protocol',
      'function calling', 'openai api', 'openai sdk',
      'inference', '模型推理', '显存',
      'ai编程', 'ai 编程', 'vibe coding', '代码生成', 'cursor', 'windsurf',
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
    weakDomains: [],
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
    weakDomains: [],
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
      'sina.com.cn', 'sohu.com', 'rfi.fr',
    ],
    weakDomains: [
      // 门户 / 公众号：内容主题各异，关键词优先
      'qq.com', '163.com', 'mp.weixin.qq.com', 'toutiao.com',
    ],
    keywords: [
      'news', '新闻', '时政', '国际', '财经新闻', '科技媒体', '媒体', 'press',
      'breaking', '头条', '报道', '热点',
    ],
  },
  {
    id: 'finance',
    label: '财经',
    color: '#eab308', // yellow
    domains: [
      'xueqiu.com', 'eastmoney.com', '10jqka.com.cn', 'wallstreetcn.com',
      'caixin.com', 'yicai.com', 'cls.cn', 'stcn.com', '21jingji.com',
      'futunn.com', 'moomoo.com', 'itiger.com', 'coingecko.com',
      'coinmarketcap.com', 'binance.com', 'okx.com', 'coinbase.com',
      'investing.com', 'finance.yahoo.com', 'marketwatch.com', 'danjuanfunds.com',
      'jisilu.cn',
    ],
    weakDomains: [],
    keywords: [
      '股票', '基金', '投资', '理财', '财经', '金融', '证券', '券商', '期货', '外汇',
      '加密货币', '数字货币', '比特币', 'bitcoin', 'btc', 'ethereum', '以太坊',
      '区块链', 'crypto', 'stock', 'stocks', 'trading', '行情', 'k线',
      '量化交易', '估值', '财报', '经济', 'economics', 'fintech',
      '美股', 'a股', '港股', '定投', '复利', '存款', '利率', '保险',
    ],
  },
  {
    id: 'life',
    label: '生活',
    color: '#f97316', // orange
    domains: [
      'meituan.com', 'dianping.com', 'ele.me', 'smzdm.com',
      'xiachufang.com', 'douguo.com', 'mafengwo.com', 'qyer.com', 'ctrip.com',
      'booking.com', 'airbnb.com', 'expedia.com', 'tripadvisor.com',
      'tianqi.com',
    ],
    weakDomains: [],
    keywords: [
      '生活', 'life', '美食', '菜谱', '餐厅', '外卖', '旅游', 'travel', '酒店',
      'hotel', '机票', '签证', '攻略', '亲子', '宠物', '健康', '养生', '健身',
      'fitness', '跑步', '瑜伽', '减肥',
    ],
  },
  {
    id: 'study',
    label: '学习',
    color: '#0ea5e9', // sky
    domains: [
      'coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org',
      'ocw.mit.edu', 'chinaunix.net', 'icourse163.org',
      'mooc.cn', 'xuetangx.com', 'runoob.com', 'w3school.com.cn', 'w3schools.com',
    ],
    weakDomains: [],
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
    weakDomains: [],
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
      'youku.com', 'iqiyi.com', 'mgtv.com',
      'tv.cctv.com', 'ted.com', 'dailymotion.com', 'tiktok.com',
    ],
    // B 站教程/番剧/生活内容混杂，标题关键词优先，仅无信号时兜底为视频
    weakDomains: ['bilibili.com', 'b23.tv', 'v.qq.com'],
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
      'telegram.org', 't.me', 'weibo.com', 'weibo.cn',
      'xiaohongshu.com', 'xhs.com', 'douban.com', 'quora.com', 'bsky.app',
    ],
    // 知乎问答与专栏文章主题差异大，交给关键词判断
    weakDomains: ['zhihu.com'],
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
      'wiki.com', 'baike.baidu.com', 'yuque.com',
      'weread.qq.com', 'kindle.amazon.com',
      'goodreads.com', 'archive.org', 'arxiv.org', 'cnki.net',
    ],
    weakDomains: ['jianshu.com', 'zhuanlan.zhihu.com'],
    keywords: [
      '阅读', 'reading', '书', 'book', '小说', 'novel', '文学', 'literature',
      'essay', '随笔', '专栏', '长文', 'wiki', '百科', '知识', 'knowledge',
      '论文', 'paper', 'pdf', '杂志', 'magazine',
    ],
  },
  {
    id: 'career',
    label: '求职',
    color: '#84cc16', // lime
    domains: [
      'zhipin.com', 'lagou.com', 'liepin.com', 'zhaopin.com', '51job.com',
      'indeed.com', 'glassdoor.com', 'nowcoder.com', 'shixiseng.com',
      'maimai.cn',
    ],
    weakDomains: [],
    keywords: [
      '求职', '招聘', '面试', '简历', 'offer', '跳槽', '内推', '职场',
      'career', 'job', 'jobs', 'hiring', 'interview',
      '实习', '校招', '社招', '秋招', '春招', '薪资', '工资', 'salary',
      '远程工作', 'remote work', '副业', 'freelance', '自由职业', '猎头',
    ],
  },
  {
    id: 'cloud',
    label: '云服务',
    color: '#06b6d4', // cyan
    domains: [
      'vercel.com', 'netlify.com', 'cloudflare.com', 'workers.dev', 'pages.dev',
      'aws.amazon.com', 'amazonaws.com', 'cloud.google.com', 'firebase.google.com',
      'azure.microsoft.com', 'portal.azure.com', 'aliyun.com',
      'cloud.tencent.com', 'huaweicloud.com', 'railway.app', 'render.com',
      'fly.io', 'heroku.com', 'digitalocean.com', 'linode.com', 'vultr.com',
      'hetzner.com', 'ovh.com', 'supabase.com', 'neon.tech', 'upstash.com',
      'planetscale.com', 'namecheap.com', 'godaddy.com', 'dnspod.cn',
    ],
    weakDomains: [],
    keywords: [
      '云服务', '云计算', '云主机', '云服务器', '部署', 'deploy', 'deployment',
      'hosting', '托管', '服务器', 'vps', 'cdn', '域名', 'dns', 'ssl', '证书',
      'serverless', '边缘计算', 'cloud', 'aws', 'azure', 'gcp',
      'vercel', 'netlify', 'cloudflare', 'self-hosted', '自托管', '自建',
      '内网穿透', 'nginx', 'caddy', '建站', '备案',
    ],
  },
  {
    id: 'other',
    label: '其他',
    color: '#64748b', // slate
    domains: [],
    weakDomains: [],
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
 *   - exact=true：完全相等 → 命中
 *   - exact=false：host 以 '.' + domain 结尾 → 命中（处理 blog.github.com 命中 github.com）
 */
function hostInList(host, domains, exact) {
  if (!host || !domains || !domains.length) return false;
  for (const d of domains) {
    if (!d) continue;
    if (exact ? host === d : host.endsWith('.' + d)) return true;
  }
  return false;
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
 * 匹配顺序：强域名（精确 > 后缀）→ 关键词加权评分（标题 ×2，描述 ×1）→ 弱域名兜底 → other。
 * @param {{ url: string, title?: string, description?: string }} bm
 */
export function classifyBookmark(bm) {
  const host = getHost(bm?.url);
  if (host) {
    for (const c of CATEGORIES) {
      if (hostInList(host, c.domains, true)) return c.id;
    }
    for (const c of CATEGORIES) {
      if (hostInList(host, c.domains, false)) return c.id;
    }
  }

  const title = (bm?.title || '').toLowerCase();
  const desc = (bm?.description || '').toLowerCase();
  if (title.trim() || desc.trim()) {
    let best = '';
    let bestScore = 0;
    for (const cm of CATEGORY_MATCHERS) {
      let score = 0;
      for (const re of cm.matchers) {
        // 标题是作者对页面的概括，权重高于描述；同一关键词以标题命中为准，不重复计分
        if (re.test(title)) score += 2;
        else if (re.test(desc)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = cm.id;
      }
    }
    if (best) return best;
  }

  if (host) {
    for (const c of CATEGORIES) {
      if (hostInList(host, c.weakDomains, true)) return c.id;
    }
    for (const c of CATEGORIES) {
      if (hostInList(host, c.weakDomains, false)) return c.id;
    }
  }
  return 'other';
}

export { CATEGORIES, CATEGORY_MAP };
