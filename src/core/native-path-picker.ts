/**
 * 原生「选择本机路径」弹窗（导入向导 → 路径映射 → 输入框右侧的文件夹图标）。
 *
 * 为什么要绕到操作系统：浏览器的 File System Access API 只给 handle、`<input type="file">`
 * 只给文件名，都拿不到绝对路径；而路径映射要的正是**绝对路径**。DSH 桌面端的宿主进程虽然由
 * Electron 拉起，但用的是 `ELECTRON_RUN_AS_NODE=1`（见 src/utils/desktop-carrier.ts），
 * 进程里没有 BrowserWindow，`require('electron').dialog` 不可用。所以只能请操作系统的
 * 标准文件夹选择器出场：
 *
 *  - **win32**：PowerShell + `IFileOpenDialog`（`FOS_PICKFOLDERS`）= 资源管理器同款
 *    「选择文件夹」窗口（tree 侧栏 + 文件名输入框），不是 Win7 那种 SHBrowseForFolder 老树。
 *  - **darwin**：`osascript` 的 `choose folder` = Finder 的标准选择面板。
 *  - **linux**：`zenity` / `kdialog`（GTK / KDE 原生对话框）；都没有则如实回 `unsupported`。
 *
 * 边界
 * ----
 * - **只弹窗、不写盘**：返回值就是用户选中的绝对路径，路径合法性由调用方（映射表单）判定；
 * - 用户取消 = `canceled`（调用方静默处理，不当错误弹红条）；
 * - 能力缺失（无 PowerShell / 无 zenity / 非三大平台）= `unsupported`，调用方回落到内置目录浏览器；
 * - 子进程失败 = `failed`（带 detail，便于排查），同样回落而不是把用户堵住；
 * - 用户要浏览多久就等多久：默认 10 分钟上限远大于实际操作时间，超时才判 failed。
 *
 * 用户给的起始路径与标题都经**环境变量**传给子进程（不进命令行），因此不存在拼进脚本被解释的风险。
 */
import { spawn } from 'node:child_process'

export type NativePickReason = 'canceled' | 'unsupported' | 'failed'

export type NativePickResult =
  | { ok: true; path: string }
  | { ok: false; reason: NativePickReason; detail?: string }

/** 一次子进程调用的完整描述（便于单测注入假实现）。 */
export interface NativePickRun {
  file: string
  args: string[]
  env: Record<string, string>
  timeoutMs: number
}

/** 子进程结果：`missing` 表示解释器/程序本身不存在（能力缺失，不是失败）。 */
export interface NativePickExec {
  code: number | null
  stdout: string
  stderr: string
  missing: boolean
}

export type NativePickSpawner = (run: NativePickRun) => Promise<NativePickExec>

export interface NativePickOptions {
  platform?: NodeJS.Platform
  startPath?: string | undefined
  title?: string | undefined
  timeoutMs?: number
  spawner?: NativePickSpawner
}

/** 用户可能在对话框里逛很久 —— 上限只用来兜住「进程卡死」，不是操作时限。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** 起始路径 / 标题的环境变量名（不进 argv，见文件头）。 */
export const PICK_ENV_START = 'DCM_PICK_START'
export const PICK_ENV_TITLE = 'DCM_PICK_TITLE'

/**
 * Windows：`IFileOpenDialog` 的 C# 互操作 + 一句 PowerShell 装配。
 *
 * 手写 vtable 顺序是这里唯一的硬骨头：`IFileDialog` 的方法必须**按声明顺序**逐一列出，
 * 少一个/错一个都会在 Show 时炸成 HRESULT 0x80004002 之类；下面的顺序与 shobjidl.h 一致。
 * 起始目录用 `SHCreateItemFromParsingName` 转 IShellItem（不存在的路径就静默忽略，仍能弹窗）。
 */
const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Threading;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
public class FileOpenDialogRCW { }

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileDialog {
  [PreserveSig] int Show(IntPtr hwndParent);
  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  void SetFileTypeIndex(uint iFileType);
  [PreserveSig] uint GetFileTypeIndex();
  [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
  [PreserveSig] int Unadvise(uint dwCookie);
  void SetOptions(uint fos);
  [PreserveSig] int GetOptions(out uint pfos);
  void SetDefaultFolder(IShellItem psi);
  void SetFolder(IShellItem psi);
  void GetFolder(out IShellItem ppsi);
  void GetCurrentSelection(out IShellItem ppsi);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  void GetResult(out IShellItem ppsi);
  void AddPlace(IShellItem psi, int fdap);
  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
  void Close(int hr);
  void SetClientGuid(ref Guid guid);
  void ClearClientData();
  void SetFilter(IntPtr pFilter);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem ppsi);
  void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
  void Compare(IShellItem psi, uint hint, out int piOrder);
}

public static class DcmNativePick {
  const uint FOS_PICKFOLDERS = 0x20;
  const uint FOS_FORCEFILESYSTEM = 0x40;
  const uint FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  static IShellItem Item(string path) {
    Guid iid = typeof(IShellItem).GUID;
    IShellItem item;
    SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
    return item;
  }

  static IFileDialog Create(string startPath) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts;
    dlg.GetOptions(out opts);
    dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (!string.IsNullOrEmpty(startPath)) {
      try { dlg.SetFolder(Item(startPath)); } catch { }
    }
    return dlg;
  }

  /** Interop smoke check: builds the dialog and reads the start folder without showing it. */
  public static string Probe(string startPath) {
    IFileDialog dlg = Create(startPath);
    if (string.IsNullOrEmpty(startPath)) return "ready";
    IShellItem folder;
    dlg.GetFolder(out folder);
    string name;
    folder.GetDisplayName(SIGDN_FILESYSPATH, out name);
    return name;
  }

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

  [DllImport("user32.dll")]
  static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();

  [DllImport("kernel32.dll")]
  static extern uint GetCurrentThreadId();

  const uint GW_OWNER = 4;
  const uint SWP_NOSIZE = 0x1;
  const uint SWP_NOMOVE = 0x2;
  const uint SWP_NOZORDER = 0x4;
  const uint SWP_SHOWWINDOW = 0x40;
  const uint SPI_GETWORKAREA = 0x30;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const int WS_EX_APPWINDOW = 0x40000;
  const int SW_HIDE = 0;
  const byte VK_MENU = 0x12;
  const uint KEYEVENTF_KEYUP = 0x2;
  const int SW_SHOW = 5;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")]
  static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  static extern bool SystemParametersInfo(uint action, uint param, out RECT rect, uint winIni);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
  static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
  static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hWnd, int cmd);

  [DllImport("user32.dll")]
  static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);

  static void Log(string message) {
    // Debug output goes to a file: a killed child loses its stderr, and with it the only clue.
    string path = Environment.GetEnvironmentVariable("DCM_PICK_DEBUG");
    if (string.IsNullOrEmpty(path)) return;
    try { using (StreamWriter writer = File.AppendText(path)) { writer.WriteLine(message); } } catch { }
  }

  /**
   * The dialog is a #32770 window owned by this process. Ours is the only visible top-level
   * window here, but walk the class name first so a future console/helper window cannot win.
   */
  static IntPtr FindOwnDialog() {
    uint self = GetCurrentProcessId();
    IntPtr fallback = IntPtr.Zero;
    IntPtr dialog = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != self || !IsWindowVisible(h) || GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
      StringBuilder name = new StringBuilder(64);
      GetClassName(h, name, 64);
      if (name.ToString() == "#32770") { dialog = h; return false; }
      if (fallback == IntPtr.Zero) fallback = h;
      return true;
    }, IntPtr.Zero);
    return dialog != IntPtr.Zero ? dialog : fallback;
  }

  /**
   * IFileOpenDialog is created by a windowless helper process, so Windows gives it no owner and
   * remembers no position: it lands wherever the default puts it (often half under the taskbar)
   * and adds a second taskbar entry that the user has to click before the dialog is usable.
   * Fix all three here: drop the taskbar entry (WS_EX_TOOLWINDOW), center the dialog inside the
   * work area, keep it topmost, then borrow the foreground thread's input queue to activate it.
   */
  static void BringToFront() {
    for (int i = 0; i < 400; i++) {
      IntPtr h = FindOwnDialog();
      if (h != IntPtr.Zero) {
        Log("dialog hwnd=" + h.ToInt64().ToString() + " attempt=" + i.ToString());
        HideFromTaskbar(h);
        CenterOnWorkArea(h);
        Activate(h);
        bool top = SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        ShowWindow(h, SW_SHOW);
        Log("topmost=" + top.ToString() + " ex=0x" + GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64().ToString("X") + " prev=" + GetWindow(h, 3).ToInt64().ToString());
        return;
      }
      Thread.Sleep(50);
    }
    Log("dialog window never appeared");
  }

  /** Re-parent the dialog into the tool window band so it stops advertising itself as a new app. */
  static void HideFromTaskbar(IntPtr h) {
    try {
      IntPtr style = GetWindowLongPtr(h, GWL_EXSTYLE);
      long value = style.ToInt64() & ~(long)WS_EX_APPWINDOW | (long)WS_EX_TOOLWINDOW;
      SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(value));
      Log("exstyle=" + value.ToString());
    } catch (Exception error) {
      Log("exstyle failed: " + error.Message);
    }
  }

  /** Center inside the work area so the dialog never opens half under the taskbar. */
  static void CenterOnWorkArea(IntPtr h) {
    RECT window;
    RECT area;
    if (!GetWindowRect(h, out window)) return;
    if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out area, 0)) return;
    int width = window.Right - window.Left;
    int height = window.Bottom - window.Top;
    if (width <= 0 || height <= 0) return;
    int x = area.Left + (area.Right - area.Left - width) / 2;
    int y = area.Top + (area.Bottom - area.Top - height) / 2;
    SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW);
    Log("centered " + x.ToString() + "," + y.ToString() + " size=" + width.ToString() + "x" + height.ToString());
  }

  /** SetForegroundWindow can silently fail; retry with the input queue attached until it sticks. */
  static void Activate(IntPtr h) {
    // A background process has no input history, so SetForegroundWindow is refused silently; pulse Alt first to unlock it.
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    for (int i = 0; i < 20; i++) {
      uint pid;
      IntPtr front = GetForegroundWindow();
      if (front == h) { Log("activated attempt=" + i.ToString()); return; }
      uint fgThread = GetWindowThreadProcessId(front, out pid);
      uint selfThread = GetCurrentThreadId();
      bool attached = AttachThreadInput(selfThread, fgThread, true);
      bool done = SetForegroundWindow(h);
      AttachThreadInput(selfThread, fgThread, false);
      Log("activate attempt=" + i.ToString() + " attach=" + attached.ToString() + " ok=" + done.ToString() + " fg=" + GetForegroundWindow().ToInt64().ToString());
      if (GetForegroundWindow() == h) return;
      Thread.Sleep(100);
    }
    Log("activation never stuck; window stays topmost");
  }

  /** Shows the native picker: returns the path, or "CANCEL" / "ERR:<hr>". */
  public static string Show(string title, string startPath) {
    IFileDialog dlg = Create(startPath);
    if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
    Thread helper = new Thread(BringToFront);
    helper.IsBackground = true;
    helper.Start();
    int hr = dlg.Show(IntPtr.Zero);
    if (hr == unchecked((int)0x800704C7)) return "CANCEL";
    if (hr != 0) return "ERR:" + hr;
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    item.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
if ($env:DCM_PICK_PROBE -eq '1') {
  $probe = [DcmNativePick]::Probe($env:DCM_PICK_START)
  Write-Output ('PROBE:' + $probe)
  exit 0
}
$out = [DcmNativePick]::Show($env:DCM_PICK_TITLE, $env:DCM_PICK_START)
if ($out -eq 'CANCEL') { exit 2 }
if ($out.StartsWith('ERR:')) { [Console]::Error.WriteLine($out); exit 3 }
Write-Output $out
exit 0`

/** macOS：Finder 的标准选择面板；取消时 osascript 退出码 1。 */
const MAC_SCRIPT = `on run argv
  try
    set thePath to (POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))))
  on error number -128
    error number -128
  end try
  return thePath
end run`

/**
 * 子进程执行器：不经过 shell，纯 argv。
 *
 * `ENOENT` 必须和「退出码非 0」分开 —— 前者是**这台机器没有这个程序**（能力缺失 ⇒ 回落内置
 * 浏览器），后者是对话框自身出错（如实报告但仍回落）。两者混起来会让「Linux 没装 zenity」
 * 被当成失败弹红条。
 */
export function defaultSpawner(run: NativePickRun): Promise<NativePickExec> {
  return new Promise<NativePickExec>((resolve) => {
    let settled = false
    const finish = (value: NativePickExec): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(run.file, run.args, {
        env: { ...process.env, ...run.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      finish({ code: null, stdout: '', stderr: '', missing: true })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      // 超时也保留子进程已经吐出的 stderr：调试标志的日志全在那里，丢掉就无法定位。
      const tail = stderr.trim()
      finish({ code: null, stdout, stderr: tail === '' ? 'timed out' : `timed out\n${tail}`, missing: false })
    }, run.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish({ code: null, stdout, stderr, missing: error.code === 'ENOENT' })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      finish({ code, stdout, stderr, missing: false })
    })
  })
}

interface Attempt {
  file: string
  args: string[]
}

function win32Attempt(): Attempt {
  // -STA：PowerShell 7 默认 MTA，COM 模态对话框必须在 STA 线程里跑。
  return { file: 'powershell', args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT] }
}

function darwinAttempt(startPath: string, title: string): Attempt {
  return { file: 'osascript', args: ['-e', MAC_SCRIPT, title, startPath] }
}

/** Linux 候选：先 GTK（GNOME 系），再 KDE。两个都没有就是 unsupported。 */
function linuxAttempts(startPath: string, title: string): Attempt[] {
  return [
    { file: 'zenity', args: ['--file-selection', '--directory', '--title=' + title, '--filename=' + startPath] },
    { file: 'kdialog', args: ['--getexistingdirectory', startPath, '--title', title] },
  ]
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}

/**
 * 归一化用户选中的路径：剥掉多余的尾部分隔符（反斜杠或斜杠）。
 *
 * 两个必须原样保留的形状：Windows 盘符根与 POSIX 根 —— 盘符根剥掉尾部分隔符就成了相对路径，
 * POSIX 根剥掉就成了空串。其余尾分隔符一律去掉：映射表里带与不带尾分隔符的前缀会被当成两个
 * 不同前缀，用户看不出区别却导致漏映射。
 */
function normalizePickedPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const driveRoot = /^([A-Za-z]:)[\\/]+$/.exec(trimmed)
  if (driveRoot !== null) return `${driveRoot[1] as string}\\`
  const stripped = trimmed.replace(/[\\/]+$/, '')
  return stripped === '' ? trimmed : stripped
}

/**
 * 弹原生目录选择器。
 *
 * 返回三态：`ok`（用户选了）/ `canceled`（用户关了窗口）/ `unsupported`、`failed`（回落内置浏览器）。
 * 绝不让「对话框不可用」变成用户的操作死路。
 */
export async function pickNativeDirectory(options: NativePickOptions = {}): Promise<NativePickResult> {
  const platform = options.platform ?? process.platform
  const spawner = options.spawner ?? defaultSpawner
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const title = options.title !== undefined && options.title !== '' ? options.title : 'Select folder'
  const startPath = options.startPath !== undefined ? options.startPath : ''

  const env: Record<string, string> = { [PICK_ENV_START]: startPath, [PICK_ENV_TITLE]: title }

  if (platform === 'win32') {
    const exec = await spawner({ ...win32Attempt(), env, timeoutMs })
    if (exec.missing) return { ok: false, reason: 'unsupported', detail: 'powershell not found' }
    if (exec.code === 2) return { ok: false, reason: 'canceled' }
    if (exec.code !== 0) {
      return { ok: false, reason: 'failed', detail: firstLine(exec.stderr) || `exit ${String(exec.code)}` }
    }
    const path = normalizePickedPath(firstLine(exec.stdout))
    return path === '' ? { ok: false, reason: 'canceled' } : { ok: true, path }
  }

  if (platform === 'darwin') {
    const exec = await spawner({ ...darwinAttempt(startPath, title), env, timeoutMs })
    if (exec.missing) return { ok: false, reason: 'unsupported', detail: 'osascript not found' }
    if (exec.code !== 0) {
      // osascript 的「用户取消」= error number -128，统一表现在 stderr 里。
      if (/[-]128/.test(exec.stderr) || exec.code === 1) return { ok: false, reason: 'canceled' }
      return { ok: false, reason: 'failed', detail: firstLine(exec.stderr) || `exit ${String(exec.code)}` }
    }
    const path = normalizePickedPath(firstLine(exec.stdout))
    return path === '' ? { ok: false, reason: 'canceled' } : { ok: true, path }
  }

  if (platform === 'linux') {
    const attempts = linuxAttempts(startPath, title)
    for (const attempt of attempts) {
      const exec = await spawner({ ...attempt, env, timeoutMs })
      if (exec.missing) continue // 没装这个工具，换下一个
      if (exec.code === 1) return { ok: false, reason: 'canceled' }
      if (exec.code !== 0) {
        return { ok: false, reason: 'failed', detail: firstLine(exec.stderr) || `exit ${String(exec.code)}` }
      }
      const path = normalizePickedPath(firstLine(exec.stdout))
      return path === '' ? { ok: false, reason: 'canceled' } : { ok: true, path }
    }
    return { ok: false, reason: 'unsupported', detail: 'neither zenity nor kdialog found' }
  }

  return { ok: false, reason: 'unsupported', detail: `platform ${platform}` }
}
