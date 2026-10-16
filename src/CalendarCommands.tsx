import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CalendarTask } from "../server/src/calendar/agent-tasks";
import type { ChangeProposal, CalendarTime, CalendarEvent } from "../server/src/calendar/types";
import { calendarRequest as request } from "./calendar-api";

type Pending = { proposal: ChangeProposal; digest: string; target?: CalendarEvent };
export type CalendarFocusRequest = { taskId: string; requestId: number };
const states: Record<string, string> = { queued: "已保存，排队中", running: "正在查询日程", needs_input: "需要补充", awaiting_confirmation: "等待你确认", succeeded: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "执行中断", unknown: "结果待核对" };
const errors: Record<string, string> = { REPEATED_ERROR: "相同问题连续出现两次，已停止。请补充信息后重试。", BUDGET_EXCEEDED: "本次调用已达到限制，已有提案仍可核对。", TIMEOUT: "执行超时，已停止后续操作。", "inbound_rejected:forbidden": "这条指令没有对应日程的操作权限。", "inbound_rejected:conflict": "确认内容已过期，请重新查看提案。", "inbound_rejected:invalid_input": "指令不完整，请检查任务编号和确认内容。", "inbound_rejected:not_found": "没有找到这项任务，请检查编号。" };
function timeLabel(time?: CalendarTime) {
  if (!time) return "";
  if (time.kind === "date") return time.onDate;
  const format = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: time.timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  return time.kind === "point" ? `${format(time.at)} 截止` : `${format(time.startsAt)} — ${format(time.endsAt)}`;
}
export function CalendarCommands({ onChanged, focusRequest }: { onChanged: () => void | Promise<void>; focusRequest?: CalendarFocusRequest }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [selected, setSelected] = useState<CalendarTask>();
  const selectedId = useRef<string | undefined>(undefined);
  selectedId.current = selected?.id;
  const [proposals, setProposals] = useState<Pending[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState("");
  const [input, setInput] = useState("");
  const [followup, setFollowup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<{ text: string; key: string } | undefined>(undefined);
  const followupOperation = useRef<{ text: string; taskId: string; key: string } | undefined>(undefined);
  const sequence = useRef(0);
  const handledFocus = useRef<number | undefined>(undefined);
  const load = useCallback(async () => {
    const n = ++sequence.current;
    try {
      const [status, list] = await Promise.all([
        request<{ enabled: boolean; reason?: string }>("/agent/status"),
        request<{ tasks: CalendarTask[] }>("/agent/tasks")
      ]);
      if (n !== sequence.current) return;
      setEnabled(status.enabled); setReason(status.reason ?? ""); setTasks(list.tasks);
      const id = selectedId.current;
      if (id) {
        const details = await request<{ task: CalendarTask; proposals: Pending[] }>(`/agent/tasks/${encodeURIComponent(id)}`);
        if (n !== sequence.current || selectedId.current !== id) return;
        setSelected(details.task); setProposals(details.proposals);
      }
    } catch (cause) { if (n === sequence.current) setError(cause instanceof Error ? cause.message : "指令读取失败"); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 5000); return () => { clearInterval(timer); sequence.current++; }; }, [load]);
  useEffect(() => {
    if (!focusRequest) { handledFocus.current = undefined; return; }
    if (handledFocus.current === focusRequest.requestId) return;
    handledFocus.current = focusRequest.requestId;
    disclosure.current?.setAttribute("open", "");
    selectedId.current = focusRequest.taskId;
    setSelected(undefined); setProposals([]); setFollowup(""); followupOperation.current = undefined;
    void load().then(() => {
      document.getElementById("calendar-command-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [focusRequest, load]);
  async function open(task: CalendarTask) {
    selectedId.current = task.id; setSelected(task); setProposals([]); setFollowup(""); followupOperation.current = undefined;
    await load();
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (operation.current?.text !== input) operation.current = { text: input, key: crypto.randomUUID() };
      const { task } = await request<{ task: CalendarTask }>("/agent/tasks", "POST", { operationKey: operation.current.key, text: input });
      setInput(""); operation.current = undefined; await open(task);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "指令保存失败"); } finally { setBusy(false); }
  }
  async function supplement(event: FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true); setError("");
    try {
      if (followupOperation.current?.text !== followup || followupOperation.current.taskId !== selected.id) followupOperation.current = { text: followup, taskId: selected.id, key: crypto.randomUUID() };
      await request(`/agent/tasks/${encodeURIComponent(selected.id)}/input`, "POST", { inputKey: followupOperation.current.key, text: followup });
      setFollowup(""); followupOperation.current = undefined; await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "补充信息保存失败"); } finally { setBusy(false); }
  }
  async function resolve(item: Pending, decision: "approve" | "reject") {
    if (!selected) return; setBusy(true); setError("");
    try {
      await request(`/agent/tasks/${encodeURIComponent(selected.id)}/proposals/${encodeURIComponent(item.proposal.id)}/resolve`, "POST", { decision, digest: item.digest });
      await load(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "确认失败，请重新查看提案"); } finally { setBusy(false); }
  }
  const result = selected?.result as { text?: string } | undefined;
  return <details ref={disclosure} id="calendar-commands" className="calendar-commands"><summary>用一句话查询或安排日程</summary>
    {!enabled && <p className="calendar-help">{reason || "执行端尚未启用。"}</p>}
    <form onSubmit={event => { void submit(event); }}><label>你的指令<textarea required maxLength={20_000} rows={2} placeholder="例如：周五前找两小时复习；或查看明天的安排" value={input} onChange={event => setInput(event.target.value)} /></label>
      <button disabled={busy}>{busy ? "保存中…" : enabled ? "提交指令" : "先保存指令"}</button></form>
    {error && <p className="calendar-message error" role="alert">{error}</p>}
    <div className="calendar-command-layout"><div className="calendar-task-list">{tasks.slice(0, 15).map(task => <button key={task.id} aria-pressed={selected?.id === task.id} onClick={() => { void open(task); }}><span>{task.text.slice(0, 80)}</span><small>{states[task.state] ?? "待核对"}</small></button>)}</div>
      {selected && <article id="calendar-command-detail" className="calendar-task-detail"><strong>{states[selected.state] ?? "待核对"}</strong><p className="calendar-preserve">{selected.text}</p>
        {selected.question && <p className="calendar-message">{selected.question}</p>}{result?.text && <p className="calendar-preserve">{result.text}</p>}{selected.error && <p className="calendar-message error">{errors[selected.error] ?? (selected.error.startsWith("inbound_rejected:") ? "微信指令未执行，请检查任务编号和输入内容。" : selected.error)}</p>}
        {proposals.map(item => <div className="calendar-proposal" key={item.proposal.id}><strong>{{ create: "新增", update: "修改", cancel: "取消", plan: "安排", match: "关联" }[item.proposal.action]}：{item.proposal.event?.title ?? item.proposal.patch?.title ?? item.target?.title ?? "已有活动"}</strong>
          {item.target && <p>当前：{item.target.title} · {timeLabel(item.target.time)} · {item.target.location} · 版本{item.target.version}</p>}
          <p>{timeLabel(item.proposal.event?.time ?? item.proposal.patch?.time)}</p><p>{item.proposal.event?.location ?? item.proposal.patch?.location}</p><p>{item.proposal.evidence}</p>
          {item.proposal.state === "pending" ? <div className="calendar-actions"><button disabled={busy} onClick={() => { void resolve(item, "approve"); }}>确认这项变更</button><button disabled={busy} onClick={() => { void resolve(item, "reject"); }}>拒绝</button></div> : <p>{item.proposal.state === "applied" ? "已应用" : item.proposal.state === "stale" ? "已有新版本，请重新提出" : "已拒绝"}</p>}
        </div>)}
        {["needs_input", "failed", "interrupted"].includes(selected.state) && <form onSubmit={event => { void supplement(event); }}><label>补充信息<textarea required rows={2} maxLength={20_000} value={followup} onChange={event => setFollowup(event.target.value)} /></label><button disabled={busy}>补充到原任务</button></form>}
        {["queued", "running", "needs_input", "interrupted", "awaiting_confirmation"].includes(selected.state) && <button disabled={busy} onClick={() => { setBusy(true); void request(`/agent/tasks/${encodeURIComponent(selected.id)}/cancel`, "POST").then(load).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>停止这项任务</button>}
      </article>}
    </div>
  </details>;
}
