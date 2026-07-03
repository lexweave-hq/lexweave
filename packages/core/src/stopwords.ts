/**
 * Function-word filtering for the immersion engine.
 *
 * The deterministic miner is a character n-gram scanner with no word
 * segmentation, so it surfaces a lot of grammatical glue ("这是", "什么的",
 * "一", "自己"). Replacing those teaches nothing and makes the page noisy.
 * This list catches the obvious high-frequency function words cheaply; the
 * LLM's `isContentWord` flag is the backstop for fragments this misses.
 *
 * Keep this list to UNAMBIGUOUS function words (particles, pronouns, copulas,
 * conjunctions, common adverbs, measure words). Borderline content words
 * (现在 / 未来 / 时间 …) are intentionally left out — the LLM decides those.
 */

// Single-character grammatical glue. Used both for exact matches and for the
// "every character is glue" heuristic below.
const FUNCTION_CHARS = new Set([
  // structural particles & modal particles
  '的',
  '了',
  '着',
  '过',
  '地',
  '得',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '哦',
  '喔',
  '嘛',
  '哈',
  '嗯',
  '呵',
  '哎',
  '唉',
  '哇',
  '咦',
  '嘿',
  // copula / negation / common auxiliaries
  '是',
  '不',
  '没',
  '别',
  '在',
  '有',
  // pronouns
  '我',
  '你',
  '您',
  '他',
  '她',
  '它',
  '咱',
  // demonstratives / interrogatives
  '这',
  '那',
  '哪',
  '谁',
  '啥',
  // conjunctions / prepositions
  '和',
  '与',
  '跟',
  '及',
  '或',
  '但',
  '而',
  '把',
  '被',
  '让',
  '给',
  '对',
  '向',
  '往',
  '从',
  '到',
  '为',
  '于',
  '以',
  '并',
  '且',
  // high-frequency adverbs
  '就',
  '都',
  '也',
  '还',
  '又',
  '再',
  '很',
  '太',
  '最',
  '更',
  '只',
  '才',
  '却',
  '便',
  '即',
])

// Multi-character function words and common glue collocations.
const STOPWORDS = new Set([
  // pronouns / demonstratives
  '我们',
  '你们',
  '他们',
  '她们',
  '它们',
  '咱们',
  '自己',
  '大家',
  '别人',
  '人家',
  '这个',
  '那个',
  '哪个',
  '这些',
  '那些',
  '哪些',
  '这样',
  '那样',
  '怎样',
  '这么',
  '那么',
  '怎么',
  '什么',
  '为什么',
  '这里',
  '那里',
  '哪里',
  '这儿',
  '那儿',
  '哪儿',
  '这是',
  '那是',
  '就是',
  '还是',
  '只是',
  '但是',
  '可是',
  '于是',
  '要是',
  '不是',
  '不过',
  '不要',
  '不会',
  '不能',
  '不用',
  '没有',
  '什么的',
  '多少',
  '多么',
  // conjunctions
  '而且',
  '并且',
  '或者',
  '如果',
  '虽然',
  '即使',
  '因为',
  '所以',
  '因此',
  '然而',
  '然后',
  '接着',
  '于是',
  '既然',
  '尽管',
  '无论',
  '不管',
  '只要',
  '只有',
  '除非',
  '以及',
  '至于',
  '况且',
  '反而',
  '否则',
  '以便',
  '以免',
  // adverbs / fillers
  '已经',
  '曾经',
  '正在',
  '刚才',
  '马上',
  '立刻',
  '终于',
  '忽然',
  '突然',
  '渐渐',
  '似乎',
  '好像',
  '仿佛',
  '大概',
  '也许',
  '可能',
  '当然',
  '其实',
  '反正',
  '究竟',
  '到底',
  '难道',
  '居然',
  '竟然',
  '简直',
  '几乎',
  '差不多',
  '非常',
  '十分',
  '比较',
  '有点',
  '有些',
  '一点',
  '一些',
  '一下',
  '一直',
  '一定',
  '一旦',
  '一般',
  '一样',
  '一切',
  '稍微',
  '十足',
  // time / position glue
  '时候',
  '的时候',
  '这时',
  '那时',
  '此时',
  '后来',
  '以后',
  '以前',
  '之后',
  '之前',
  '之类',
  '之类的',
  '等等',
  // measure / quantity glue
  '一个',
  '一种',
  '一些',
  '这种',
  '那种',
  '各种',
  // n-gram artifacts around 是/有/一
  '是一',
  '有一',
  '这一',
  '那一',
  '一位',
  '一句',
])

// Small English set for the rare Latin candidates the miner picks up.
const EN_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'so',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'this',
  'that',
  'these',
  'those',
  'he',
  'she',
  'they',
  'we',
  'you',
  'i',
  'as',
  'if',
  'then',
  'than',
  'too',
  'very',
  'just',
  'not',
  'no',
])

/**
 * True when the candidate is grammatical glue not worth replacing: an exact
 * function word, or a short span composed entirely of single-character glue
 * (catches n-gram fragments like "这是" = 这 + 是 without enumerating every
 * combination).
 */
export function isFunctionWord(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return true
  }

  const lower = text.toLocaleLowerCase()
  if (EN_STOPWORDS.has(lower) || STOPWORDS.has(text)) {
    return true
  }

  const characters = [...text]
  if (characters.length <= 3 && characters.every((character) => FUNCTION_CHARS.has(character))) {
    return true
  }

  // Short n-gram artifacts that begin or end with a structural particle
  // ("上的", "来的", "出了", "了几", "的时") — the scanner cuts across a word
  // boundary, leaving a particle stuck to a fragment. Real 2-char words that
  // legitimately end in 的/了 (e.g. 目的) are rare enough to sacrifice here.
  if (characters.length >= 2 && characters.length <= 3) {
    const first = characters[0]
    const last = characters[characters.length - 1]
    if (first === '的' || first === '了' || last === '的' || last === '了') {
      return true
    }
  }

  return false
}
