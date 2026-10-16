import sharp from "sharp";
import type { MailCategory } from "../types";
import type { EmailNotificationModel } from "./format";

const WIDTH = 1080;
const MIN_HEIGHT = 1040;
const MAX_HEIGHT = 3200;
const PAD = 64;
const CONTENT_WIDTH = WIDTH - PAD * 2;
const CARD_RENDER_LIMIT = 2;

sharp.cache({ memory: 16, files: 0, items: 16 });
sharp.concurrency(1);

let activeCardRenders = 0;
const pendingCardRenders: Array<() => void> = [];

async function acquireCardRenderSlot() {
  if (activeCardRenders < CARD_RENDER_LIMIT) {
    activeCardRenders += 1;
    return;
  }
  await new Promise<void>((resolve) => pendingCardRenders.push(resolve));
  activeCardRenders += 1;
}

function releaseCardRenderSlot() {
  activeCardRenders = Math.max(0, activeCardRenders - 1);
  pendingCardRenders.shift()?.();
}

type Palette = { accent: string; dark: string; tint: string; line: string; eyebrow: string };
type Highlight = { label: string; value: string };
export type CardSummaryBlock = { kind: "paragraph" | "bullet"; lines: string[] };

const palettes: Record<MailCategory, Palette> = {
  important: { accent: "#D45B45", dark: "#8E3327", tint: "#FFF0EB", line: "#F1C9BF", eyebrow: "需要优先处理" },
  secondary: { accent: "#706BA8", dark: "#494575", tint: "#F2F1FA", line: "#D8D5ED", eyebrow: "值得稍后阅读" },
  ignore: { accent: "#5F7E76", dark: "#3E5A53", tint: "#EDF4F1", line: "#CEDDD7", eyebrow: "仅作记录" }
};

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
    .replace(/(`{1,3}|\*{1,3}|_{1,3}|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function charWidth(character: string) {
  if (/\s/u.test(character)) return 0.35;
  if (/[\u0000-\u00ff]/u.test(character)) return 0.58;
  return 1;
}

function measuredWidth(value: string) {
  return Array.from(value).reduce((total, character) => total + charWidth(character), 0);
}

function tokens(value: string) {
  return compact(value).match(/[A-Za-z0-9]+(?:[.@:_/+\-'][A-Za-z0-9]+)*|[\p{Script=Han}]|\s+|./gu) ?? [];
}

export function wrapCardText(value: string, maxUnits: number, maxLines: number): string[] {
  const sourceTokens = tokens(value);
  const lines: string[] = [];
  let current = "";
  let width = 0;
  let truncated = false;
  const push = () => {
    if (current.trim()) lines.push(current.trim());
    current = "";
    width = 0;
  };

  outer: for (const token of sourceTokens) {
    if (measuredWidth(token) > maxUnits) {
      for (const character of Array.from(token)) {
        const nextWidth = charWidth(character);
        if (current && width + nextWidth > maxUnits) {
          push();
          if (lines.length >= maxLines) {
            truncated = true;
            break outer;
          }
        }
        current += character;
        width += nextWidth;
      }
      continue;
    }
    const nextWidth = measuredWidth(token);
    if (current && width + nextWidth > maxUnits) {
      push();
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
    current += token;
    width += nextWidth;
  }
  if (!truncated && current.trim() && lines.length < maxLines) push();
  if (truncated && lines.length) {
    const last = lines.length - 1;
    lines[last] = `${lines[last].replace(/[.,，。;；:：\s]+$/u, "").slice(0, -1)}…`;
  }
  return lines.slice(0, maxLines);
}

export function parseCardSummary(value: string, maxLines = 9): CardSummaryBlock[] {
  const rows = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\|?\s*:?-{3,}/.test(line))
    .map((line) => {
      const bullet = line.match(/^(?:[-+*]|\d+[.)])\s+(.+)$/);
      const kind = bullet ? "bullet" as const : "paragraph" as const;
      const withoutPrefix = bullet?.[1] ?? line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "");
      const normalized = withoutPrefix.includes("|")
        ? withoutPrefix.split("|").map(stripInlineMarkdown).filter(Boolean).join(" · ")
        : stripInlineMarkdown(withoutPrefix);
      return { kind, value: normalized };
    })
    .filter((row) => row.value);

  if (!rows.length) return [{ kind: "paragraph", lines: ["暂无邮件分析。"] }];

  const blocks: CardSummaryBlock[] = [];
  let usedLines = 0;
  for (let index = 0; index < rows.length && usedLines < maxLines; index += 1) {
    const row = rows[index];
    const remaining = maxLines - usedLines;
    const lines = wrapCardText(row.value, row.kind === "bullet" ? 31 : 35, remaining);
    if (!lines.length) continue;
    const hasMoreRows = index < rows.length - 1;
    if (usedLines + lines.length >= maxLines && hasMoreRows) {
      const lastIndex = lines.length - 1;
      lines[lastIndex] = `${lines[lastIndex].replace(/[.,，。;；:：…\s]+$/u, "")}…`;
    }
    blocks.push({ kind: row.kind, lines });
    usedLines += lines.length;
  }
  return blocks;
}

export function extractNotificationHighlights(model: EmailNotificationModel): Highlight[] {
  const source = compact([model.subject, model.summary, ...model.actions].join(" "));
  const found: Highlight[] = [];
  const code = source.match(/(?:验证码|校验码|verification\s*code|security\s*code|one[- ]time\s*(?:code|password)|OTP).{0,24}?((?=[A-Z0-9]{4,10}\b)(?=[A-Z0-9]*\d)[A-Z0-9]+)/iu);
  const money = source.match(/(?:[$¥￥€£]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:美元|人民币|元|USD|CNY|EUR|GBP))/iu);
  const date = source.match(/(?:20\d{2}[年/-]\d{1,2}[月/-]\d{1,2}日?|\d{1,2}月\d{1,2}日(?:\s*(?:上午|下午)?\s*\d{1,2}(?::\d{2})?)?|(?:今天|明天|后天)(?:\s*(?:上午|下午)?\s*\d{1,2}(?::\d{2})?)?|\d{1,2}:\d{2})/u);
  const duration = source.match(/(\d{1,3}\s*(?:分钟|小时|天))内/u);
  if (code?.[1]) found.push({ label: "验证码", value: code[1] });
  if (money?.[0]) found.push({ label: "金额", value: compact(money[0]) });
  if (date?.[0]) found.push({ label: "关键时间", value: compact(date[0]) });
  if (duration?.[1]) found.push({ label: "有效期", value: compact(duration[1]) });
  if (model.category === "important" && /(异常登录|安全警报|账号安全|密码|被盗|风险|unauthorized|security alert|new sign-in)/iu.test(source)) {
    found.push({ label: "安全提醒", value: "请立即核实" });
  }
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.label}:${item.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

function text(lines: string[], x: number, y: number, size: number, lineHeight: number, color: string, weight = 500) {
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function section(label: string, x: number, y: number, accent: string) {
  return `<rect x="${x}" y="${y - 18}" width="8" height="26" rx="4" fill="${accent}"/><text x="${x + 24}" y="${y + 3}" fill="#4C5954" font-size="24" font-weight="700">${escapeXml(label)}</text>`;
}

function metadata(label: string, value: string, x: number, y: number) {
  const display = wrapCardText(value, 31, 1)[0] ?? "未知";
  return `<text x="${x}" y="${y}" fill="#7B8882" font-size="22" font-weight="600">${label}</text><text x="${x + 104}" y="${y}" fill="#26312D" font-size="22" font-weight="600">${escapeXml(display)}</text>`;
}

function calendarCardContent(model: EmailNotificationModel) {
  const calendar = model.calendarAnalysis;
  const blocks: CardSummaryBlock[] = [{
    kind: "paragraph",
    lines: [`状态：${calendar?.statusLabel ?? "未执行核对"}`]
  }];
  for (const note of calendar?.notes ?? []) {
    const lines = String(note)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .flatMap((line) => wrapCardText(stripInlineMarkdown(line), 31, 100));
    if (lines.length) blocks.push({ kind: "bullet", lines });
  }
  return blocks;
}

function layout(model: EmailNotificationModel) {
  const title = wrapCardText(stripInlineMarkdown(model.subject), 20, 3);
  const summary = parseCardSummary(model.summary);
  const calendar = calendarCardContent(model);
  const actions = model.actions.slice(0, 3).map((item) => wrapCardText(stripInlineMarkdown(item), 31, 3));
  const highlights = extractNotificationHighlights(model);
  const summaryContentHeight = summary.reduce((sum, block, index) =>
    sum + block.lines.length * 40 + (index ? 12 : 0), 0);
  const summaryHeight = Math.max(96, summaryContentHeight + 54);
  const calendarContentHeight = calendar.reduce((sum, block, index) =>
    sum + block.lines.length * 40 + (index ? 12 : 0), 0);
  const calendarHeight = Math.max(112, calendarContentHeight + 54);
  const actionHeight = actions.reduce((sum, lines) => sum + Math.max(76, lines.length * 38 + 32) + 14, 0);
  const desired = 726 + Math.max(1, title.length) * 58 + (highlights.length ? 154 : 0) + summaryHeight + calendarHeight + 102 + actionHeight;
  return {
    title,
    summary,
    summaryHeight,
    calendar,
    calendarHeight,
    actions,
    highlights,
    height: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, desired))
  };
}

export function buildEmailNotificationCardSvg(model: EmailNotificationModel) {
  const palette = palettes[model.category];
  const card = layout(model);
  const output: string[] = [];
  let y = 72;
  output.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${card.height}" viewBox="0 0 ${WIDTH} ${card.height}">`);
  output.push(`<style>text{font-family:"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:0}</style>`);
  output.push(`<rect width="${WIDTH}" height="${card.height}" fill="#F3F6F3"/><rect x="24" y="24" width="1032" height="${card.height - 48}" rx="24" fill="#FFFEFA" stroke="#D8E0DC" stroke-width="2"/><rect x="24" y="24" width="14" height="${card.height - 48}" rx="7" fill="${palette.accent}"/>`);
  output.push(`<rect x="${PAD}" y="${y}" width="52" height="52" rx="12" fill="#17201D"/><path d="M77 89h26v19H77z M77 90l13 10 13-10" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linejoin="round"/><text x="134" y="105" fill="#17201D" font-size="24" font-weight="800">自动邮件系统</text><text x="134" y="132" fill="#819089" font-size="17" font-weight="600">AI INBOX CONSOLE</text><text x="1016" y="103" text-anchor="end" fill="#78857F" font-size="21" font-weight="600">${escapeXml(model.receivedAt)}</text>`);
  y = 164;
  const pillWidth = Math.max(188, model.categoryLabel.length * 32 + 74);
  output.push(`<rect x="${PAD}" y="${y}" width="${pillWidth}" height="52" rx="12" fill="${palette.tint}" stroke="${palette.line}"/><circle cx="${PAD + 28}" cy="${y + 26}" r="7" fill="${palette.accent}"/><text x="${PAD + 50}" y="${y + 34}" fill="${palette.dark}" font-size="23" font-weight="800">${escapeXml(model.categoryLabel)}</text><text x="1016" y="${y + 33}" text-anchor="end" fill="${palette.dark}" font-size="22" font-weight="750">${escapeXml(palette.eyebrow)}</text>`);
  y += 112;
  output.push(text(card.title, PAD, y, 48, 58, "#17201D", 850));
  y += Math.max(1, card.title.length) * 58 + 36;
  output.push(`<rect x="${PAD}" y="${y}" width="${CONTENT_WIDTH}" height="112" rx="16" fill="#F1F4F1"/>${metadata("发件人", model.sender, PAD + 28, y + 43)}${metadata("邮箱", model.mailbox, PAD + 28, y + 82)}`);
  y += 148;
  if (card.highlights.length) {
    const gap = 16;
    const boxWidth = (CONTENT_WIDTH - gap * (card.highlights.length - 1)) / card.highlights.length;
    card.highlights.forEach((item, index) => {
      const x = PAD + index * (boxWidth + gap);
      output.push(`<rect x="${x}" y="${y}" width="${boxWidth}" height="118" rx="16" fill="${palette.tint}" stroke="${palette.line}"/><text x="${x + 24}" y="${y + 35}" fill="${palette.dark}" font-size="18" font-weight="750">${escapeXml(item.label)}</text><text x="${x + 24}" y="${y + 82}" fill="#17201D" font-size="31" font-weight="850">${escapeXml(wrapCardText(item.value, 12, 1)[0] ?? item.value)}</text>`);
    });
    y += 154;
  }
  output.push(section("邮件要点", PAD, y + 28, palette.accent));
  const summaryY = y + 54;
  output.push(`<rect x="${PAD}" y="${summaryY}" width="${CONTENT_WIDTH}" height="${card.summaryHeight}" rx="18" fill="${palette.tint}" stroke="${palette.line}"/>`);
  let summaryTextY = summaryY + 46;
  card.summary.forEach((block, index) => {
    if (index) summaryTextY += 12;
    if (block.kind === "bullet") {
      output.push(`<circle cx="${PAD + 32}" cy="${summaryTextY - 9}" r="5" fill="${palette.accent}"/>`);
      output.push(text(block.lines, PAD + 54, summaryTextY, 26, 40, "#26312D", 580));
    } else {
      output.push(text(block.lines, PAD + 30, summaryTextY, 27, 40, "#26312D", 600));
    }
    summaryTextY += block.lines.length * 40;
  });
  y = summaryY + card.summaryHeight + 48;
  output.push(section("日程核对", PAD, y + 28, palette.accent));
  const calendarY = y + 54;
  output.push(`<rect x="${PAD}" y="${calendarY}" width="${CONTENT_WIDTH}" height="${card.calendarHeight}" rx="18" fill="#F4F6F4" stroke="${palette.line}"/>`);
  let calendarTextY = calendarY + 46;
  card.calendar.forEach((block, index) => {
    if (index) calendarTextY += 12;
    if (block.kind === "bullet") {
      output.push(`<circle cx="${PAD + 32}" cy="${calendarTextY - 9}" r="5" fill="${palette.accent}"/>`);
      output.push(text(block.lines, PAD + 54, calendarTextY, 26, 40, "#26312D", 580));
    } else {
      output.push(text(block.lines, PAD + 30, calendarTextY, 27, 40, "#26312D", 600));
    }
    calendarTextY += block.lines.length * 40;
  });
  y = calendarY + card.calendarHeight + 48;
  output.push(section("建议动作", PAD, y + 28, palette.accent));
  y += 58;
  card.actions.forEach((lines, index) => {
    const rowHeight = Math.max(76, lines.length * 38 + 32);
    if (y + rowHeight > card.height - 106) return;
    output.push(`<rect x="${PAD}" y="${y}" width="${CONTENT_WIDTH}" height="${rowHeight}" rx="16" fill="#F4F6F4"/><circle cx="${PAD + 38}" cy="${y + 38}" r="22" fill="${palette.accent}"/><text x="${PAD + 38}" y="${y + 46}" text-anchor="middle" fill="#FFFFFF" font-size="19" font-weight="850">${String(index + 1).padStart(2, "0")}</text>${text(lines, PAD + 82, y + 44, 25, 38, "#26312D", 620)}`);
    y += rowHeight + 14;
  });
  output.push(`<line x1="${PAD}" y1="${card.height - 82}" x2="1016" y2="${card.height - 82}" stroke="#DDE4E0" stroke-width="2"/><text x="${PAD}" y="${card.height - 48}" fill="#7D8A84" font-size="18" font-weight="600">邮件已由 AI 整理 · 完整分析见处理台</text><text x="1016" y="${card.height - 48}" text-anchor="end" fill="${palette.dark}" font-size="18" font-weight="750">${escapeXml(model.urgencyLabel)}</text></svg>`);
  return output.join("");
}

export async function renderEmailNotificationCard(model: EmailNotificationModel) {
  await acquireCardRenderSlot();
  try {
    return await sharp(Buffer.from(buildEmailNotificationCardSvg(model)), { density: 144, failOn: "warning", limitInputPixels: 20_000_000 })
      .resize({ width: WIDTH, withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } finally {
    releaseCardRenderSlot();
  }
}

export const emailNotificationCardSize = { width: WIDTH, minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT };
