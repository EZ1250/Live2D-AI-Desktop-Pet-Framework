using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

/// <summary>
/// PetUi：桌宠内置 Windows 电脑控制助手（不依赖 DSH 插件）。
/// 用法（参数尽量 base64，避免空格/中文/引号问题）：
///   PetUi.exe windows &lt;filterB64&gt; &lt;limit&gt;
///   PetUi.exe tree &lt;hwnd&gt; &lt;depth&gt; &lt;maxNodes&gt;
///   PetUi.exe find &lt;hwnd&gt; &lt;nameB64&gt; &lt;controlType&gt; &lt;automationIdB64&gt; &lt;classNameB64&gt; &lt;index&gt; &lt;limit&gt;
///   PetUi.exe focus &lt;hwnd&gt; &lt;nameB64&gt; &lt;controlType&gt; &lt;automationIdB64&gt; &lt;classNameB64&gt; &lt;index&gt;
///   PetUi.exe setvalue &lt;hwnd&gt; ...selector... &lt;valueB64&gt;
///   PetUi.exe activate &lt;hwnd&gt;
///   PetUi.exe click &lt;hwnd&gt; ...selector... &lt;button&gt;
/// 输出：UTF-8 JSON（{ ok:true, data:... } 或 { ok:false, error:... }）
/// </summary>
class PetUi
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    const int SW_RESTORE = 9;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            if (args.Length == 0) return Fail("缺少命令");
            string cmd = args[0].ToLowerInvariant();
            switch (cmd)
            {
                case "windows": return Ok(ListWindows(Decode(args, 1), Int(args, 2, 100)));
                case "tree": return Ok(TreeWindow(Int(args, 1, 0), Math.Max(0, Int(args, 2, 4)), Math.Max(1, Int(args, 3, 800))));
                case "find": return Ok(FindElements(Int(args, 1, 0), args, 2, Int(args, 7, 20)));
                case "focus": return Ok(FocusElement(Int(args, 1, 0), args, 2));
                case "setvalue": return Ok(SetValue(Int(args, 1, 0), args, 2, Decode(args, 7)));
                case "activate": return Ok(Activate(Int(args, 1, 0)));
                case "click": return Ok(Click(Int(args, 1, 0), args, 2, args.Length > 7 ? args[7] : "left"));
                default: return Fail("未知命令：" + cmd);
            }
        }
        catch (Exception err)
        {
            return Fail(err.Message);
        }
    }

    static int Ok(string data)
    {
        Console.Out.Write("{\"ok\":true,\"data\":" + data + "}");
        Console.Out.Flush();
        return 0;
    }
    static int Fail(string error)
    {
        Console.Out.Write("{\"ok\":false,\"error\":" + Q(error) + "}");
        Console.Out.Flush();
        return 1;
    }
    static string Decode(string[] args, int i)
    {
        if (args.Length <= i || string.IsNullOrEmpty(args[i])) return "";
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(args[i])); }
        catch { return args[i]; }
    }
    static int Int(string[] args, int i, int fallback)
    {
        int v;
        return args.Length > i && int.TryParse(args[i], out v) ? v : fallback;
    }
    static string Q(string s)
    {
        if (s == null) return "null";
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': b.Append("\\\\"); break;
                case '"': b.Append("\\\""); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 32) b.Append("\\u" + ((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.Append('"').ToString();
    }
    static string RectJson(System.Windows.Rect r)
    {
        return "{\"x\":" + Num(r.X) + ",\"y\":" + Num(r.Y) + ",\"w\":" + Num(r.Width) + ",\"h\":" + Num(r.Height) + "}";
    }
    static string Num(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? "0" : Math.Round(v).ToString(); }

    static string ListWindows(string filter, int limit)
    {
        var sb = new StringBuilder("[");
        int n = 0;
        var focused = GetForegroundWindow();
        EnumWindows((hwnd, lparam) =>
        {
            try
            {
                if (!IsWindowVisible(hwnd)) return true;
                var title = new StringBuilder(512);
                GetWindowText(hwnd, title, title.Capacity);
                if (title.Length == 0) return true;
                if (!string.IsNullOrEmpty(filter) && title.ToString().IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) return true;
                var cls = new StringBuilder(256);
                GetClassName(hwnd, cls, cls.Capacity);
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                RECT r;
                GetWindowRect(hwnd, out r);
                if (n > 0) sb.Append(',');
                sb.Append("{\"hwnd\":").Append(hwnd.ToInt64())
                  .Append(",\"title\":").Append(Q(title.ToString()))
                  .Append(",\"className\":").Append(Q(cls.ToString()))
                  .Append(",\"pid\":").Append(pid)
                  .Append(",\"active\":").Append(hwnd == focused ? "true" : "false")
                  .Append(",\"bounds\":{\"x\":").Append(r.Left)
                  .Append(",\"y\":").Append(r.Top)
                  .Append(",\"w\":").Append(Math.Max(0, r.Right - r.Left))
                  .Append(",\"h\":").Append(Math.Max(0, r.Bottom - r.Top)).Append("}}");
                n++;
            }
            catch { }
            return n < limit;
        }, IntPtr.Zero);
        return sb.Append(']').ToString();
    }

    static AutomationElement Window(int hwnd)
    {
        if (hwnd == 0) throw new Exception("缺少窗口 hwnd");
        if (!IsWindow(new IntPtr(hwnd))) throw new Exception("窗口已关闭");
        return AutomationElement.FromHandle(new IntPtr(hwnd));
    }

    static string TreeWindow(int hwnd, int depth, int maxNodes)
    {
        var root = Window(hwnd);
        var sb = new StringBuilder("[");
        int count = 0;
        Walk(root, 0, depth, maxNodes, ref count, sb);
        return sb.Append(']').ToString();
    }

    static void Walk(AutomationElement el, int depth, int maxDepth, int maxNodes, ref int count, StringBuilder sb)
    {
        if (count >= maxNodes) return;
        try
        {
            var c = el.Current;
            if (count > 0) sb.Append(',');
            sb.Append("{\"depth\":").Append(depth)
              .Append(",\"name\":").Append(Q(c.Name ?? ""))
              .Append(",\"type\":").Append(Q(c.ControlType.ProgrammaticName.Replace("ControlType.", "")))
              .Append(",\"automationId\":").Append(Q(c.AutomationId ?? ""))
              .Append(",\"className\":").Append(Q(c.ClassName ?? ""))
              .Append(",\"enabled\":").Append(c.IsEnabled ? "true" : "false")
              .Append(",\"focused\":").Append(c.HasKeyboardFocus ? "true" : "false")
              .Append(",\"bounds\":").Append(RectJson(c.BoundingRectangle)).Append('}');
            count++;
        }
        catch { return; }
        if (depth >= maxDepth) return;
        AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(el);
        while (child != null && count < maxNodes)
        {
            Walk(child, depth + 1, maxDepth, maxNodes, ref count, sb);
            child = TreeWalker.ControlViewWalker.GetNextSibling(child);
        }
    }

    static bool Match(AutomationElement el, string name, string type, string automationId, string className)
    {
        try
        {
            var c = el.Current;
            if (!string.IsNullOrEmpty(name) && !(c.Name ?? "").Equals(name, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.IsNullOrEmpty(type))
            {
                var actual = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
                if (!actual.Equals(type, StringComparison.OrdinalIgnoreCase)) return false;
            }
            if (!string.IsNullOrEmpty(automationId) && !(c.AutomationId ?? "").Equals(automationId, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.IsNullOrEmpty(className) && !(c.ClassName ?? "").Equals(className, StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }
        catch { return false; }
    }

    static string ElementJson(AutomationElement el)
    {
        var c = el.Current;
        bool invoke = false, value = false, scroll = false, toggle = false, text = false;
        try { invoke = el.GetCurrentPattern(InvokePattern.Pattern) != null; } catch { }
        try { value = el.GetCurrentPattern(ValuePattern.Pattern) != null; } catch { }
        try { scroll = el.GetCurrentPattern(ScrollPattern.Pattern) != null; } catch { }
        try { toggle = el.GetCurrentPattern(TogglePattern.Pattern) != null; } catch { }
        try { text = el.GetCurrentPattern(TextPattern.Pattern) != null; } catch { }
        return "{\"name\":" + Q(c.Name ?? "") +
               ",\"type\":" + Q(c.ControlType.ProgrammaticName.Replace("ControlType.", "")) +
               ",\"automationId\":" + Q(c.AutomationId ?? "") +
               ",\"className\":" + Q(c.ClassName ?? "") +
               ",\"enabled\":" + (c.IsEnabled ? "true" : "false") +
               ",\"focused\":" + (c.HasKeyboardFocus ? "true" : "false") +
               ",\"bounds\":" + RectJson(c.BoundingRectangle) +
               ",\"patterns\":{\"invoke\":" + (invoke ? "true" : "false") +
               ",\"value\":" + (value ? "true" : "false") +
               ",\"scroll\":" + (scroll ? "true" : "false") +
               ",\"toggle\":" + (toggle ? "true" : "false") +
               ",\"text\":" + (text ? "true" : "false") + "}}";
    }

    static string FindElements(int hwnd, string[] args, int start, int limit)
    {
        var root = Window(hwnd);
        string name = Decode(args, start), type = args.Length > start + 1 ? args[start + 1] : "";
        string automationId = Decode(args, start + 2), className = Decode(args, start + 3);
        int index = Int(args, start + 4, 0);
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        var sb = new StringBuilder("[");
        int matched = 0, output = 0;
        foreach (AutomationElement el in all)
        {
            if (!Match(el, name, type, automationId, className)) continue;
            if (matched++ < index) continue;
            if (output > 0) sb.Append(',');
            sb.Append(ElementJson(el));
            if (++output >= limit) break;
        }
        return sb.Append(']').ToString();
    }

    static AutomationElement First(int hwnd, string[] args, int start)
    {
        var root = Window(hwnd);
        string name = Decode(args, start), type = args.Length > start + 1 ? args[start + 1] : "";
        string automationId = Decode(args, start + 2), className = Decode(args, start + 3);
        int index = Int(args, start + 4, 0);
        int matched = 0;
        foreach (AutomationElement el in root.FindAll(TreeScope.Descendants, Condition.TrueCondition))
        {
            if (!Match(el, name, type, automationId, className)) continue;
            if (matched++ >= index) return el;
        }
        throw new Exception("未找到匹配控件");
    }

    static string FocusElement(int hwnd, string[] args, int start)
    {
        var el = First(hwnd, args, start);
        SetForegroundWindow(new IntPtr(hwnd));
        el.SetFocus();
        return "{\"focused\":true}";
    }

    static string SetValue(int hwnd, string[] args, int start, string value)
    {
        var el = First(hwnd, args, start);
        var vp = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
        if (vp == null || vp.Current.IsReadOnly) throw new Exception("控件不支持写入");
        vp.SetValue(value);
        return "{\"ok\":true}";
    }

    static string Activate(int hwnd)
    {
        if (!IsWindow(new IntPtr(hwnd))) throw new Exception("窗口已关闭");
        ShowWindow(new IntPtr(hwnd), SW_RESTORE);
        bool ok = SetForegroundWindow(new IntPtr(hwnd));
        return "{\"activated\":" + (ok ? "true" : "false") + "}";
    }

    static string Click(int hwnd, string[] args, int start, string button)
    {
        var el = First(hwnd, args, start);
        try
        {
            var ip = (InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern);
            if (ip != null) { ip.Invoke(); return "{\"clicked\":true,\"mode\":\"invoke\"}"; }
        }
        catch { }
        SetForegroundWindow(new IntPtr(hwnd));
        el.SetFocus();
        var r = el.Current.BoundingRectangle;
        int x = (int)Math.Round(r.X + r.Width / 2), y = (int)Math.Round(r.Y + r.Height / 2);
        SetCursorPos(x, y);
        uint down = button.Equals("right", StringComparison.OrdinalIgnoreCase) ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = button.Equals("right", StringComparison.OrdinalIgnoreCase) ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero);
        return "{\"clicked\":true,\"mode\":\"mouse\",\"x\":" + x + ",\"y\":" + y + "}";
    }
}
