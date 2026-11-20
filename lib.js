/**
 * 柏宝绘 · 划线出图 —— 纯逻辑部分（不碰 DOM / SillyTavern，可单独测试）。
 */

export const IMAGE_TAG_REGEX = /<bbi_image>[\s\S]+?<\/bbi_image>/gi;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 只保留字母、数字、汉字等「看得见的字」，统一小写。用于让显示文本和原文对得上。 */
export function normalizeText(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (WORD_CHAR.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/**
 * 把消息原文（markdown + 可能有 HTML + 已有的 <bbi_image>）压成「纯字」串，
 * 并记下每个纯字对应原文里的下标。
 */
export function buildPlainMap(raw) {
  const text = String(raw ?? '');
  const chars = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    // 已有的柏宝绘标签：整块跳过（显示里它是图片卡片，不是正文）
    if (text.startsWith('<bbi_image>', i) || text.slice(i, i + 11).toLowerCase() === '<bbi_image>') {
      const close = text.toLowerCase().indexOf('</bbi_image>', i);
      i = close === -1 ? text.length : close + '</bbi_image>'.length;
      continue;
    }
    // HTML 标签 <div ...> </span> <!-- -->
    if (text[i] === '<' && /[a-zA-Z\/!]/.test(text[i + 1] ?? '')) {
      const close = text.indexOf('>', i);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
    }
    // HTML 实体 &nbsp; &#123;
    if (text[i] === '&') {
      const m = /^&(#\d+|#x[0-9a-f]+|[a-z]+);/i.exec(text.slice(i, i + 12));
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (WORD_CHAR.test(ch)) {
      const lower = ch.toLowerCase();
      for (const c of lower) {
        chars.push(c);
        map.push(i + ch.length - 1); // 指向该字符最后一个 code unit
      }
    }
    i += ch.length;
  }
  return { plain: chars.join(''), map };
}

/**
 * 在原文里找到划线句子。approxOffset 是选区起点在显示文本里的「纯字偏移」，
 * 同一句话出现多次时用它挑最近的那一处。
 * 返回 { rawEnd }（句子最后一个字之后的原文下标），找不到返回 null。
 */
export function locateSelection(raw, selectedText, approxOffset = null) {
  const needle = normalizeText(selectedText);
  if (!needle) return null;
  const { plain, map } = buildPlainMap(raw);
  const hits = [];
  let from = 0;
  for (;;) {
    const idx = plain.indexOf(needle, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
  }
  if (!hits.length) return null;
  let best = hits[0];
  if (typeof approxOffset === 'number' && hits.length > 1) {
    best = hits.reduce((a, b) => (Math.abs(b - approxOffset) < Math.abs(a - approxOffset) ? b : a));
  }
  const lastPlain = best + needle.length - 1;
  return { rawStart: map[best], rawEnd: map[lastPlain] + 1, occurrences: hits.length };
}

/** 位置 pos 是否落在 ``` 代码块里。 */
function insideCodeFence(text, pos) {
  const before = text.slice(0, pos);
  const count = (before.match(/^\s*```/gm) || []).length;
  return count % 2 === 1;
}

/**
 * 从句子结尾往后找到「这一段的行尾」作为插入点。
 * 跳过途中遇到的 <bbi_image> 块，避开代码块。
 */
export function findInsertPos(raw, rawEnd) {
  const text = String(raw ?? '');
  let i = Math.max(0, Math.min(rawEnd, text.length));
  const lower = text.toLowerCase();
  while (i < text.length) {
    if (lower.startsWith('<bbi_image>', i)) {
      const close = lower.indexOf('</bbi_image>', i);
      i = close === -1 ? text.length : close + '</bbi_image>'.length;
      continue;
    }
    if (text[i] === '\n') break;
    i++;
  }
  if (insideCodeFence(text, i)) {
    // 挪到代码块结束那一行之后
    const re = /^\s*```.*$/gm;
    re.lastIndex = i;
    const m = re.exec(text);
    i = m ? m.index + m[0].length : text.length;
  }
  return i;
}

/** 插入标签，返回新正文和这个标签是本楼第几个（seq，从 0 起）。 */
export function insertTag(raw, pos, tagText) {
  const text = String(raw ?? '');
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const seq = (before.match(IMAGE_TAG_REGEX) || []).length;
  const glueBefore = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  return { text: `${before}${glueBefore}${tagText}${after}`, seq };
}

/** 去掉会破坏标签结构的尖括号，折成一行。 */
function clean(value) {
  return String(value ?? '')
    .replace(/[<>]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 与柏宝绘 serializeImageTag 同格式。 */
export function serializeTag({ tag, nl = '', characters = [], size = 'portrait' }) {
  const base = clean(tag);
  const nlText = clean(nl);
  const chars = (Array.isArray(characters) ? characters : [])
    .map(c => ({ name: clean(c?.name), tag: clean(c?.tag), nl: clean(c?.nl) }))
    .filter(c => c.name && c.tag);
  const sizeText = size === 'landscape' ? 'landscape' : 'portrait';
  return (
    '<bbi_image>' +
    base +
    (nlText ? `<nl>${nlText}</nl>` : '') +
    (chars.length ? `<characters>${JSON.stringify(chars)}</characters>` : '') +
    `<size>${sizeText}</size>` +
    '</bbi_image>'
  );
}

/** 解析模型返回的 JSON。失败抛错。 */
export function parseLlmJson(text) {
  let body = String(text ?? '');
  body = body.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  body = body.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('模型没有返回 JSON');
  const obj = JSON.parse(body.slice(start, end + 1));
  const tag = clean(obj.tag);
  const characters = (Array.isArray(obj.characters) ? obj.characters : [])
    .map(c => ({ name: clean(c?.name), tag: clean(c?.tag), nl: clean(c?.nl) }))
    .filter(c => c.name && c.tag)
    .slice(0, 4);
  if (!tag && !characters.length) throw new Error('模型返回的 tag 为空');
  const size = String(obj.size ?? '').toLowerCase().includes('land') ? 'landscape' : 'portrait';
  return { tag, nl: clean(obj.nl), size, characters };
}

/** 给模型看的正文：去掉生图标签和 HTML。 */
export function cleanForPrompt(raw) {
  return String(raw ?? '')
    .replace(IMAGE_TAG_REGEX, '')
    .replace(/<[a-zA-Z\/!][^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 以划线句子为中心截取正文，避免太长。 */
export function windowAround(text, sentence, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  const at = text.indexOf(sentence.trim());
  const center = at === -1 ? text.length : at + sentence.length / 2;
  let start = Math.max(0, Math.floor(center - maxChars * 0.7));
  const end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/** 组装发给主 API 的消息。 */
export function buildMessages({
  sentence,
  messageText,
  prevText = '',
  library = [],
  charName = '',
  userName = '',
  useCharacters = false,
  writeNl = false,
  extraRules = '',
  userNote = '',
  contextChars = 1200,
}) {
  const rules = [
    '你是插画提示词写手。用户在小说/角色扮演正文里划出了一句话，你要把「这句话所描写的那一瞬间」画成一张插画，并写出生图提示词。',
    '',
    '规则：',
    '1. 画面以【划线句子】为准；上下文只用来确认人物是谁、在哪里、穿着、时间与光线。不要画划线句子之外的情节。',
    '2. tag 使用英文 danbooru 短 tag，逗号分隔，大致按「人数(1girl/1boy/2girls…) → 构图镜头 → 动作姿势表情 → 场景环境 → 光线氛围」排列，总数不超过 40 个。不要写质量词、画师名、负面词。',
    '3. 出场角色如果在【角色外貌库】里，外貌部分必须原样照抄库里的 tag，不要改写、不要另加发色瞳色；库里没有的角色，根据上下文推断外貌。',
    '4. 文字里没有、也推断不出的细节不要乱加。',
    '5. size：单人特写、立姿、竖向构图用 portrait；多人场景、宽阔风景、横向动作用 landscape。',
    '6. 人数和性别只能用 danbooru 标准写法：1girl、1boy、2girls、2boys、1boy 1girl、multiple girls、solo 等；禁止用 male、female、man、woman、boy、girl 代替。外貌库里如果写的是 male/female，换成对应的 1boy/1girl。',
    '7. 物品、服装、动作尽量用 danbooru 上真实存在的具体 tag，不要用笼统词：口罩写 mouth mask，眼罩写 eyepatch，手表写 wristwatch，递东西写 holding out / giving，而不是 mask、handing over 这类含糊写法。',
  ];
  if (useCharacters) {
    rules.push(
      '8. 多角色模式：tag 只写人数、构图、场景、光线等整体内容，不写任何角色的外貌；每个出场角色单独放进 characters 数组，其 tag = 外貌 tag + 该角色此刻的动作、表情、服装状态。最多 4 个角色。只有一个角色也要放进 characters。',
    );
  }
  if (writeNl) {
    rules.push('9. nl：一到两句英文自然语言，描述同一画面，与 tag 互补、不要逐词重复。');
  }
  if (extraRules.trim()) {
    rules.push('', '【用户的额外规范】', extraRules.trim());
  }
  const shape = {
    tag: '...',
    ...(writeNl ? { nl: '...' } : {}),
    size: 'portrait',
    ...(useCharacters ? { characters: [{ name: '角色名', tag: '...', ...(writeNl ? { nl: '...' } : {}) }] } : {}),
  };
  rules.push('', '只输出一个 JSON 对象，不要解释，不要代码块，格式：', JSON.stringify(shape));

  const parts = [];
  if (library.length) {
    parts.push(
      '【角色外貌库】',
      ...library.slice(0, 40).map(c => `- ${c.name}: ${c.tag}${c.nl ? ` (${c.nl})` : ''}`),
      '',
    );
  }
  if (charName || userName) {
    parts.push(`【角色卡】${charName || '（无）'}；【用户扮演】${userName || '（无）'}`, '');
  }
  if (prevText.trim()) {
    const prev = prevText.length > 600 ? '…' + prevText.slice(-600) : prevText;
    parts.push('【上一楼】', prev, '');
  }
  parts.push('【本楼正文】', windowAround(messageText, sentence, contextChars), '');
  parts.push('【划线句子】', sentence.trim());
  if (userNote.trim()) parts.push('', '【补充要求】', userNote.trim());

  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: parts.join('\n') },
  ];
}

/* ───────────────────── tag 后处理 ───────────────────── */

const GENDER_FIX = new Map([
  ['male', '1boy'], ['man', '1boy'], ['boy', '1boy'], ['a boy', '1boy'], ['young man', '1boy'],
  ['female', '1girl'], ['woman', '1girl'], ['girl', '1girl'], ['a girl', '1girl'], ['young woman', '1girl'],
]);

/** 把 male/female 等非标准写法换成 1boy/1girl，并去掉重复 tag。 */
export function fixGenderTags(tagText) {
  const seen = new Set();
  const out = [];
  for (const raw of String(tagText ?? '').split(',')) {
    let t = raw.trim();
    if (!t) continue;
    const fixed = GENDER_FIX.get(t.toLowerCase());
    if (fixed) t = fixed;
    const key = t.toLowerCase().replace(/_/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(', ');
}

/** 是不是「外貌」类 tag：以 hair / eyes 结尾，且不是动作（摸头发之类）。 */
export function isAppearanceTag(tag) {
  const t = tag.trim().toLowerCase().replace(/_/g, ' ');
  if (!/\b(hair|eyes)$/.test(t)) return false;
  if (/\b(hand|hands|own|touching|playing|grab|grabbing|adjusting|holding|pulling|tucking|wet|messy|closed|half-closed|covering)\b/.test(t)) return false;
  return true;
}

/** 已经带权重语法的 tag 不再包。 */
function alreadyWeighted(tag) {
  return /::|[{}()[\]]/.test(tag);
}

/**
 * 给发型、发色、瞳色等外貌 tag 加权。
 * backend: 'nai' → 1.3::short hair::；其它（ComfyUI/SD）→ (short hair:1.3)
 */
export function emphasizeAppearance(tagText, backend, weight = 1.3) {
  const w = Number(weight) > 0 ? Number(weight) : 1.3;
  const wText = String(Math.round(w * 100) / 100);
  return String(tagText ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(t => {
      if (!isAppearanceTag(t) || alreadyWeighted(t)) return t;
      return backend === 'nai' ? `${wText}::${t}::` : `(${t}:${wText})`;
    })
    .join(', ');
}

/** 统一后处理：性别修正 + 可选加权。prompt 结构同 parseLlmJson 的返回值。 */
export function postProcessPrompt(prompt, { backend = 'nai', emphasize = false, weight = 1.3 } = {}) {
  const apply = text => {
    const fixed = fixGenderTags(text);
    return emphasize ? emphasizeAppearance(fixed, backend, weight) : fixed;
  };
  return {
    ...prompt,
    tag: apply(prompt.tag),
    characters: (prompt.characters ?? []).map(c => ({ ...c, tag: apply(c.tag) })),
  };
}

/* ───────────────────── 副 API（与柏宝绘/柏宝书同协议） ───────────────────── */

/** 与柏宝绘 api/client.ts normalizeUrl 一致。 */
export function normalizeUrl(url) {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 与柏宝绘 buildRequestBody 一致：经酒馆服务器转发，不在浏览器直连。 */
export function buildRequestBody(channel, messages, stream) {
  const reverseProxy = normalizeUrl(channel.url);
  const effort = String(channel.reasoningEffort ?? '').trim();
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    tool_choice: 'none',
    presence_penalty: 0,
    frequency_penalty: 0,
  };
  const body = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };
  for (const p of channel.excludeParams ?? []) {
    const key = String(p).trim();
    if (key) delete body[key];
  }
  return body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** 从非流式响应里取正文。 */
export function extractContent(data) {
  const msg = data?.choices?.[0]?.message;
  return (
    textOf(msg?.content) ||
    textOf(data?.choices?.[0]?.text) ||
    textOf(data?.content) ||
    textOf(msg?.reasoning_content) ||
    ''
  ).trim();
}

/** 解析 SSE 文本（整段），拼出 delta.content。 */
export function parseSseText(text) {
  let out = '';
  let reasoning = '';
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json?.error) throw new Error(json.error.message || '副 API 返回错误');
    const choice = json?.choices?.[0];
    const src = choice?.delta ?? choice?.message;
    out += textOf(src?.content) || textOf(choice?.text);
    reasoning += textOf(src?.reasoning) || textOf(src?.reasoning_content) || textOf(src?.thinking);
  }
  return out.trim() || reasoning.trim();
}

/* ───────────────────── 槽位序号平移 ───────────────────── */

/**
 * 柏宝绘把每张图记在 message.extra.bbiImage[swipeId][promptHash] 的列表里，
 * 并用 entry.slotSeq 记它属于本楼第几个 <bbi_image>（缺省视为 0）。
 * 在第 seq 个位置插入新标签后，原来 >= seq 的槽位都要 +1，否则图片会错位。
 * 纯函数：返回新对象，不改原对象；没有需要改的返回原对象。
 */
export function shiftSlotSeqs(store, swipeId, fromSeq) {
  if (!store || typeof store !== 'object') return store;
  const key = String(swipeId ?? 0);
  const bucket = store[key];
  if (!bucket || typeof bucket !== 'object') return store;
  let changed = false;
  const nextBucket = {};
  for (const [hash, list] of Object.entries(bucket)) {
    if (!Array.isArray(list)) {
      nextBucket[hash] = list;
      continue;
    }
    nextBucket[hash] = list.map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const seq = typeof entry.slotSeq === 'number' ? entry.slotSeq : 0;
      if (seq < fromSeq) return entry;
      changed = true;
      return { ...entry, slotSeq: seq + 1 };
    });
  }
  return changed ? { ...store, [key]: nextBucket } : store;
}
