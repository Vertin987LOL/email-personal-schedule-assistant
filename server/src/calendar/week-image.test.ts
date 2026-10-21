import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import type { CalendarEvent } from "./types";
import {
  buildWeekScheduleLayout,
  parseWeekScheduleCommand,
  renderWeekSchedulePng,
  renderWeekScheduleSvg
} from "./week-image";

const sampleEvents: CalendarEvent[] = [
  {
    id: "evt-tue-math",
    ownerId: "local-owner",
    title: "MATH1003 线性代数",
    kind: "course",
    status: "confirmed",
    location: "T29-303",
    sources: [{ kind: "course", ref: "s1" }],
    time: {
      kind: "interval",
      startsAt: "2026-10-20T14:00:00+08:00",
      endsAt: "2026-10-20T14:50:00+08:00",
      timeZone: "Asia/Shanghai"
    },
    version: 1
  },
  {
    id: "evt-tue-talk",
    ownerId: "local-owner",
    title: "数学建模竞赛经验分享会",
    kind: "activity",
    status: "tentative",
    location: "T6-106",
    sources: [{ kind: "email", ref: "136" }],
    time: {
      kind: "interval",
      startsAt: "2026-10-20T14:00:00+08:00",
      endsAt: "2026-10-20T15:30:00+08:00",
      timeZone: "Asia/Shanghai"
    },
    version: 1
  },
  {
    id: "evt-wed-ai",
    ownerId: "local-owner",
    title: "UCAI1003 人工智能素养",
    kind: "course",
    status: "confirmed",
    location: "T29-401",
    sources: [{ kind: "course", ref: "s2" }],
    time: {
      kind: "interval",
      startsAt: "2026-10-21T08:00:00+08:00",
      endsAt: "2026-10-21T09:50:00+08:00",
      timeZone: "Asia/Shanghai"
    },
    version: 2
  },
  {
    id: "evt-cancelled",
    ownerId: "local-owner",
    title: "已取消活动",
    kind: "activity",
    status: "cancelled",
    sources: [{ kind: "manual", ref: "m1" }],
    time: {
      kind: "interval",
      startsAt: "2026-10-21T10:00:00+08:00",
      endsAt: "2026-10-21T11:00:00+08:00",
      timeZone: "Asia/Shanghai"
    },
    version: 1
  }
];

test("M1: buildWeekScheduleLayout aligns Monday and assigns overlapping columns side-by-side", () => {
  const layout = buildWeekScheduleLayout(sampleEvents, {
    anchorDate: "2026-10-21T10:00:00+08:00",
    now: "2026-10-19T12:00:00+08:00"
  });

  assert.equal(layout.weekStartIso, "2026-10-19T00:00:00+08:00");
  assert.equal(layout.weekEndIso, "2026-10-26T00:00:00+08:00");
  assert.equal(layout.days.length, 7);
  assert.equal(layout.days[0].dateLabel, "10/19");
  assert.equal(layout.days[0].isToday, true);
  assert.equal(layout.blocks.length, 3, "cancelled event must be excluded");

  const tueBlocks = layout.blocks.filter((b) => b.dayIndex === 1);
  assert.equal(tueBlocks.length, 2);
  assert.equal(tueBlocks[0].totalColumns, 2);
  assert.equal(tueBlocks[1].totalColumns, 2);
  assert.notEqual(tueBlocks[0].columnIndex, tueBlocks[1].columnIndex);

  const wedBlocks = layout.blocks.filter((b) => b.dayIndex === 2);
  assert.equal(wedBlocks.length, 1);
  assert.equal(wedBlocks[0].location, "T29-401");
  assert.equal(wedBlocks[0].totalColumns, 1);
});

test("M1: parseWeekScheduleCommand matches shortcut keywords without intercepting natural language questions", () => {
  assert.deepEqual(parseWeekScheduleCommand("课表"), { matched: true, weekOffset: 0 });
  assert.deepEqual(parseWeekScheduleCommand("本周日程"), { matched: true, weekOffset: 0 });
  assert.deepEqual(parseWeekScheduleCommand("看看我的下周课表"), { matched: true, weekOffset: 1 });
  assert.deepEqual(parseWeekScheduleCommand("上周日程图"), { matched: true, weekOffset: -1 });
  assert.equal(parseWeekScheduleCommand("明天有什么课").matched, false);
  assert.equal(parseWeekScheduleCommand("帮我在日程表里加个会议").matched, false);
});

test("M2: renderWeekScheduleSvg and renderWeekSchedulePng generate valid high-res PNG buffer", async () => {
  const svg = renderWeekScheduleSvg(sampleEvents, {
    anchorDate: "2026-10-19T12:00:00+08:00",
    now: "2026-10-19T12:00:00+08:00"
  });
  assert.match(svg, /T29-401/);
  assert.match(svg, /\[待确认\]/);

  const png = await renderWeekSchedulePng(sampleEvents, {
    anchorDate: "2026-10-19T12:00:00+08:00",
    now: "2026-10-19T12:00:00+08:00"
  });
  assert.equal(png.subarray(0, 4).toString("hex"), "89504e47");
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 1440);
  assert.ok((meta.height ?? 0) > 1000);
});
