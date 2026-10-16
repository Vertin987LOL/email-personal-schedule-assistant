import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import type { EmailNotificationModel } from "./format";
import {
  buildEmailNotificationCardSvg,
  emailNotificationCardSize,
  extractNotificationHighlights,
  parseCardSummary,
  renderEmailNotificationCard,
  wrapCardText
} from "./card";

function model(overrides: Partial<EmailNotificationModel> = {}): EmailNotificationModel {
  return {
    emailId: "email-card-test",
    category: "important",
    categoryLabel: "重要邮件",
    urgencyLabel: "请尽快查看",
    subject: "[GitHub] Sudo email verification code",
    sender: "GitHub <noreply@github.com>",
    mailbox: "QQ-Mail",
    recipient: "user@example.com",
    receivedAt: "08/16 09:42",
    summary: "GitHub 发来身份验证码 28952475，有效期为 15 分钟。",
    actions: ["请在 15 分钟内使用验证码完成身份验证。", "不要向任何人透露验证码。"],
    ...overrides
  };
}

test("notification card extracts actionable values without AI image generation", () => {
  assert.deepEqual(extractNotificationHighlights(model()), [
    { label: "验证码", value: "28952475" },
    { label: "有效期", value: "15 分钟" }
  ]);
});

test("notification card categories have distinct palettes and escape untrusted mail text", () => {
  const important = buildEmailNotificationCardSvg(model({ subject: "<script>alert(1)</script>" }));
  const secondary = buildEmailNotificationCardSvg(model({ category: "secondary", categoryLabel: "次重要邮件" }));
  assert.match(important, /#D45B45/);
  assert.match(secondary, /#706BA8/);
  assert.doesNotMatch(important, /<script>/);
  assert.match(important, /&lt;script&gt;/);
});

test("notification card wraps long text and renders a bounded PNG", async () => {
  assert.equal(wrapCardText("这是一段很长的中文邮件摘要 mixed with English words", 8, 2).length, 2);
  const png = await renderEmailNotificationCard(model({
    summary: "这是一封需要用户尽快查看的安全邮件。".repeat(40),
    actions: Array.from({ length: 8 }, (_, index) => `处理动作 ${index + 1}：请打开邮件并核实详情。`)
  }));
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, emailNotificationCardSize.width);
  assert.ok((metadata.height ?? 0) >= emailNotificationCardSize.minHeight);
  assert.ok((metadata.height ?? 0) <= emailNotificationCardSize.maxHeight);
  assert.ok(png.length < 3 * 1024 * 1024);
});
test("notification card keeps the three highest-priority actions visible", () => {
  const svg = buildEmailNotificationCardSvg(model({
    actions: ["第一项动作", "第二项动作", "第三项动作", "第四项动作"]
  }));
  assert.match(svg, /第一项动作/);
  assert.match(svg, /第二项动作/);
  assert.match(svg, /第三项动作/);
  assert.doesNotMatch(svg, /第四项动作/);
});

test("notification card preserves Markdown hierarchy without exposing syntax", () => {
  const summary = [
    "**核心结论**：学校更新了着装规则。",
    "",
    "- **截止时间**：9 月 3 日",
    "- **附件**：[完整规则](https://example.com/rules.pdf)"
  ].join("\n");
  assert.deepEqual(parseCardSummary(summary), [
    { kind: "paragraph", lines: ["核心结论：学校更新了着装规则。"] },
    { kind: "bullet", lines: ["截止时间：9 月 3 日"] },
    { kind: "bullet", lines: ["附件：完整规则"] }
  ]);

  const svg = buildEmailNotificationCardSvg(model({ summary, actions: ["在 **9 月 3 日** 前确认。"] }));
  assert.match(svg, /邮件要点/);
  assert.match(svg, /截止时间：9 月 3 日/);
  assert.doesNotMatch(svg, /\*\*/);
  assert.doesNotMatch(svg, /https:\/\/example\.com/);
});

test("notification card keeps multiple calendar notes in a separate block", () => {
  const svg = buildEmailNotificationCardSvg(model({
    calendarAnalysis: {
      status: "ready",
      statusLabel: "已完成核对",
      notes: ["第一场与线性代数重叠15:00—16:00，共60分钟。", "第二场无重叠。"]
    }
  }));
  assert.match(svg, /日程核对/);
  assert.match(svg, /第一场与线性代数重叠15:00—16:00，共60分钟。/);
  assert.match(svg, /第二场无重叠。/);
});
