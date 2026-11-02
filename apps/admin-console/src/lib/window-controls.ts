type WindowAction = "minimize" | "maximize" | "close";

export async function minimizeWindow(): Promise<void> {
  await runWindowAction("minimize");
}

export async function maximizeWindow(): Promise<void> {
  await runWindowAction("maximize");
}

export async function closeWindow(): Promise<void> {
  await runWindowAction("close");
}

async function runWindowAction(action: WindowAction): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  if (action === "minimize") await appWindow.minimize();
  if (action === "maximize") await appWindow.toggleMaximize();
  if (action === "close") await appWindow.close();
}
