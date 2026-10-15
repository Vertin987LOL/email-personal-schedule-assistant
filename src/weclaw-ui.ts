export function extractWeclawQrUrl(logTail: string) {
  const lastStart = logTail.lastIndexOf("starting ");
  const lastStop = Math.max(
    logTail.lastIndexOf("stopping managed weclaw process"),
    logTail.lastIndexOf("weclaw exited")
  );
  if (lastStop > lastStart) return "";

  const activeLog = lastStart >= 0 ? logTail.slice(lastStart) : logTail;
  if (activeLog.includes("QR code expired") || activeLog.includes("Login confirmed!") || activeLog.includes("Login successful!")) {
    return "";
  }
  const matches = [...activeLog.matchAll(/QR URL:\s*(https?:\/\/\S+)/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

export function shouldShowWeclawQr(input: {
  qrUrl: string;
  hasCredentials: boolean;
  managedRunning: boolean;
}) {
  return Boolean(input.qrUrl && !input.hasCredentials && input.managedRunning);
}
