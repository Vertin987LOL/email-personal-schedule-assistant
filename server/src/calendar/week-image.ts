import sharp from "sharp";
import type { CalendarEvent, CalendarEventKind, CalendarEventStatus } from "./types";

export interface WeekScheduleOptions {
  /** 基准日期（ISO 字符串或 Date），默认当前时间；自动对齐到所在周的周一 */
  anchorDate?: string | Date;
  /** 周偏移量：0 表示本周，1 表示下周，-1 表示上周 */
  weekOffset?: number;
  /** 时区，默认 'Asia/Shanghai' */
  timeZone?: string;
  /** 画布宽度（px），默认 1440 */
  width?: number;
  /** 用于高亮“今天”的基准时间，默认当前时间 */
  now?: string | Date;
  /** 是否仅渲染已确认的正式课程与日程（排除 tentative 邮件提取项） */
  onlyConfirmed?: boolean;
}

export interface WeekGridBlock {
  eventId: string;
  title: string;
  location: string | null;
  kind: CalendarEventKind;
  status: CalendarEventStatus;
  dayIndex: number;
  startMinutes: number;
  endMinutes: number;
  columnIndex: number;
  totalColumns: number;
  timeLabel: string;
}

export interface WeekScheduleLayout {
  weekStartIso: string;
  weekEndIso: string;
  titleLabel: string;
  days: Array<{
    dayIndex: number;
    dateKey: string;
    dateLabel: string;
    weekdayLabel: string;
    isToday: boolean;
  }>;
  minHour: number;
  maxHour: number;
  blocks: WeekGridBlock[];
  allDayEvents: Array<{
    eventId: string;
    dayIndex: number;
    title: string;
    kind: CalendarEventKind;
    status: CalendarEventStatus;
  }>;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const FONT_FAMILY = "'Noto Sans CJK SC', 'WenQuanYi Micro Hei', 'Microsoft YaHei', 'PingFang SC', sans-serif";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute);
  const weekdayMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dayIndex = weekdayMap[parts.weekday] ?? 0;
  return {
    year,
    month,
    day,
    hour,
    minute,
    dayIndex,
    dateKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  };
}

function addDaysToDateKey(dateKey: string, daysToAdd: number): { year: number; month: number; day: number; dateKey: string } {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + daysToAdd));
  const year = utc.getUTCFullYear();
  const month = utc.getUTCMonth() + 1;
  const day = utc.getUTCDate();
  return {
    year,
    month,
    day,
    dateKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  };
}

function formatMinuteClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function charUnits(ch: string): number {
  if (/\s/u.test(ch)) return 0.35;
  if (/[\u0000-\u00ff]/u.test(ch)) return 0.56;
  return 1;
}

function wrapLines(text: string, maxUnits: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || maxLines <= 0) return [];
  const lines: string[] = [];
  let current = "";
  let units = 0;
  const chars = Array.from(clean);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const w = charUnits(ch);
    if (current && units + w > maxUnits) {
      if (lines.length + 1 >= maxLines) {
        lines.push(`${current.slice(0, Math.max(1, current.length - 1))}…`);
        return lines;
      }
      lines.push(current.trim());
      current = ch;
      units = w;
    } else {
      current += ch;
      units += w;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/**
 * 解析微信快捷查课表/日程图口令。
 */
export function parseWeekScheduleCommand(text: string): { matched: boolean; weekOffset: number; onlyConfirmed?: boolean } {
  const match = /^\s*(?:查看|看看|发一下|生成|给我)?\s*(?:我的)?\s*(本周|这周|下周|上周)?\s*(?:的)?\s*(纯课表|正式课表|课表|课程表|日程表|日程图|周历|本周日程|这周日程|下周日程|上周日程)\s*$/u.exec(text);
  if (!match) return { matched: false, weekOffset: 0 };
  const prefix = match[1] ?? "";
  const keyword = match[2] ?? "";
  const onlyConfirmed = keyword === "纯课表" || keyword === "正式课表";
  let weekOffset = 0;
  if (prefix === "下周" || keyword.startsWith("下周")) weekOffset = 1;
  else if (prefix === "上周" || keyword.startsWith("上周")) weekOffset = -1;
  return onlyConfirmed ? { matched: true, weekOffset, onlyConfirmed: true } : { matched: true, weekOffset };
}

/**
 * 计算指定周的起止时间边界（Asia/Shanghai +08:00 偏移）。
 */
export function resolveWeekBounds(options?: WeekScheduleOptions): {
  mondayDateKey: string;
  nextMondayDateKey: string;
  weekStartIso: string;
  weekEndIso: string;
  timeZone: string;
} {
  const timeZone = options?.timeZone ?? DEFAULT_TIME_ZONE;
  const weekOffset = options?.weekOffset ?? 0;
  const anchor = options?.anchorDate
    ? typeof options.anchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.anchorDate)
      ? new Date(`${options.anchorDate}T12:00:00+08:00`)
      : new Date(options.anchorDate)
    : new Date();

  const zoned = getZonedParts(anchor, timeZone);
  const monday = addDaysToDateKey(zoned.dateKey, -zoned.dayIndex + weekOffset * 7);
  const nextMonday = addDaysToDateKey(monday.dateKey, 7);
  return {
    mondayDateKey: monday.dateKey,
    nextMondayDateKey: nextMonday.dateKey,
    weekStartIso: `${monday.dateKey}T00:00:00+08:00`,
    weekEndIso: `${nextMonday.dateKey}T00:00:00+08:00`,
    timeZone
  };
}

/**
 * 纯函数：计算周起止时间、冲突并排分列（overlapping columns）及网格布局坐标。
 */
export function buildWeekScheduleLayout(
  events: CalendarEvent[],
  options?: WeekScheduleOptions
): WeekScheduleLayout {
  const { mondayDateKey, weekStartIso, weekEndIso, timeZone } = resolveWeekBounds(options);
  const nowDate = options?.now ? new Date(options.now) : new Date();
  const todayKey = getZonedParts(nowDate, timeZone).dateKey;

  const days = Array.from({ length: 7 }, (_, idx) => {
    const info = addDaysToDateKey(mondayDateKey, idx);
    return {
      dayIndex: idx,
      dateKey: info.dateKey,
      dateLabel: `${String(info.month).padStart(2, "0")}/${String(info.day).padStart(2, "0")}`,
      weekdayLabel: WEEKDAY_LABELS[idx],
      isToday: info.dateKey === todayKey
    };
  });

  const dayKeyToIndex = new Map(days.map((d) => [d.dateKey, d.dayIndex]));
  const firstDay = addDaysToDateKey(mondayDateKey, 0);
  const lastDay = addDaysToDateKey(mondayDateKey, 6);
  const titleLabel = `${firstDay.year}年${firstDay.month}月${firstDay.day}日 – ${lastDay.month}月${lastDay.day}日 · 周日程表`;

  const allDayEvents: WeekScheduleLayout["allDayEvents"] = [];
  const rawByDay: Map<number, Array<Omit<WeekGridBlock, "columnIndex" | "totalColumns">>> = new Map();
  for (let i = 0; i < 7; i++) rawByDay.set(i, []);

  let minHour = 8;
  let maxHour = 22;

  for (const event of events) {
    if (event.status === "cancelled" || event.status === "ignored") continue;
    if (options?.onlyConfirmed && event.status !== "confirmed") continue;

    if (event.time.kind === "date") {
      const dayIndex = dayKeyToIndex.get(event.time.onDate);
      if (dayIndex !== undefined) {
        allDayEvents.push({
          eventId: event.id,
          dayIndex,
          title: event.title,
          kind: event.kind,
          status: event.status
        });
      }
      continue;
    }

    const startDate = new Date(event.time.kind === "interval" ? event.time.startsAt : event.time.at);
    const endDate =
      event.time.kind === "interval"
        ? new Date(event.time.endsAt)
        : new Date(startDate.getTime() + 45 * 60_000);

    const startParts = getZonedParts(startDate, timeZone);
    const endParts = getZonedParts(endDate, timeZone);
    const dayIndex = dayKeyToIndex.get(startParts.dateKey);

    // 跨天长区间事件或单次超过 6 小时的长窗口事件归入顶部全天/跨天栏，避免撑爆小时网格
    const durationMinutesTotal = (endDate.getTime() - startDate.getTime()) / 60_000;
    if (endParts.dateKey !== startParts.dateKey || durationMinutesTotal > 360) {
      const targetDay = dayIndex ?? 0;
      allDayEvents.push({
        eventId: event.id,
        dayIndex: targetDay,
        title: event.title,
        kind: event.kind,
        status: event.status
      });
      continue;
    }

    if (dayIndex === undefined) continue;

    const startMinutes = startParts.hour * 60 + startParts.minute;
    let endMinutes = endParts.hour * 60 + endParts.minute;
    if (endMinutes <= startMinutes) {
      endMinutes = Math.min(24 * 60, startMinutes + 30);
    }

    minHour = Math.min(minHour, Math.max(0, Math.floor(startMinutes / 60)));
    maxHour = Math.max(maxHour, Math.min(24, Math.ceil(endMinutes / 60)));

    const timeLabel = `${formatMinuteClock(startMinutes)}-${formatMinuteClock(endMinutes)}`;
    rawByDay.get(dayIndex)!.push({
      eventId: event.id,
      title: event.title,
      location: event.location ?? null,
      kind: event.kind,
      status: event.status,
      dayIndex,
      startMinutes,
      endMinutes,
      timeLabel
    });
  }

  const blocks: WeekGridBlock[] = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const dayItems = rawByDay.get(dayIndex)!;
    // 正式课程优先排在左列，其次按开始时间升序、结束时间降序
    dayItems.sort((a, b) => {
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
      if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
      return b.endMinutes - a.endMinutes;
    });

    let cluster: typeof dayItems = [];
    let clusterMaxEnd = -1;

    const flushCluster = (items: typeof dayItems) => {
      if (items.length === 0) return;
      const columnEndTimes: number[] = [];
      const assignedCols: number[] = [];

      for (const item of items) {
        let placedCol = -1;
        for (let c = 0; c < columnEndTimes.length; c++) {
          if (columnEndTimes[c] <= item.startMinutes) {
            placedCol = c;
            columnEndTimes[c] = item.endMinutes;
            break;
          }
        }
        if (placedCol === -1) {
          placedCol = columnEndTimes.length;
          columnEndTimes.push(item.endMinutes);
        }
        assignedCols.push(placedCol);
      }

      const totalColumns = Math.max(1, columnEndTimes.length);
      for (let i = 0; i < items.length; i++) {
        blocks.push({
          ...items[i],
          columnIndex: assignedCols[i],
          totalColumns
        });
      }
    };

    for (const item of dayItems) {
      if (cluster.length === 0) {
        cluster.push(item);
        clusterMaxEnd = item.endMinutes;
      } else if (item.startMinutes < clusterMaxEnd) {
        cluster.push(item);
        clusterMaxEnd = Math.max(clusterMaxEnd, item.endMinutes);
      } else {
        flushCluster(cluster);
        cluster = [item];
        clusterMaxEnd = item.endMinutes;
      }
    }
    flushCluster(cluster);
  }

  return {
    weekStartIso,
    weekEndIso,
    titleLabel,
    days,
    minHour,
    maxHour,
    blocks,
    allDayEvents
  };
}

type BlockStyle = {
  bg: string;
  border: string;
  accent: string;
  titleColor: string;
  metaColor: string;
  dashed: boolean;
  prefix: string;
};

function resolveBlockStyle(kind: CalendarEventKind, status: CalendarEventStatus): BlockStyle {
  if (status === "tentative") {
    return {
      bg: "#FFFBEB",
      border: "#F59E0B",
      accent: "#D97706",
      titleColor: "#92400E",
      metaColor: "#B45309",
      dashed: true,
      prefix: "[待确认] "
    };
  }
  if (kind === "course") {
    return {
      bg: "#EFF6FF",
      border: "#93C5FD",
      accent: "#2563EB",
      titleColor: "#1E3A8A",
      metaColor: "#1D4ED8",
      dashed: false,
      prefix: ""
    };
  }
  return {
    bg: "#ECFDF5",
    border: "#6EE7B7",
    accent: "#059669",
    titleColor: "#065F46",
    metaColor: "#047857",
    dashed: false,
    prefix: ""
  };
}

/**
 * 渲染周日程表 SVG 字符串。
 */
export function renderWeekScheduleSvg(
  events: CalendarEvent[],
  options?: WeekScheduleOptions
): string {
  const layout = buildWeekScheduleLayout(events, options);
  const width = options?.width ?? 1440;
  const outerPad = 32;
  const headerHeight = 112;
  const dayHeaderHeight = 72;

  // 按天分组全天/跨天事件，每天最多展示 2 条，超出显示 +N
  const allDayByDay = new Map<number, WeekScheduleLayout["allDayEvents"]>();
  for (const item of layout.allDayEvents) {
    const list = allDayByDay.get(item.dayIndex) ?? [];
    list.push(item);
    allDayByDay.set(item.dayIndex, list);
  }
  const maxAllDayRows = Math.min(
    2,
    Math.max(0, ...Array.from(allDayByDay.values()).map((items) => Math.min(2, items.length)))
  );
  const allDayRowHeight = maxAllDayRows > 0 ? maxAllDayRows * 32 + 12 : 0;

  const timeGutterWidth = 92;
  const hourHeight = 92;
  const hoursCount = Math.max(1, layout.maxHour - layout.minHour);
  const gridWidth = width - outerPad * 2 - timeGutterWidth;
  const colWidth = gridWidth / 7;
  const gridTop = outerPad + headerHeight + dayHeaderHeight + allDayRowHeight;
  const gridHeight = hoursCount * hourHeight;
  const footerHeight = 46;
  const height = gridTop + gridHeight + footerHeight + outerPad;

  const courseCount = layout.blocks.filter((b) => b.kind === "course" && b.status === "confirmed").length;
  const tentativeCount =
    layout.blocks.filter((b) => b.status === "tentative").length +
    layout.allDayEvents.filter((b) => b.status === "tentative").length;
  const activityCount =
    layout.blocks.filter((b) => b.kind !== "course" && b.status === "confirmed").length +
    layout.allDayEvents.filter((b) => b.status === "confirmed").length;

  const summaryText = `共 ${courseCount} 节正式课程 · ${activityCount} 项已确认日程 · ${tentativeCount} 项邮件待确认日程`;

  const svgParts: string[] = [];
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );

  // 背景与主卡片
  svgParts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#F1F5F9" />`);
  svgParts.push(
    `<rect x="${outerPad}" y="${outerPad}" width="${width - outerPad * 2}" height="${height - outerPad * 2}" rx="24" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.5" />`
  );

  // 顶部标题栏
  const titleX = outerPad + 32;
  const titleY = outerPad + 50;
  svgParts.push(
    `<text x="${titleX}" y="${titleY}" font-family="${FONT_FAMILY}" font-size="28" font-weight="700" fill="#0F172A">${escapeXml(layout.titleLabel)}</text>`
  );
  svgParts.push(
    `<text x="${titleX}" y="${titleY + 34}" font-family="${FONT_FAMILY}" font-size="16" font-weight="500" fill="#64748B">${escapeXml(summaryText)}</text>`
  );

  // 右上角图例
  const legendItems = [
    { label: "正式课程", bg: "#EFF6FF", border: "#2563EB", text: "#1E3A8A" },
    { label: "日程/活动", bg: "#ECFDF5", border: "#059669", text: "#065F46" },
    { label: "邮件待确认", bg: "#FFFBEB", border: "#D97706", text: "#92400E" }
  ];
  let legendX = width - outerPad - 32;
  for (let i = legendItems.length - 1; i >= 0; i--) {
    const item = legendItems[i];
    const pillW = 128;
    legendX -= pillW;
    const pillY = outerPad + 34;
    svgParts.push(
      `<rect x="${legendX}" y="${pillY}" width="${pillW}" height="34" rx="10" fill="${item.bg}" stroke="${item.border}" stroke-width="1.5" />`
    );
    svgParts.push(
      `<circle cx="${legendX + 18}" cy="${pillY + 17}" r="5" fill="${item.border}" />`
    );
    svgParts.push(
      `<text x="${legendX + 32}" y="${pillY + 23}" font-family="${FONT_FAMILY}" font-size="15" font-weight="600" fill="${item.text}">${escapeXml(item.label)}</text>`
    );
    legendX -= 12;
  }

  // 星期表头行
  const dayHeaderTop = outerPad + headerHeight;
  svgParts.push(
    `<rect x="${outerPad}" y="${dayHeaderTop}" width="${width - outerPad * 2}" height="${dayHeaderHeight}" fill="#F8FAFC" />`
  );
  svgParts.push(
    `<line x1="${outerPad}" y1="${dayHeaderTop}" x2="${width - outerPad}" y2="${dayHeaderTop}" stroke="#E2E8F0" stroke-width="1.5" />`
  );
  svgParts.push(
    `<line x1="${outerPad}" y1="${dayHeaderTop + dayHeaderHeight}" x2="${width - outerPad}" y2="${dayHeaderTop + dayHeaderHeight}" stroke="#CBD5E1" stroke-width="1.5" />`
  );

  // 左上角时区标签
  svgParts.push(
    `<text x="${outerPad + timeGutterWidth / 2}" y="${dayHeaderTop + 42}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="14" font-weight="600" fill="#94A3B8">UTC+8</text>`
  );

  // 星期列背景与表头文字
  const gridLeft = outerPad + timeGutterWidth;
  for (const day of layout.days) {
    const colX = gridLeft + day.dayIndex * colWidth;
    if (day.isToday) {
      svgParts.push(
        `<rect x="${colX}" y="${dayHeaderTop}" width="${colWidth}" height="${dayHeaderHeight + allDayRowHeight + gridHeight}" fill="#EFF6FF" fill-opacity="0.4" />`
      );
      svgParts.push(
        `<rect x="${colX + colWidth / 2 - 48}" y="${dayHeaderTop + 9}" width="96" height="54" rx="12" fill="#2563EB" />`
      );
      svgParts.push(
        `<text x="${colX + colWidth / 2}" y="${dayHeaderTop + 32}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="17" font-weight="700" fill="#FFFFFF">${escapeXml(day.weekdayLabel)} · 今日</text>`
      );
      svgParts.push(
        `<text x="${colX + colWidth / 2}" y="${dayHeaderTop + 53}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="14" font-weight="600" fill="#DBEAFE">${escapeXml(day.dateLabel)}</text>`
      );
    } else {
      svgParts.push(
        `<text x="${colX + colWidth / 2}" y="${dayHeaderTop + 31}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="18" font-weight="700" fill="#1E293B">${escapeXml(day.weekdayLabel)}</text>`
      );
      svgParts.push(
        `<text x="${colX + colWidth / 2}" y="${dayHeaderTop + 54}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="14" font-weight="500" fill="#64748B">${escapeXml(day.dateLabel)}</text>`
      );
    }
  }

  // 全天/跨天事件栏（如有）
  if (allDayRowHeight > 0) {
    const allDayTop = dayHeaderTop + dayHeaderHeight;
    svgParts.push(
      `<rect x="${outerPad}" y="${allDayTop}" width="${width - outerPad * 2}" height="${allDayRowHeight}" fill="#FFFBEB" fill-opacity="0.45" />`
    );
    svgParts.push(
      `<text x="${outerPad + timeGutterWidth / 2}" y="${allDayTop + allDayRowHeight / 2 + 5}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="13" font-weight="600" fill="#64748B">全天/跨天</text>`
    );
    for (const [dayIndex, items] of allDayByDay.entries()) {
      const colX = gridLeft + dayIndex * colWidth + 4;
      const visible = items.slice(0, 2);
      visible.forEach((item, rowIdx) => {
        const pillY = allDayTop + 6 + rowIdx * 30;
        const st = resolveBlockStyle(item.kind, item.status);
        svgParts.push(
          `<rect x="${colX}" y="${pillY}" width="${colWidth - 8}" height="26" rx="6" fill="${st.bg}" stroke="${st.border}" stroke-width="1" />`
        );
        const suffix = rowIdx === 1 && items.length > 2 ? ` (+${items.length - 2})` : "";
        const label = (wrapLines(`${st.prefix}${item.title}`, 11, 1)[0] ?? item.title) + suffix;
        svgParts.push(
          `<text x="${colX + 7}" y="${pillY + 18}" font-family="${FONT_FAMILY}" font-size="12" font-weight="600" fill="${st.titleColor}">${escapeXml(label)}</text>`
        );
      });
    }
    svgParts.push(
      `<line x1="${outerPad}" y1="${allDayTop + allDayRowHeight}" x2="${width - outerPad}" y2="${allDayTop + allDayRowHeight}" stroke="#CBD5E1" stroke-width="1.5" />`
    );
  }

  // 小时横线与时间轴刻度
  for (let h = layout.minHour; h <= layout.maxHour; h++) {
    const y = gridTop + (h - layout.minHour) * hourHeight;
    svgParts.push(
      `<line x1="${gridLeft}" y1="${y}" x2="${width - outerPad}" y2="${y}" stroke="#E2E8F0" stroke-width="1" />`
    );
    if (h < layout.maxHour) {
      const halfY = y + hourHeight / 2;
      svgParts.push(
        `<line x1="${gridLeft}" y1="${halfY}" x2="${width - outerPad}" y2="${halfY}" stroke="#F1F5F9" stroke-width="1" stroke-dasharray="4,4" />`
      );
      const timeText = `${String(h).padStart(2, "0")}:00`;
      svgParts.push(
        `<text x="${outerPad + timeGutterWidth - 14}" y="${y + 20}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="14" font-weight="600" fill="#64748B">${timeText}</text>`
      );
    }
  }

  // 垂直天分隔线
  svgParts.push(
    `<line x1="${gridLeft}" y1="${dayHeaderTop}" x2="${gridLeft}" y2="${gridTop + gridHeight}" stroke="#CBD5E1" stroke-width="1.5" />`
  );
  for (let d = 1; d < 7; d++) {
    const x = gridLeft + d * colWidth;
    svgParts.push(
      `<line x1="${x}" y1="${dayHeaderTop}" x2="${x}" y2="${gridTop + gridHeight}" stroke="#E2E8F0" stroke-width="1" />`
    );
  }

  // 渲染每个日程块
  const defsParts: string[] = [];
  const blockNodes: string[] = [];

  layout.blocks.forEach((block, idx) => {
    const startOffsetHours = (block.startMinutes - layout.minHour * 60) / 60;
    const durationHours = Math.max(0.55, (block.endMinutes - block.startMinutes) / 60);
    const subColWidth = (colWidth - 8) / block.totalColumns;
    const x = gridLeft + block.dayIndex * colWidth + 4 + block.columnIndex * subColWidth;
    const y = gridTop + startOffsetHours * hourHeight + 2;
    const w = Math.max(40, subColWidth - 3);
    const h = Math.max(46, durationHours * hourHeight - 4);
    const clipId = `clip-block-${idx}`;

    const style = resolveBlockStyle(block.kind, block.status);
    defsParts.push(
      `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" /></clipPath>`
    );

    const dashAttr = style.dashed ? ` stroke-dasharray="6,3"` : "";
    blockNodes.push(
      `<g clip-path="url(#${clipId})">` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${style.bg}" stroke="${style.border}" stroke-width="1.5"${dashAttr} />` +
        `<rect x="${x}" y="${y}" width="5" height="${h}" fill="${style.accent}" />`
    );

    const fontSizeTitle = block.totalColumns > 1 ? 12 : 14;
    const fontSizeMeta = block.totalColumns > 1 ? 11 : 12;
    const maxCharsPerLine = Math.max(5.5, (w - 14) / fontSizeTitle);
    const maxTitleLines = h >= 140 ? 5 : h >= 105 ? 3 : h >= 72 ? 2 : 1;
    const titleLines = wrapLines(`${style.prefix}${block.title}`, maxCharsPerLine, maxTitleLines);

    let textY = y + fontSizeTitle + 6;
    for (const line of titleLines) {
      blockNodes.push(
        `<text x="${x + 10}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${fontSizeTitle}" font-weight="700" fill="${style.titleColor}">${escapeXml(line)}</text>`
      );
      textY += fontSizeTitle + 4;
    }

    if (h >= 72) {
      blockNodes.push(
        `<text x="${x + 10}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${fontSizeMeta}" font-weight="600" fill="${style.metaColor}">${escapeXml(block.timeLabel)}</text>`
      );
      textY += fontSizeMeta + 4;
      if (block.location) {
        const locMaxUnits = Math.max(5, (w - 14) / fontSizeMeta);
        const locLine = wrapLines(`@${block.location}`, locMaxUnits, 1)[0] ?? `@${block.location}`;
        blockNodes.push(
          `<text x="${x + 10}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${fontSizeMeta}" font-weight="700" fill="${style.metaColor}">${escapeXml(locLine)}</text>`
        );
      }
    } else if (h >= 46) {
      const combinedMeta = block.location ? `${block.timeLabel} @${block.location}` : block.timeLabel;
      const metaMaxUnits = Math.max(5.5, (w - 14) / fontSizeMeta);
      const metaLine = wrapLines(combinedMeta, metaMaxUnits, 1)[0] ?? combinedMeta;
      blockNodes.push(
        `<text x="${x + 10}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${fontSizeMeta}" font-weight="600" fill="${style.metaColor}">${escapeXml(metaLine)}</text>`
      );
    }

    blockNodes.push(`</g>`);
  });

  if (defsParts.length > 0) {
    svgParts.push(`<defs>${defsParts.join("")}</defs>`);
  }
  svgParts.push(...blockNodes);

  // 空状态提示
  if (layout.blocks.length === 0 && layout.allDayEvents.length === 0) {
    const centerY = gridTop + gridHeight / 2;
    svgParts.push(
      `<rect x="${gridLeft + gridWidth / 2 - 180}" y="${centerY - 32}" width="360" height="64" rx="16" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.5" />`
    );
    svgParts.push(
      `<text x="${gridLeft + gridWidth / 2}" y="${centerY + 7}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="18" font-weight="600" fill="#64748B">本周暂无课程或日程安排</text>`
    );
  }

  // 底部说明栏
  const footerY = gridTop + gridHeight + 30;
  svgParts.push(
    `<text x="${outerPad + 28}" y="${footerY}" font-family="${FONT_FAMILY}" font-size="14" fill="#94A3B8">发送「本周课表」「下周课表」可随时获取最新周历图片 · 虚线橙色块为邮件自动提取的待确认日程</text>`
  );

  svgParts.push(`</svg>`);
  return svgParts.join("\n");
}

/**
 * 渲染高清 PNG Buffer（供微信 WeClaw 发送或 HTTP 预览下载）。
 */
export async function renderWeekSchedulePng(
  events: CalendarEvent[],
  options?: WeekScheduleOptions
): Promise<Buffer> {
  const svg = renderWeekScheduleSvg(events, options);
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 8 })
    .toBuffer();
}
