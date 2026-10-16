import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CourseImportProposal, CourseImportResult, CourseSeries, CourseSeriesInput } from "../server/src/calendar/courses";
import { calendarRequest as request } from "./calendar-api";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
function importError(message: string) {
  if (/cross-date/i.test(message)) return "文件含跨日期调课，暂不支持自动导入；请手动录入该次安排。";
  if (/multi-day|multiple times/i.test(message)) return "同一规则含多个星期或时段，请分成独立课程后导入。";
  if (/must be weekly/i.test(message)) return "目前只支持每周重复的课程，请手动录入其他安排。";
  if (/time zone|timeZone/i.test(message)) return "课程缺少可识别的时区。";
  if (/incomplete|DTSTART|DTEND/i.test(message)) return "课程缺少开始、结束等必要信息。";
  return "课程未导入，请核对时间、教学周和文件格式。";
}
function newRow() { return { key: crypto.randomUUID(), title: "", day: 1, start: "10:00", end: "11:30", weeks: "", everyWeek: false, location: "" }; }
function weeks(text: string) {
  const result = new Set<number>();
  for (const part of text.replaceAll("，", ",").split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error("授课周次请填写如 1-4,6,8-12。");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > 104) throw new Error("授课周次范围不正确。");
    for (let week = start; week <= end; week++) result.add(week);
  }
  return [...result].sort((a, b) => a - b);
}

function courseSummary(item: CourseSeries | undefined) {
  if (!item) return "当前课程不存在";
  const weekText = item.teachingWeeks === "every_week" ? "每周" : `第 ${item.teachingWeeks.join(", ")} 周`;
  return `${item.title} · ${weekdays[item.dayOfWeek - 1]} ${item.localStart}–${item.localEnd} · ${weekText} · ${item.location || "地点待补"}`;
}

function teachingWeekSummary(item: CourseSeries | undefined) {
  if (!item) return "无";
  return item.teachingWeeks === "every_week" ? "每周" : `第 ${item.teachingWeeks.join(", ")} 周`;
}

function proposalDiff(current: CourseSeries | undefined, proposed: CourseSeries) {
  const changes: string[] = [];
  if (!current || current.title !== proposed.title) changes.push(`课程：${current?.title || "无"} → ${proposed.title}`);
  if (!current || current.dayOfWeek !== proposed.dayOfWeek) changes.push(`星期：${current ? weekdays[current.dayOfWeek - 1] : "无"} → ${weekdays[proposed.dayOfWeek - 1]}`);
  if (!current || current.localStart !== proposed.localStart || current.localEnd !== proposed.localEnd) {
    changes.push(`时间：${current ? `${current.localStart}–${current.localEnd}` : "无"} → ${proposed.localStart}–${proposed.localEnd}`);
  }
  const oldWeeks = teachingWeekSummary(current);
  const newWeeks = teachingWeekSummary(proposed);
  if (!current || oldWeeks !== newWeeks) changes.push(`教学周：${oldWeeks} → ${newWeeks}`);
  if (!current || (current.location || "") !== (proposed.location || "")) changes.push(`地点：${current?.location || "地点待补"} → ${proposed.location || "地点待补"}`);
  if (!current || current.termStart !== proposed.termStart || current.termEnd !== proposed.termEnd || current.week1StartsOn !== proposed.week1StartsOn) {
    changes.push(`学期范围：${current ? `${current.termStart} 至 ${current.termEnd}` : "无"} → ${proposed.termStart} 至 ${proposed.termEnd}`);
  }
  return changes;
}

export function CourseImport({ onChanged }: { onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<"manual" | "ics">("manual");
  const [term, setTerm] = useState({ termStart: "", termEnd: "", week1StartsOn: "" });
  const [rows, setRows] = useState([newRow()]);
  const [ics, setIcs] = useState("");
  const [filename, setFilename] = useState("");
  const [series, setSeries] = useState<CourseSeries[]>([]);
  const [proposals, setProposals] = useState<CourseImportProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<string>();
  const [error, setError] = useState("");
  const [report, setReport] = useState<CourseImportResult>();
  const operation = useRef<{ content: string; key: string } | undefined>(undefined);
  const fileSequence = useRef(0);
  async function refresh() {
    const result = await request<{ series: CourseSeries[]; proposals: CourseImportProposal[] }>("/courses");
    setSeries(result.series);
    setProposals(result.proposals);
  }
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  function changeRow(index: number, patch: Partial<ReturnType<typeof newRow>>) {
    setRows((old) => old.map((row, position) => position === index ? { ...row, ...patch } : row));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setReport(undefined); setBusy(true);
    try {
      const payload = mode === "manual" ? { series: rows.map((row): CourseSeriesInput => ({
        title: row.title.trim(), dayOfWeek: row.day, localStart: row.start, localEnd: row.end,
        location: row.location.trim(), teachingWeeks: row.everyWeek ? "every_week" : weeks(row.weeks),
        importKey: `manual:${row.key}`, timeZone: "Asia/Shanghai", ...term
      })) } : { ics, options: { ...term, timeZone: "Asia/Shanghai" } };
      if (mode === "ics" && !ics) throw new Error("请先选择日历文件。");
      const content = JSON.stringify(payload);
      if (operation.current?.content !== content) operation.current = { content, key: crypto.randomUUID() };
      const result = await request<CourseImportResult>("/courses/import", "POST", { ...payload, operationKey: operation.current.key });
      setReport(result); await refresh(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "课表导入失败"); }
    finally { setBusy(false); }
  }
  async function resolve(proposal: CourseImportProposal, decision: "approve" | "reject") {
    setError(""); setResolving(proposal.id);
    try {
      await request<CourseImportProposal>(`/courses/proposals/${encodeURIComponent(proposal.id)}/resolve`, "POST", {
        decision, operationKey: crypto.randomUUID()
      });
      await refresh(); await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "课程变更处理失败");
      await refresh().catch(() => undefined);
    } finally { setResolving(undefined); }
  }
  return <details className="course-import">
    <summary>课表导入{series.length ? ` · 已有 ${series.length} 门课程` : ""}</summary>
    <p>按教学周显示课程；支持批量录入和标准日历文件。单次修改只影响当次课程。</p>
    <form onSubmit={(event) => { void submit(event); }}>
      <div className="course-term">
        <label>学期开始<input required type="date" value={term.termStart} onChange={(event) => setTerm({ ...term, termStart: event.target.value })} /></label>
        <label>学期结束<input required type="date" value={term.termEnd} onChange={(event) => setTerm({ ...term, termEnd: event.target.value })} /></label>
        <label>第1教学周的周一<input required type="date" value={term.week1StartsOn} onChange={(event) => setTerm({ ...term, week1StartsOn: event.target.value })} /></label>
        <label>导入方式<select value={mode} onChange={(event) => setMode(event.target.value as "manual" | "ics")}><option value="manual">手动批量录入</option><option value="ics">日历文件（.ics）</option></select></label>
      </div>
      {mode === "manual" ? <>
        {rows.map((row, index) => <div className="course-row" key={row.key}>
          <label>课程名称<input required maxLength={200} value={row.title} onChange={(event) => changeRow(index, { title: event.target.value })} /></label>
          <label>星期<select value={row.day} onChange={(event) => changeRow(index, { day: Number(event.target.value) })}>{weekdays.map((day, n) => <option key={day} value={n + 1}>{day}</option>)}</select></label>
          <label>开始<input required type="time" value={row.start} onChange={(event) => changeRow(index, { start: event.target.value })} /></label>
          <label>结束<input required type="time" value={row.end} onChange={(event) => changeRow(index, { end: event.target.value })} /></label>
          <label>授课周次<input disabled={row.everyWeek} required={!row.everyWeek} placeholder="例如 1-4,6,8-12" value={row.weeks} onChange={(event) => changeRow(index, { weeks: event.target.value })} /></label>
          <label>地点<input maxLength={300} value={row.location} onChange={(event) => changeRow(index, { location: event.target.value })} /></label>
          <label className="course-checkbox"><input type="checkbox" checked={row.everyWeek} onChange={(event) => changeRow(index, { everyWeek: event.target.checked })} />整个学期每周上课</label>
          {rows.length > 1 && <button type="button" disabled={busy} onClick={() => setRows(rows.filter((_, position) => position !== index))}>移除此行</button>}
        </div>)}
        <button type="button" disabled={busy || rows.length >= 30} onClick={() => setRows([...rows, newRow()])}>再加一门课程</button>
      </> : <label>选择日历文件<input type="file" accept=".ics,text/calendar" disabled={busy} onChange={(event) => {
        const sequence = ++fileSequence.current;
        const file = event.target.files?.[0]; setIcs(""); setFilename(""); setError("");
        if (!file) return;
        if (file.size > 5_000_000) { setError("日历文件不能超过5MB。"); return; }
        void file.text().then((text) => { if (sequence === fileSequence.current) { setIcs(text); setFilename(file.name); } }).catch(() => { if (sequence === fileSequence.current) setError("读取文件失败。"); });
      }} /><span>{filename || "文件仅提交到本机服务。未标注时区时使用上海时间。"}</span></label>}
      <button className="primary-button" disabled={busy || (mode === "ics" && !ics)}>{busy ? "导入中…" : "导入课表"}</button>
    </form>
    {error && <p className="calendar-message error" role="alert">{error}</p>}
    {report && <div className="calendar-message" role="status">
      新增 {report.created} 门课程、{report.createdOccurrences} 次课；{report.changed} 项变更待确认，{report.rejected} 项未导入。
      {report.changed > 0 && <p>原课表仍保留。检测到的变更已保存，等待核对。</p>}
      {report.errors.map((item, index) => <p key={index}>未导入：{importError(item.message)}</p>)}
    </div>}
    {proposals.length > 0 && <section className="course-proposals" aria-label="课程变更提案">
      <h3>课程整系列变更</h3>
      <p>接受前不会修改现有课程；每次接受只更新未被本人改单次、取消或手动编辑的课次。</p>
      {proposals.map((proposal) => {
        const current = series.find((item) => item.id === proposal.seriesId);
        const changes = proposalDiff(current, proposal.proposed);
        const pending = proposal.state === "pending";
        return <article className="course-proposal" key={proposal.id}>
          <div className="course-proposal-heading">
            <strong>{proposal.proposed.title}</strong>
            <span className={`course-proposal-state ${proposal.state}`}>{({ pending: "待确认", applied: "已接受", rejected: "已拒绝", stale: "已过期" })[proposal.state]}</span>
          </div>
          <p className="course-proposal-old">原课程：{courseSummary(current)}</p>
          <p className="course-proposal-new">新课程：{courseSummary(proposal.proposed)}</p>
          {changes.length > 0 && <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>}
          {pending && <div className="course-proposal-actions">
            <button type="button" className="primary-button" disabled={Boolean(resolving)} onClick={() => { void resolve(proposal, "approve"); }}>接受整系列变更</button>
            <button type="button" disabled={Boolean(resolving)} onClick={() => { void resolve(proposal, "reject"); }}>拒绝</button>
          </div>}
        </article>;
      })}
    </section>}
    {series.length > 0 && <details><summary>查看已导入课程</summary>{series.map((item) => <p key={item.id}>
      {item.title} · {weekdays[item.dayOfWeek - 1]} {item.localStart}—{item.localEnd} · {item.location || "地点待补"} · {item.teachingWeeks === "every_week" ? "每周" : `第${item.teachingWeeks.join("、")}周`}
    </p>)}</details>}
  </details>;
}
