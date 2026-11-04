import { execFile } from "node:child_process";

const NOTIFY_TIMEOUT_MS = 15_000;

// PowerShell's own app identity: an unregistered one shows no toast at all.
const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text = $xml.GetElementsByTagName('text')",
  "[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:MEX_NOTIFY_TITLE))",
  "[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:MEX_NOTIFY_BODY))",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join("; ");

export interface NotificationCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The OS's own notifier. Text travels as arguments or environment values, never
 * inside a script, and no shell is involved, so a project name cannot inject.
 */
export function notificationCommand(platform: NodeJS.Platform, title: string, body: string): NotificationCommand | null {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST_SCRIPT],
      env: { MEX_NOTIFY_TITLE: title, MEX_NOTIFY_BODY: body },
    };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body],
    };
  }
  if (platform === "linux") return { command: "notify-send", args: ["--app-name=MEX", "--", title, body] };
  return null;
}

/** Resolves false when the notifier is missing or refuses; it never rejects. */
export function sendDesktopNotification(title: string, body: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const notifier = notificationCommand(platform, title, body);
  if (notifier === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(notifier.command, notifier.args, {
      timeout: NOTIFY_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, ...notifier.env },
    }, (error) => resolve(error === null));
  });
}
