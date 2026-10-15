import assert from "node:assert/strict";
import test from "node:test";
import { extractWeclawQrUrl, shouldShowWeclawQr } from "./weclaw-ui";

test("keeps the QR visible while the managed login is waiting for scan", () => {
  assert.equal(
    shouldShowWeclawQr({
      qrUrl: "https://liteapp.weixin.qq.com/q/example",
      hasCredentials: false,
      managedRunning: true
    }),
    true
  );
});

test("does not reuse an expired QR URL from the log", () => {
  const log = [
    "starting project notification bridge (127.0.0.1:18011)",
    "QR URL: https://liteapp.weixin.qq.com/q/example",
    "QR code expired; click rebind WeChat to generate a new one"
  ].join("\n");
  assert.equal(extractWeclawQrUrl(log), "");
});
