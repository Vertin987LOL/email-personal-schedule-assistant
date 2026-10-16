import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import FullCalendar, { type CalendarRef, type EventInput } from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import zhCn from "@fullcalendar/react/locales/zh-cn";
import { Temporal } from "temporal-polyfill";
import type { CalendarEvent as CalendarItem, CalendarTime as EventTime, ChangeProposal as Proposal } from "../server/src/calendar/types";
import type { CalendarTask } from "../server/src/calendar/agent-tasks";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import "./calendar.css";
import { calendarRequest as request } from "./calendar-api";
import { CourseImport } from "./CourseImport";
import { CalendarCommands, type CalendarFocusRequest } from "./CalendarCommands";
import { CalendarDeliveries } from "./CalendarDeliveries";

const ZONE = "Asia/Shanghai";
const labels = { course: "课程", activity: "活动", deadline: "截止", time_block: "时间安排" };
const statusLabels = { confirmed: "已确认", tentative: "待确认", cancelled: "已取消", ignored: "已忽略" };

function dateTime(value: string) {
  return Temporal.Instant.from(value).toZonedDateTimeISO(ZONE).toPlainDateTime().toString({ smallestUnit: "minute" });
}
function instant(value: string) {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(ZONE).toInstant().toString();
}
function localDateTime(value: string, timeZone = ZONE) {
  return Temporal.Instant.from(value).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
function describe(time: EventTime) {
  if (time.kind === "date") return `${time.onDate} · 仅日期`;
  const start = dateTime(time.kind === "point" ? time.at : time.startsAt).replace("T", " ");
  return time.kind === "point" ? `${start} · 截止点` : `${start} — ${dateTime(time.endsAt).replace("T", " ")}`;
}
function previewTimeLabel(time: EventTime) {
  if (time.kind === "date") return `${time.onDate} · 仅日期`;
  const start = localDateTime(time.kind === "point" ? time.at : time.startsAt, time.timeZone).replace("T", " ");
  return time.kind === "point" ? `${start} · 截止点` : `${start} — ${localDateTime(time.endsAt, time.timeZone).replace("T", " ")}`;
}
function reliableTime(time: EventTime | undefined): time is EventTime {
  if (!time) return false;
  try {
    if (time.kind === "date") { Temporal.PlainDate.from(time.onDate); return true; }
    const start = Temporal.Instant.from(time.kind === "point" ? time.at : time.startsAt);
    start.toZonedDateTimeISO(time.timeZone);
    if (time.kind === "interval") {
      const end = Temporal.Instant.from(time.endsAt);
      end.toZonedDateTimeISO(time.timeZone);
      return end.epochNanoseconds > start.epochNanoseconds;
    }
    return true;
  } catch { return false; }
}
function intervalOverlaps(a: EventTime, b: EventTime) {
  if (a.kind !== "interval" || b.kind !== "interval") return false;
  const aStart = Date.parse(a.startsAt), aEnd = Date.parse(a.endsAt), bStart = Date.parse(b.startsAt), bEnd = Date.parse(b.endsAt);
  return Number.isFinite(aStart) && Number.isFinite(aEnd) && Number.isFinite(bStart) && Number.isFinite(bEnd) && aStart < bEnd && bStart < aEnd;
}

export type CalendarProposalPreview = {
  id: string;
  proposal: Proposal;
  title: string;
  kind: CalendarItem["kind"];
  time: EventTime;
  location?: string;
  evidence: string;
  taskId?: string;
  conflictsWith: CalendarItem[];
};

/** Pure projection for pending proposals; it never writes or resolves a proposal. */
export function projectPendingProposals(proposals: Proposal[], items: CalendarItem[], tasks: CalendarTask[] = []): CalendarProposalPreview[] {
  return proposals.flatMap((proposal) => {
    if (proposal.state !== "pending" || (proposal.action !== "create" && proposal.action !== "update")) return [];
    const target = proposal.targetId ? items.find((item) => item.id === proposal.targetId) : undefined;
    const time = proposal.action === "create" ? proposal.event?.time : proposal.patch?.time ?? target?.time;
    if (!reliableTime(time)) return [];
    const title = proposal.action === "create" ? proposal.event?.title : proposal.patch?.title ?? target?.title ?? "待确认的活动";
    if (!title?.trim()) return [];
    const kind = proposal.action === "create" ? proposal.event?.kind ?? "activity" : target?.kind ?? "activity";
    const location = proposal.action === "create" ? proposal.event?.location : proposal.patch?.location ?? target?.location;
    const conflictsWith = time.kind === "interval" ? items.filter((item) => item.id !== proposal.targetId && item.status !== "cancelled" && item.status !== "ignored" && intervalOverlaps(time, item.time)) : [];
    return [{ id: `proposal:${proposal.id}`, proposal, title, kind, time, location, evidence: proposal.evidence,
      taskId: tasks.find((task) => task.proposalIds.includes(proposal.id))?.id, conflictsWith }];
  });
}
function defaultForm() {
  const now = Temporal.Now.zonedDateTimeISO(ZONE).round({ smallestUnit: "hour", roundingMode: "ceil" });
  return { title: "", kind: "activity" as CalendarItem["kind"], timeKind: "interval" as EventTime["kind"],
    start: now.toPlainDateTime().toString({ smallestUnit: "minute" }),
    end: now.add({ hours: 1 }).toPlainDateTime().toString({ smallestUnit: "minute" }),
    date: now.toPlainDate().toString(), location: "", status: "confirmed" as "confirmed" | "tentative",
    reminderEnabled: false, reminderMode: "minutes" as "minutes" | "at", reminderMinutesBefore: "15", reminderAt: "" };
}

export function CalendarPage() {
  const calendar = useRef<CalendarRef>(null);
  const [range, setRange] = useState<{ from: string; to: string }>();
  const currentRange = useRef(range);
  currentRange.current = range;
  const loadSequence = useRef(0);
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [agentTasks, setAgentTasks] = useState<CalendarTask[]>([]);
  const [selected, setSelected] = useState<CalendarItem>();
  const [selectedPreview, setSelectedPreview] = useState<CalendarProposalPreview>();
  const [focusRequest, setFocusRequest] = useState<CalendarFocusRequest>();
  const focusRequestId = useRef(0);
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
      const [events, pending, taskResult] = await Promise.all([
        request<{ events: CalendarItem[] }>(`/events?from=${encodeURIComponent(requestedRange.from)}&to=${encodeURIComponent(requestedRange.to)}`),
        request<{ proposals: Proposal[] }>("/proposals"),
        request<{ tasks: CalendarTask[] }>("/agent/tasks").catch(() => ({ tasks: [] as CalendarTask[] }))
      ]);
      if (sequence !== loadSequence.current || currentRange.current?.from !== requestedRange.from || currentRange.current?.to !== requestedRange.to) return;
      setItems(events.events);
      setProposals(pending.proposals.filter((proposal) => proposal.state === "pending"));
      setAgentTasks(taskResult.tasks);
      setError("");
    } catch (cause) { if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "读取日程失败"); }
  }, [range]);
  useEffect(() => {
    void reload();
    if (!range) return;
    const timer = setInterval(() => { void reload(); }, 8000);
    return () => clearInterval(timer);
  }, [reload, range]);

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
  const proposalPreviews = useMemo(() => projectPendingProposals(proposals, items, agentTasks), [proposals, items, agentTasks]);
  const visiblePreviews = proposalPreviews.filter((preview) => `${preview.title} ${preview.location ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const formalEvents: EventInput[] = visible.map((item): EventInput => {
    const prefix = `${item.status === "tentative" ? "待确认 · " : ""}${conflicts.has(item.id) ? "重叠 · " : ""}`;
    const color = item.kind === "course" ? "#315eaa" : item.kind === "deadline" ? "#a54a30" : item.status === "tentative" ? "#8b6a23" : "#23634f";
    const classNames = item.status === "tentative" ? ["calendar-tentative-event"] : [];
    if (item.time.kind === "date") return { id: item.id, title: `${prefix}${item.title}`, start: item.time.onDate, allDay: true, color, classNames };
    if (item.time.kind === "point") {
      const local = dateTime(item.time.at);
      return { id: item.id, title: `${prefix}截至 ${local.slice(11)} · ${item.title}`, start: local.slice(0, 10), allDay: true, color, classNames };
    }
    return { id: item.id, title: `${prefix}${item.title}`, start: item.time.startsAt, end: item.time.endsAt, color, classNames };
  });
  const events: EventInput[] = formalEvents.concat(visiblePreviews.map((preview): EventInput => {
    const conflictPrefix = preview.conflictsWith.length ? "冲突 · " : "";
    const classNames = ["calendar-preview-event", ...(preview.conflictsWith.length ? ["calendar-preview-conflict"] : [])];
    const color = preview.conflictsWith.length ? "#a54a30" : "#8b6a23";
    if (preview.time.kind === "date") return { id: preview.id, title: `待确认 · ${conflictPrefix}${preview.title}`, start: preview.time.onDate, allDay: true, color, classNames };
    if (preview.time.kind === "point") {
      const local = localDateTime(preview.time.at, preview.time.timeZone);
      return { id: preview.id, title: `待确认 · ${conflictPrefix}截至 ${local.slice(11)} · ${preview.title}`, start: local.slice(0, 10), allDay: true, color, classNames };
    }
    return { id: preview.id, title: `待确认 · ${conflictPrefix}${preview.title}`, start: preview.time.startsAt, end: preview.time.endsAt, color, classNames };
  }));

  function edit(item?: CalendarItem) {
    setSelected(item); setSelectedPreview(undefined); setNotice(""); setError(""); submitOperation.current = undefined; cancelOperation.current = undefined;
    if (!item) { setForm(defaultForm()); return; }
    const fresh = defaultForm();
    setForm({ ...fresh, title: item.title, kind: item.kind, timeKind: item.time.kind, location: item.location ?? "",
      status: item.status === "tentative" ? "tentative" : "confirmed",
      reminderEnabled: item.reminder?.enabled ?? false,
      reminderMode: item.reminder?.at ? "at" : "minutes",
      reminderMinutesBefore: item.reminder?.minutesBefore === undefined ? fresh.reminderMinutesBefore : String(item.reminder.minutesBefore),
      reminderAt: item.reminder?.at ? dateTime(item.reminder.at) : "",
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
      let reminder: { enabled: boolean; minutesBefore?: number; at?: string } = { enabled: false };
      if (form.reminderEnabled) {
        if (form.timeKind === "date" || form.reminderMode === "at") {
          if (!form.reminderAt) throw new Error("启用指定时刻提醒时必须选择明确提醒时刻");
          reminder = { enabled: true, at: instant(form.reminderAt) };
        } else {
          const minutesBeforeText = form.reminderMinutesBefore.trim();
          if (!/^\d+$/.test(minutesBeforeText)) throw new Error("提醒提前分钟数必须是非负整数");
          const minutesBefore = Number(minutesBeforeText);
          if (!Number.isSafeInteger(minutesBefore) || minutesBefore > 1_000_000) throw new Error("提醒提前分钟数超出范围");
          reminder = { enabled: true, minutesBefore };
        }
      }
      const fields = { title: form.title.trim(), kind: form.kind, time, location: form.location.trim(), status: form.status, reminder };
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
  const handleCalendarChanged = useCallback(async () => {
    setSelectedPreview(undefined);
    setFocusRequest(undefined);
    await reload();
  }, [reload]);

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
    <CourseImport onChanged={reload} />
    <CalendarCommands focusRequest={focusRequest} onChanged={handleCalendarChanged} />
    <CalendarDeliveries />
    <div className="calendar-layout">
      <div className="calendar-grid">
        <div className="calendar-filter"><input aria-label="搜索活动" placeholder="搜索活动或地点" value={search} onChange={(event) => setSearch(event.target.value)} />
          <span>{visibleConflictCount ? `${visibleConflictCount} 项与已录入日程重叠` : "本页已录入条目无重叠"} · 待确认用黄色显示</span></div>
        <FullCalendar ref={calendar} plugins={[timeGridPlugin, dayGridPlugin, classicThemePlugin]} locale={zhCn}
          initialView="timeGridWeek" timeZone={ZONE} firstDay={1} nowIndicator height={720} events={events}
          headerToolbar={{ start: "prev,next", center: "title", end: "timeGridWeek,timeGridDay,dayGridMonth" }}
          views={{ nextSeven: { type: "timeGrid", duration: { days: 7 }, dateAlignment: "day" } }}
          slotMinTime="00:00:00" slotMaxTime="24:00:00" scrollTime="08:00:00" allDayText="截止 / 全天" displayEventEnd
          datesSet={(info) => setRange((old) => old?.from === info.startStr && old?.to === info.endStr ? old : { from: info.startStr, to: info.endStr })}
          eventClick={(info) => {
            const item = items.find((candidate) => candidate.id === info.event.id);
            if (item) { edit(item); return; }
            const preview = proposalPreviews.find((candidate) => candidate.id === info.event.id);
            if (!preview) return;
            setSelected(undefined); setSelectedPreview(preview); setNotice(""); setError("");
          }} />
        <p className="calendar-help">{rolling ? "当前从今天起显示7天。" : "点击条目查看或修改。"}时间重叠会保留两项，截止点不占用课程时段。</p>
      </div>
      <aside className="calendar-editor" aria-label={selectedPreview ? "待确认预览" : selected ? "编辑活动" : "新建活动"}>
        {selectedPreview ? <>
          <h3>待确认预览</h3>
          <div className="calendar-preview-detail">
            <strong>{selectedPreview.title}</strong>
            <p>{labels[selectedPreview.kind]} · {previewTimeLabel(selectedPreview.time)}</p>
            {selectedPreview.location && <p>地点：{selectedPreview.location}</p>}
            <p className="calendar-preserve">依据：{selectedPreview.evidence}</p>
            {selectedPreview.conflictsWith.length > 0 ? <div className="calendar-preview-conflicts"><strong>与已录入日程事实重叠</strong>
              {selectedPreview.conflictsWith.map((item) => <p key={item.id}>{item.title} · {describe(item.time)}</p>)}
            </div> : <p>本页已载入条目未发现时间段重叠；课表未核对完整时仍需人工确认。</p>}
            <p className="calendar-help">这是暂存预览；确认前不会写入正式日历。</p>
            {selectedPreview.taskId ? <button type="button" className="primary-button" onClick={() => setFocusRequest({ taskId: selectedPreview.taskId!, requestId: ++focusRequestId.current })}>打开对应任务的安全确认入口</button> :
              <p className="calendar-help">此提案没有可定位的任务确认入口。</p>}
          </div>
        </> : <>
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
          <label><input type="checkbox" checked={form.reminderEnabled} onChange={(event) => setForm({ ...form, reminderEnabled: event.target.checked })} /> 启用提醒</label>
          {form.reminderEnabled && (form.timeKind === "date" ? <label>明确提醒时刻（必填）<input type="datetime-local" required value={form.reminderAt} onChange={(event) => setForm({ ...form, reminderAt: event.target.value })} /></label> : <>
            <label>提醒方式<select value={form.reminderMode} onChange={(event) => setForm({ ...form, reminderMode: event.target.value as "minutes" | "at" })}>
              <option value="minutes">提前分钟</option><option value="at">指定时刻</option>
            </select></label>
            {form.reminderMode === "at" ? <label>明确提醒时刻（必填）<input type="datetime-local" required value={form.reminderAt} onChange={(event) => setForm({ ...form, reminderAt: event.target.value })} /></label> :
              <label>提前提醒（分钟）<input required type="number" min="0" step="1" value={form.reminderMinutesBefore} onChange={(event) => setForm({ ...form, reminderMinutesBefore: event.target.value })} /></label>}
          </>)}
          <button className="primary-button" disabled={busy}>{busy ? "保存中…" : selected ? "保存修改" : "添加到日历"}</button>
          {selected && <button type="button" disabled={busy} onClick={() => { void cancel(); }}>取消此活动</button>}
        </form>
        {selected && <div className="calendar-source"><strong>{labels[selected.kind]} · {statusLabels[selected.status]}</strong><p>{describe(selected.time)}</p><p>版本 {selected.version}</p>
          {selected.seriesId && <p>当前修改仅影响这一次课，其他周次保留。</p>}
          {selected.sourceEvidence && <p>原文依据：{selected.sourceEvidence}</p>}
          <p>来源：{selected.sources.map((source) => ({ manual: "手动录入", course: "课表", email: "邮件", plan: "排程" })[source.kind]).join("；")}</p>
          <details><summary>来源记录编号</summary>{selected.sources.map((source) => <p key={`${source.kind}:${source.ref}`}>{source.ref}</p>)}</details></div>}
        {proposals.length > 0 && <div className="calendar-proposals"><h3>待处理变更 · {proposals.length}</h3>{proposals.map((proposal) => <article key={proposal.id}>
          <strong>待确认的日程变更</strong><p>{proposal.evidence}</p></article>)}</div>}
        </>}
      </aside>
    </div>
  </section>;
}
