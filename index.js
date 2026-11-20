/**
 * 柏宝绘 · 划线出图
 *
 * 在聊天正文里选中一句话 → 点「画这句」→ 用主 API 把这句写成生图提示词
 * → 以柏宝绘的 <bbi_image> 标签插到该句所在段落末尾 → 柏宝绘在原位渲染图片卡片并生成。
 */
import {
  buildMessages,
  cleanForPrompt,
  findInsertPos,
  insertTag,
  locateSelection,
  normalizeText,
  parseLlmJson,
  serializeTag,
  postProcessPrompt,
  buildRequestBody,
  extractContent,
  parseSseText,
  shiftSlotSeqs,
  IMAGE_TAG_REGEX,
} from './lib.js';

const MODULE = 'baibai_select_draw';
const LOG = '[划线出图]';

const DEFAULTS = {
  enabled: true,
  confirmBeforeInsert: true,
  autoGenerate: true,
  useCharacters: 'auto', // auto = 后端支持多角色时用；off = 不用
  writeNl: false,
  includePrevMessage: true,
  contextChars: 1200,
  responseLength: 0, // 0 = 跟随预设（只对主 API 生效）
  extraRules: '',
  apiSource: 'baibai', // 'baibai' 跟随柏宝绘「生成 tag」渠道 | 'main' 酒馆主 API | 渠道 id
  emphasize: true, // 给发型/发色/瞳色加权
  emphasizeWeight: 1.3,
  jailbreak: '', // 附加在最前面的 system 提示（可选）
};

const ctx = () => globalThis.SillyTavern?.getContext?.();
const bbi = () => globalThis.STBaiBaiImage;

function settings() {
  const c = ctx();
  const store = c?.extensionSettings ?? {};
  if (!store[MODULE]) store[MODULE] = {};
  const s = store[MODULE];
  for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
  return s;
}
function saveSettings() {
  ctx()?.saveSettingsDebounced?.();
}

/* ───────────────────── 选区 → 浮动按钮 ───────────────────── */

let fab = null;
let pending = null; // { mesid, text, approxOffset }
let busy = false;

function createFab() {
  fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'bsd-fab';
  fab.innerHTML = '<i class="fa-solid fa-palette"></i><span>画这句</span>';
  fab.hidden = true;
  // pointerdown 时先拦住，避免点击把选区清掉
  fab.addEventListener('pointerdown', e => e.preventDefault());
  fab.addEventListener('mousedown', e => e.preventDefault());
  fab.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const job = pending;
    hideFab();
    window.getSelection()?.removeAllRanges();
    if (job) void drawSelection(job);
  });
  document.body.appendChild(fab);
}

function hideFab() {
  if (fab) fab.hidden = true;
  pending = null;
}

/** 选区在显示文本里的「纯字偏移」，排除柏宝绘卡片里的文字。 */
function approxOffsetOf(mesText, range) {
  try {
    const pre = document.createRange();
    pre.selectNodeContents(mesText);
    pre.setEnd(range.startContainer, range.startOffset);
    const frag = pre.cloneContents();
    frag.querySelectorAll('[data-bbi-slot], .bsd-skip').forEach(n => n.remove());
    return normalizeText(frag.textContent ?? '').length;
  } catch {
    return null;
  }
}

function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) return null;
  if (el.closest('[data-bbi-slot], #curEditTextarea, textarea, input')) return null;
  const mesText = el.closest('#chat .mes .mes_text');
  if (!mesText) return null;
  const mes = mesText.closest('.mes');
  const mesid = Number(mes?.getAttribute('mesid'));
  if (!Number.isInteger(mesid)) return null;
  const text = sel.toString().trim();
  if (!text || !normalizeText(text) || text.length > 600) return null;
  return { mesid, text, approxOffset: approxOffsetOf(mesText, range), rect: range.getBoundingClientRect() };
}

let selTimer = null;
function onSelectionMaybeChanged() {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (!settings().enabled || busy) return hideFab();
    const info = readSelection();
    if (!info) return hideFab();
    pending = { mesid: info.mesid, text: info.text, approxOffset: info.approxOffset };
    const { rect } = info;
    fab.hidden = false;
    const w = fab.offsetWidth || 96;
    const h = fab.offsetHeight || 34;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    // 放在选区下方（手机上系统菜单通常在上方）；放不下就放上方
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = rect.top - h - 10;
    fab.style.left = `${left}px`;
    fab.style.top = `${Math.max(8, top)}px`;
  }, 220);
}

/* ───────────────────── 写 tag 用哪个 API ───────────────────── */

const GENERATE_URL = '/api/backends/chat-completions/generate';

/** 柏宝系列插件共享的副 API 渠道列表。 */
function sharedChannels() {
  const list = ctx()?.extensionSettings?.baibai_api_channels?.channels;
  return Array.isArray(list) ? list.filter(c => c && c.id) : [];
}

/** 柏宝绘「生成 tag」当前指派的渠道 id（空 = 柏宝绘自己也跟随主 API）。 */
function baibaiTagGenId() {
  return String(ctx()?.extensionSettings?.baibai_image?.assignments?.tagGen ?? '');
}

/** 解析当前设置实际要用的渠道；null = 用酒馆主 API。 */
function resolveChannel() {
  const src = settings().apiSource || 'baibai';
  if (src === 'main') return { channel: null, label: '酒馆主 API' };
  const channels = sharedChannels();
  const id = src === 'baibai' ? baibaiTagGenId() : src;
  if (!id) return { channel: null, label: '酒馆主 API（柏宝绘未指派副 API）' };
  const channel = channels.find(c => c.id === id);
  if (!channel) {
    return {
      channel: null,
      label: '酒馆主 API（选中的渠道已被删除）',
      missing: true,
    };
  }
  return { channel, label: `副 API：${channel.name || channel.model}` };
}

async function requestViaChannel(channel, messages) {
  const c = ctx();
  if (!channel.url || !channel.model) throw new Error(`副 API「${channel.name || '未命名'}」缺少地址或模型`);
  const stream = !!channel.stream;
  const body = buildRequestBody(channel, messages, stream);
  const timeoutSec = Number(channel.timeoutSec) > 0 ? Number(channel.timeoutSec) : 180;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const resp = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: c.getRequestHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`副 API 请求失败 (${resp.status})：${text.slice(0, 300)}`);
    if (stream) return parseSseText(text);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 有的中转站即使 stream=false 也回 SSE
      return parseSseText(text);
    }
    if (data?.error) throw new Error(data.error.message || '副 API 返回错误');
    return extractContent(data);
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`副 API 超时（${timeoutSec} 秒）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function requestLlm(messages) {
  const s = settings();
  const all = s.jailbreak?.trim() ? [{ role: 'system', content: s.jailbreak.trim() }, ...messages] : messages;
  const { channel, missing } = resolveChannel();
  if (missing) toastr.warning('选中的副 API 渠道已不存在，这次改用酒馆主 API', '划线出图');
  if (channel) return requestViaChannel(channel, all);
  const c = ctx();
  if (typeof c.generateRaw !== 'function') throw new Error('当前酒馆版本不支持 generateRaw，请升级 SillyTavern');
  const responseLength = Number(s.responseLength) > 0 ? Number(s.responseLength) : null;
  return c.generateRaw({ prompt: all, responseLength });
}

/* ───────────────────── 写提示词 ───────────────────── */

async function writePrompt(job, userNote = '') {
  const c = ctx();
  const api = bbi();
  const s = settings();
  const message = c.chat[job.mesid];
  const status = api.getBackendStatus();
  const useCharacters = s.useCharacters !== 'off' && !!status.supportsCharacters;

  let library = [];
  try {
    const opts = job.mesid < c.chat.length - 1 ? { floor: job.mesid + 1 } : undefined;
    library = api.getCharacters(opts)?.characters ?? [];
  } catch (err) {
    console.warn(LOG, '读取角色库失败', err);
  }

  let prevText = '';
  if (s.includePrevMessage) {
    for (let i = job.mesid - 1; i >= 0; i--) {
      const m = c.chat[i];
      if (m && typeof m.mes === 'string' && m.mes.trim() && !(m.is_system && m.extra?.type)) {
        prevText = `${m.name}: ${cleanForPrompt(m.mes)}`;
        break;
      }
    }
  }

  const messages = buildMessages({
    sentence: job.text,
    messageText: cleanForPrompt(message.mes),
    prevText,
    library,
    charName: c.name2 ?? '',
    userName: c.name1 ?? '',
    useCharacters,
    writeNl: !!s.writeNl,
    extraRules: s.extraRules ?? '',
    userNote,
    contextChars: Number(s.contextChars) || 1200,
  });

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await requestLlm(messages);
    try {
      const parsed = parseLlmJson(out);
      if (!useCharacters) parsed.characters = [];
      return postProcessPrompt(parsed, {
        backend: status.backend,
        emphasize: !!s.emphasize,
        weight: s.emphasizeWeight,
      });
    } catch (err) {
      lastErr = err;
      console.warn(LOG, '解析失败，原文：', out);
    }
  }
  throw lastErr ?? new Error('提示词生成失败');
}

/* ───────────────────── 确认弹窗 ───────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

/** 返回 { action: 'insert' | 'rewrite' | 'cancel', prompt, note } */
function confirmDialog(job, prompt) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'bsd-mask';
    const charsHtml = prompt.characters
      .map(
        (ch, i) => `
        <label class="bsd-label">角色：<input class="text_pole bsd-char-name" data-i="${i}" value="${esc(ch.name)}"></label>
        <textarea class="text_pole bsd-ta bsd-char-tag" data-i="${i}" rows="3">${esc(ch.tag)}</textarea>`,
      )
      .join('');
    mask.innerHTML = `
      <div class="bsd-dialog" role="dialog">
        <div class="bsd-title"><i class="fa-solid fa-palette"></i> 划线出图 · 确认提示词</div>
        <div class="bsd-quote">${esc(job.text)}</div>
        <label class="bsd-label">画面 tag</label>
        <textarea class="text_pole bsd-ta bsd-tag" rows="4">${esc(prompt.tag)}</textarea>
        ${charsHtml}
        ${prompt.nl || settings().writeNl ? `<label class="bsd-label">自然语言</label><textarea class="text_pole bsd-ta bsd-nl" rows="2">${esc(prompt.nl)}</textarea>` : ''}
        <label class="bsd-label">画幅
          <select class="text_pole bsd-size">
            <option value="portrait" ${prompt.size !== 'landscape' ? 'selected' : ''}>竖图</option>
            <option value="landscape" ${prompt.size === 'landscape' ? 'selected' : ''}>横图</option>
          </select>
        </label>
        <label class="bsd-label">补充要求（点「重写」时生效，可留空）</label>
        <input class="text_pole bsd-note" placeholder="比如：从背后视角、只画手部特写、夜晚">
        <div class="bsd-buttons">
          <button type="button" class="menu_button bsd-cancel">取消</button>
          <button type="button" class="menu_button bsd-rewrite">重写</button>
          <button type="button" class="menu_button bsd-ok">插入并生成</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const read = () => {
      const q = sel => mask.querySelector(sel);
      return {
        tag: q('.bsd-tag').value,
        nl: q('.bsd-nl')?.value ?? '',
        size: q('.bsd-size').value,
        characters: prompt.characters.map((_, i) => ({
          name: mask.querySelector(`.bsd-char-name[data-i="${i}"]`).value,
          tag: mask.querySelector(`.bsd-char-tag[data-i="${i}"]`).value,
          nl: prompt.characters[i].nl,
        })),
      };
    };
    const done = action => {
      const result = { action, prompt: read(), note: mask.querySelector('.bsd-note').value };
      mask.remove();
      resolve(result);
    };
    mask.querySelector('.bsd-ok').addEventListener('click', () => done('insert'));
    mask.querySelector('.bsd-rewrite').addEventListener('click', () => done('rewrite'));
    mask.querySelector('.bsd-cancel').addEventListener('click', () => done('cancel'));
    mask.addEventListener('click', e => {
      if (e.target === mask) done('cancel');
    });
  });
}

/* ───────────────────── 写回正文 ───────────────────── */

function swipeIdOf(m) {
  return Array.isArray(m.swipes) ? (typeof m.swipe_id === 'number' ? m.swipe_id : 0) : null;
}

async function insertIntoMessage(job, snapshot, prompt) {
  const c = ctx();
  if (c.getCurrentChatId?.() !== snapshot.chatId) throw new Error('聊天已切换，已取消');
  const message = c.chat[job.mesid];
  if (!message || message.send_date !== snapshot.sendDate || message.name !== snapshot.name) {
    throw new Error('这一楼已经变了（被删除或移动），已取消');
  }
  if (swipeIdOf(message) !== snapshot.swipeId) throw new Error('这一楼已经滑到别的回复，已取消');
  if (document.querySelector(`#chat .mes[mesid="${job.mesid}"] #curEditTextarea`)) {
    throw new Error('这一楼正在编辑中，请先保存或取消编辑');
  }

  const raw = message.mes;
  const found = locateSelection(raw, job.text, job.approxOffset);
  let pos;
  if (found) {
    pos = findInsertPos(raw, found.rawEnd);
  } else {
    pos = raw.length;
    toastr.warning('没能在原文里定位到这句话，图片会放在本楼末尾', '划线出图');
  }
  const { text, seq } = insertTag(raw, pos, serializeTag(prompt));
  const sid = swipeIdOf(message);
  const tagsAfter = (raw.match(IMAGE_TAG_REGEX) || []).length - seq;

  if (tagsAfter > 0) {
    // 新标签插在已有图片前面：后面的卡片会整体后移一位。
    // 后面有图片正在生成时不能挪，否则它生成完会落到错误的位置。
    const cards = document.querySelectorAll(`#chat .mes[mesid="${job.mesid}"] .mes_text div[data-bbi-slot]`);
    for (let i = seq; i < cards.length; i++) {
      const phase = cards[i].querySelector('.bbi-figure')?.getAttribute('data-phase');
      if (phase === 'generating' || phase === 'queued') {
        throw new Error('这句话后面有图片正在生成，等它画完再划线');
      }
    }
  }

  const prevMes = message.mes;
  const prevExtra = message.extra;
  const prevSwipe = sid !== null ? message.swipes?.[sid] : undefined;
  message.mes = text;
  if (sid !== null && message.swipes && sid < message.swipes.length) message.swipes[sid] = text;
  if (tagsAfter > 0 && message.extra?.bbiImage) {
    const shifted = shiftSlotSeqs(message.extra.bbiImage, sid ?? 0, seq);
    if (shifted !== message.extra.bbiImage) message.extra = { ...message.extra, bbiImage: shifted };
  }
  try {
    await c.saveChat();
  } catch (err) {
    message.mes = prevMes;
    message.extra = prevExtra;
    if (sid !== null && message.swipes && sid < message.swipes.length) message.swipes[sid] = prevSwipe ?? prevMes;
    throw err;
  }

  const emit = async ev => {
    try {
      if (ev) await c.eventSource.emit(ev, job.mesid);
    } catch (err) {
      console.warn(LOG, '事件发送失败', ev, err);
    }
  };
  await emit(c.eventTypes.MESSAGE_EDITED);
  try {
    if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(job.mesid, message);
    else await c.reloadCurrentChat?.();
  } catch (err) {
    console.warn(LOG, '楼层刷新失败', err);
    await c.reloadCurrentChat?.();
  }
  await emit(c.eventTypes.MESSAGE_UPDATED);
  return seq;
}

/** 等柏宝绘的卡片挂上来，然后点它的「生成图片」。 */
function clickGenerateWhenReady(mesid, seq, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      const slots = document.querySelectorAll(`#chat .mes[mesid="${mesid}"] .mes_text div[data-bbi-slot]`);
      const slot = slots[seq];
      const card = slot?.querySelector('.bbi-figure');
      if (card) {
        const phase = card.getAttribute('data-phase');
        if (phase && phase !== 'pending' && phase !== 'error') return resolve('already');
        const btn = card.querySelector('.bbi-figure__generate');
        if (btn) {
          btn.click();
          slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return resolve('clicked');
        }
      }
      if (Date.now() - started > timeoutMs) return resolve('timeout');
      setTimeout(tick, 150);
    };
    tick();
  });
}

/* ───────────────────── 主流程 ───────────────────── */

async function drawSelection(job) {
  if (busy) return;
  const api = bbi();
  if (!api) {
    toastr.error('没有检测到柏宝绘，请先安装并启用「柏宝绘」扩展', '划线出图');
    return;
  }
  if (api.apiVersion !== 1) console.warn(LOG, '柏宝绘接口版本不同，可能不兼容：', api.apiVersion);
  const status = api.getBackendStatus();
  if (!status.configured) {
    toastr.warning(status.reason || '柏宝绘的出图渠道还没配置好', '划线出图');
    return;
  }
  const c = ctx();
  const message = c.chat?.[job.mesid];
  if (!message) return;
  const snapshot = {
    chatId: c.getCurrentChatId?.(),
    sendDate: message.send_date,
    name: message.name,
    swipeId: swipeIdOf(message),
  };

  busy = true;
  let toast = null;
  try {
    let note = '';
    for (;;) {
      toast = toastr.info(`正在为这句话写提示词…（${resolveChannel().label}）`, '划线出图', { timeOut: 0, extendedTimeOut: 0 });
      let prompt = await writePrompt(job, note);
      toastr.clear(toast);
      toast = null;

      if (settings().confirmBeforeInsert) {
        const result = await confirmDialog(job, prompt);
        if (result.action === 'cancel') return;
        if (result.action === 'rewrite') {
          note = result.note;
          continue;
        }
        prompt = result.prompt;
      }
      if (!prompt.tag.trim() && !prompt.characters.some(ch => ch.tag.trim())) {
        toastr.warning('提示词是空的，已取消', '划线出图');
        return;
      }

      const seq = await insertIntoMessage(job, snapshot, prompt);
      if (settings().autoGenerate) {
        const r = await clickGenerateWhenReady(job.mesid, seq);
        if (r === 'timeout') toastr.info('图片卡片已插入，请点卡片上的「生成图片」', '划线出图');
      } else {
        toastr.success('图片卡片已插入', '划线出图');
      }
      return;
    }
  } catch (err) {
    console.error(LOG, err);
    toastr.error(String(err?.message ?? err), '划线出图失败');
  } finally {
    if (toast) toastr.clear(toast);
    busy = false;
  }
}

/* ───────────────────── 设置面板 ───────────────────── */

function renderSettings() {
  const s = settings();
  const html = `
  <div class="bsd-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>柏宝绘 · 划线出图</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p class="bsd-help">在聊天正文里选中一句话，点浮出的「画这句」，柏宝绘就会在这句所在段落后面配一张图。</p>
        <label class="checkbox_label"><input type="checkbox" data-k="enabled"> 启用</label>
        <label class="bsd-row">写 tag 用的 API
          <select class="text_pole bsd-api" data-k="apiSource"></select>
        </label>
        <p class="bsd-help bsd-api-note"></p>
        <label class="checkbox_label"><input type="checkbox" data-k="confirmBeforeInsert"> 插入前先让我确认 / 修改提示词</label>
        <label class="checkbox_label"><input type="checkbox" data-k="autoGenerate"> 插入后自动开始出图</label>
        <label class="checkbox_label"><input type="checkbox" data-k="writeNl"> 同时写自然语言描述（ComfyUI 开了自然语言时用）</label>
        <label class="checkbox_label"><input type="checkbox" data-k="includePrevMessage"> 把上一楼也发给模型参考</label>
        <label class="bsd-row">多角色提示
          <select class="text_pole" data-k="useCharacters">
            <option value="auto">自动（NAI 4.5 / V5 时启用）</option>
            <option value="off">不用</option>
          </select>
        </label>
        <label class="checkbox_label"><input type="checkbox" data-k="emphasize"> 给发型、发色、瞳色加权（防止画风把发型带跑）</label>
        <label class="bsd-row">加权倍数
          <input class="text_pole" type="number" min="1" max="2" step="0.1" data-k="emphasizeWeight">
        </label>
        <label class="bsd-row">本楼正文最多发送字数
          <input class="text_pole" type="number" min="200" step="100" data-k="contextChars">
        </label>
        <label class="bsd-row">主 API 回复长度上限（0 = 跟随预设）
          <input class="text_pole" type="number" min="0" step="100" data-k="responseLength">
        </label>
        <label class="bsd-label">额外规范（会附在写提示词的要求后面）</label>
        <textarea class="text_pole" rows="3" data-k="extraRules" placeholder="比如：画面偏电影感；不要出现文字"></textarea>
        <label class="bsd-label">破限 / 附加 system 提示（可选，放在最前面）</label>
        <textarea class="text_pole" rows="3" data-k="jailbreak" placeholder="副 API 对露骨内容拒答时可以填这里"></textarea>
        <p class="bsd-help">副 API 渠道就是柏宝绘「渠道」页里配的那些（与柏宝书共用）。出图用柏宝绘当前的出图渠道和方案。</p>
      </div>
    </div>
  </div>`;
  const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!host) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const root = wrap.firstElementChild;
  host.appendChild(root);

  const apiSelect = root.querySelector('.bsd-api');
  const apiNote = root.querySelector('.bsd-api-note');
  const fillApiOptions = () => {
    const cur = s.apiSource || 'baibai';
    const channels = sharedChannels();
    const opts = [
      ['baibai', '跟随柏宝绘「生成 tag」的设置'],
      ['main', '酒馆主 API'],
      ...channels.map(ch => [ch.id, `副 API：${ch.name || '未命名'}${ch.model ? `（${ch.model}）` : ''}`]),
    ];
    if (!opts.some(([v]) => v === cur)) opts.push([cur, '（已删除的渠道）']);
    apiSelect.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    apiSelect.value = cur;
    apiNote.textContent = `当前实际使用：${resolveChannel().label}`;
  };
  fillApiOptions();
  // 在下拉展开之前刷新（展开后再改选项会让下拉闪退）
  apiSelect.addEventListener('mouseenter', fillApiOptions);
  apiSelect.addEventListener('touchstart', fillApiOptions, { passive: true });
  root.querySelector('.inline-drawer-toggle')?.addEventListener('click', fillApiOptions);
  window.addEventListener('st-baibai-api-channels:changed', fillApiOptions);

  root.querySelectorAll('[data-k]').forEach(input => {
    const k = input.getAttribute('data-k');
    if (input.type === 'checkbox') input.checked = !!s[k];
    else input.value = s[k] ?? '';
    input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (input.type === 'checkbox') s[k] = input.checked;
      else if (input.type === 'number') s[k] = Number(input.value) || 0;
      else s[k] = input.value;
      saveSettings();
      if (k === 'apiSource') apiNote.textContent = `当前实际使用：${resolveChannel().label}`;
      if (k === 'enabled' && !s.enabled) hideFab();
    });
  });
}

/* ───────────────────── 启动 ───────────────────── */

function init() {
  settings();
  createFab();
  renderSettings();
  document.addEventListener('selectionchange', onSelectionMaybeChanged);
  document.addEventListener('mouseup', onSelectionMaybeChanged);
  document.addEventListener('touchend', onSelectionMaybeChanged);
  document.getElementById('chat')?.addEventListener('scroll', hideFab, { passive: true });
  const c = ctx();
  if (c?.eventSource && c.eventTypes?.CHAT_CHANGED) c.eventSource.on(c.eventTypes.CHAT_CHANGED, hideFab);
  console.log(LOG, '已加载');
}

if (globalThis.jQuery) jQuery(init);
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
