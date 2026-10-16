import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import FullCalendar, { type CalendarRef, type EventInput } from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import zhCn from "@fullcalendar/react/locales/zh-cn";
import { Temporal } from "temporal-polyfill";
import type { CalendarEvent as CalendarItem, CalendarTime as EventTime, ChangeProposal as Proposal } from "../server/src/calendar/types";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import "./calendar.css";

const ZONE = "Asia/Shanghai";
const BASE = import.meta.env.VITE_API_BASE_URL ?? (window.location.port === "5173" ? "http://127.0.0.1:8787" : "");
const labels = { course: "课程", activity: "活动", deadline: "截止", time_block: "时间安排" };
const statusLabels = { confirmed: "已确认", tentative: "待确认", cancelled: "已取消", ignored: "已忽略" };

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/api/calendar${path}`, {
    method, credentials: "include", headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) {
    const messages: Record<string, string> = {
      INVALID_TIME: "日期或时间不正确，请检查开始、结束和日期。",
      INVALID_INPUT: "填写的信息不完整或不正确，请检查后再试。",
      VERSION_CONFLICT: "活动已被修改，请刷新后重新打开，避免覆盖新内容。",
      IDEMPOTENCY_CONFLICT: "这次提交的内容已改变，请重新打开活动后保存。",
      NOT_FOUND: "活动已不存在或不可访问，请刷新。",
      FORBIDDEN: "没有权限执行此操作。", STORAGE_FAILED: "保存暂时失败，请稍后重试。"
    };
    throw new Error(messages[result.error] ?? (typeof result.error === "string" ? result.error : "日程操作失败，请重试。"));
  }
  return result as T;
}

function dateTime(value: string) {
  return Temporal.Instant.from(value).toZonedDateTimeISO(ZONE).toPlainDateTime().toString({ smallestUnit: "minute" });
}
function instant(value: string) {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(ZONE).toInstant().toString();
}
function describe(time: EventTime) {
  if (time.kind === "date") return `${time.onDate} · 仅日期`;
  const start = dateTime(time.kind === "point" ? time.at : time.startsAt).replace("T", " ");
  return time.kind === "point" ? `${start} · 截止点` : `${start} — ${dateTime(time.endsAt).replace("T", " ")}`;
}
function defaultForm() {
  const now = Temporal.Now.zonedDateTimeISO(ZONE).round({ smallestUnit: "hour", roundingMode: "ceil" });
  return { title: "", kind: "activity" as CalendarItem["kind"], timeKind: "interval" as EventTime["kind"],
    start: now.toPlainDateTime().toString({ smallestUnit: "minute" }),
    end: now.add({ hours: 1 }).toPlainDateTime().toString({ smallestUnit: "minute" }),
    date: now.toPlainDate().toString(), location: "", status: "confirmed" as "confirmed" | "tentative" };
}

export function CalendarPage() {
  const calendar = useRef<CalendarRef>(null);
  const [range, setRange] = useState<{ from: string; to: string }>();
  const currentRange = useRef(range);
  currentRange.current = range;
  const loadSequence = useRef(0);
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<CalendarItem>();
  const [form, setForm] = useState(defaultForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [rolling, setRolling] = useState(false);
  const submitOperation = useRef<{ content: string; key: string } | undefined>(undefined);
  const cancelOperation = useRef<{ id: string; version: number; key: string } | undefined>(undefined);

  const reload = useCallback(async () => {
    const requestedRange = currentRange.current;
    if (!requestedRange) return;
    const sequence = ++loadSequence.current;
    try {
      const [events, pending] = await Promise.all([
        request<{ events: CalendarItem[] }>(`/events?from=${encodeURIComponent(requestedRange.from)}&to=${encodeURIComponent(requestedRange.to)}`),
        request<{ proposals: Proposal[] }>("/proposals")
      ]);
      if (sequence !== loadSequence.current || currentRange.current?.from !== requestedRange.from || currentRange.current?.to !== requestedRange.to) return;
      setItems(events.events);
      setProposals(pending.proposals.filter((proposal) => proposal.state === "pending"));
      setError("");
    } catch (cause) { if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "读取日程失败"); }
  }, [range]);
  useEffect(() => { void reload(); }, [reload]);

  const visible = useMemo(() => items.filter((item) => item.status !== "cancelled" && item.status !== "ignored" &&
    `${item.title} ${item.location ?? ""}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const conflicts = useMemo(() => {
    const result = new Set<string>();
    const active = items.filter((item) => item.status !== "cancelled" && item.status !== "ignored");
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.time.kind === "interval" && b.time.kind === "interval" &&
        Date.parse(a.time.startsAt) < Date.parse(b.time.endsAt) && Date.parse(b.time.startsAt) < Date.parse(a.time.endsAt)) {
        result.add(a.id); result.add(b.id);
      }
    }
    return result;
  }, [items]);
  const visibleConflictCount = visible.filter((item) => conflicts.has(item.id)).length;
  const events: EventInput[] = visible.map((item) => {
    const prefix = `${item.status === "tentative" ? "待确认 · " : ""}${conflicts.has(item.id) ? "重叠 · " : ""}`;
    const color = item.kind === "course" ? "#315eaa" : item.kind === "deadline" ? "#a54a30" : item.status === "tentative" ? "#8b6a23" : "#23634f";
    if (item.time.kind === "date") return { id: item.id, title: `${prefix}${item.title}`, start: item.time.onDate, allDay: true, color };
    if (item.time.kind === "point") {
      const local = dateTime(item.time.at);
      return { id: item.id, title: `${prefix}截至 ${local.slice(11)} · ${item.title}`, start: local.slice(0, 10), allDay: true, color };
    }
    return { id: item.id, title: `${prefix}${item.title}`, start: item.time.startsAt, end: item.time.endsAt, color };
  });

  function edit(item?: CalendarItem) {
    setSelected(item); setNotice(""); setError(""); submitOperation.current = undefined; cancelOperation.current = undefined;
    if (!item) { setForm(defaultForm()); return; }
    const fresh = defaultForm();
    setForm({ ...fresh, title: item.title, kind: item.kind, timeKind: item.time.kind, location: item.location ?? "",
      status: item.status === "tentative" ? "tentative" : "confirmed",
      ...(item.time.kind === "date" ? { date: item.time.onDate } :
        { start: dateTime(item.time.kind === "point" ? item.time.at : item.time.startsAt),
          ...(item.time.kind === "interval" ? { end: dateTime(item.time.endsAt) } : {}) }) });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const time: EventTime = form.timeKind === "date" ? { kind: "date", onDate: form.date, timeZone: ZONE } :
        form.timeKind === "point" ? { kind: "point", at: instant(form.start), timeZone: ZONE } :
          { kind: "interval", startsAt: instant(form.start), endsAt: instant(form.end), timeZone: ZONE };
      const fields = { title: form.title.trim(), kind: form.kind, time, location: form.location.trim(), status: form.status };
      const content = JSON.stringify({ id: selected?.id, version: selected?.version, fields });
      if (submitOperation.current?.content !== content) submitOperation.current = { content, key: crypto.randomUUID() };
      const operationKey = submitOperation.current.key;
      const { kind: _kind, ...patch } = fields;
      const result = selected ? await request<{ event: CalendarItem }>(`/events/${encodeURIComponent(selected.id)}`, "PATCH", {
        operationKey, expectedVersion: selected.version, patch
      }) : await request<{ event: CalendarItem }>("/events", "POST", {
        operationKey, event: { ...fields, sources: [{ kind: "manual", ref: operationKey }] }
      });
      edit(result.event);
      const savedTime = result.event.time;
      calendar.current?.getApi().gotoDate(savedTime.kind === "date" ? savedTime.onDate : savedTime.kind === "point" ? savedTime.at : savedTime.startsAt);
      await reload(); setNotice("已保存到本地日历。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!selected || !window.confirm(`取消“${selected.title}”？取消记录会保留。`)) return;
    setBusy(true); setError("");
    try {
      if (cancelOperation.current?.id !== selected.id || cancelOperation.current.version !== selected.version) {
        cancelOperation.current = { id: selected.id, version: selected.version, key: crypto.randomUUID() };
      }
      await request(`/events/${encodeURIComponent(selected.id)}`, "DELETE", { operationKey: cancelOperation.current.key, expectedVersion: selected.version });
      edit(); await reload(); setNotice("已取消，历史记录仍保留。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "取消失败"); }
    finally { setBusy(false); }
  }

  return <section className="calendar-page" aria-label="本地日程">
    <div className="calendar-toolbar">
      <div><strong>一周安排</strong><p>课程、活动和截止点 · 上海时间</p></div>
      <div className="calendar-actions">
        <button onClick={() => { setRolling(false); calendar.current?.getApi().changeView("timeGridWeek"); calendar.current?.getApi().today(); }}>本周</button>
        <button onClick={() => { const today = Temporal.Now.plainDateISO(ZONE).toString(); setRolling(true); calendar.current?.getApi().changeView("nextSeven", today); }}>接下来7天</button>
        <button onClick={() => { void reload(); }}>刷新</button><button onClick={() => edit()}>新建活动</button>
      </div>
    </div>
    {error && <p className="calendar-message error" role="alert">{error}</p>}
    {notice && <p className="calendar-message" role="status">{notice}</p>}
    <div className="calendar-layout">
      <div className="calendar-grid">
        <div className="calendar-filter"><input aria-label="搜索活动" placeholder="搜索活动或地点" value={search} onChange={(event) => setSearch(event.target.value)} />
          <span>{visibleConflictCount ? `${visibleConflictCount} 项与已录入日程重叠` : "本页已录入条目无重叠"} · 待确认用黄色显示</span></div>
        <FullCalendar ref={calendar} plugins={[timeGridPlugin, dayGridPlugin, classicThemePlugin]} locale={zhCn}
          initialView="timeGridWeek" timeZone={ZONE} firstDay={1} nowIndicator height="auto" events={events}
          headerToolbar={{ start: "prev,next", center: "title", end: "timeGridWeek,timeGridDay,dayGridMonth" }}
          views={{ nextSeven: { type: "timeGrid", duration: { days: 7 }, dateAlignment: "day" } }}
          slotMinTime="07:00:00" slotMaxTime="23:00:00" allDayText="截止 / 全天" displayEventEnd
          datesSet={(info) => setRange((old) => old?.from === info.startStr && old?.to === info.endStr ? old : { from: info.startStr, to: info.endStr })}
          eventClick={(info) => edit(items.find((item) => item.id === info.event.id))} />
        <p className="calendar-help">{rolling ? "当前从今天起显示7天。" : "点击条目查看或修改。"}时间重叠会保留两项，截止点不占用课程时段。</p>
      </div>
      <aside className="calendar-editor" aria-label={selected ? "编辑活动" : "新建活动"}>
        <h3>{selected ? "活动详情" : "新建活动"}</h3>
        <form onSubmit={(event) => { void save(event); }}>
          <label>标题<input required maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <div className="calendar-field-row"><label>类型<select disabled={Boolean(selected)} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as CalendarItem["kind"] })}>
            {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label><label>时间形式<select value={form.timeKind} onChange={(event) => setForm({ ...form, timeKind: event.target.value as EventTime["kind"] })}>
            <option value="interval">时间段</option><option value="point">截止时刻</option><option value="date">仅日期</option></select></label></div>
          {form.timeKind === "date" ? <label>日期<input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label> : <>
            <label>{form.timeKind === "point" ? "截止时刻" : "开始"}<input required type="datetime-local" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></label>
            {form.timeKind === "interval" && <label>结束<input required type="datetime-local" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} /></label>}
          </>}
          <label>地点<input value={form.location} maxLength={300} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
          <label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as "confirmed" | "tentative" })}><option value="confirmed">已确认</option><option value="tentative">待确认</option></select></label>
          <button className="primary-button" disabled={busy}>{busy ? "保存中…" : selected ? "保存修改" : "添加到日历"}</button>
          {selected && <button type="button" disabled={busy} onClick={() => { void cancel(); }}>取消此活动</button>}
        </form>
        {selected && <div className="calendar-source"><strong>{labels[selected.kind]} · {statusLabels[selected.status]}</strong><p>{describe(selected.time)}</p><p>版本 {selected.version}</p>
          <p>来源：{selected.sources.map((source) => ({ manual: "手动录入", course: "课表", email: "邮件", plan: "排程" })[source.kind]).join("；")}</p>
          <details><summary>来源记录编号</summary>{selected.sources.map((source) => <p key={`${source.kind}:${source.ref}`}>{source.ref}</p>)}</details></div>}
        {proposals.length > 0 && <div className="calendar-proposals"><h3>待处理变更 · {proposals.length}</h3>{proposals.map((proposal) => <article key={proposal.id}>
          <strong>待确认的日程变更</strong><p>{proposal.evidence}</p></article>)}</div>}
      </aside>
    </div>
  </section>;
}
