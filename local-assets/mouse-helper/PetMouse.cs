using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

class PetMouse
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const byte VK_CONTROL = 0x11;
    const byte VK_V = 0x56;

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            // Per-Monitor V2：SetCursorPos 使用物理像素，避免高 DPI 偏移
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            string command = args.Length > 0 ? args[0].ToLowerInvariant() : "move";
            int x = 0, y = 0;
            if (args.Length > 1) int.TryParse(args[1], out x);
            if (args.Length > 2) int.TryParse(args[2], out y);

            if (command == "move" || command == "moveclick" || command == "moverightclick")
            {
                if (!SetCursorPos(x, y)) return 2;
            }
            if (command == "click" || command == "moveclick")
            {
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            }
            if (command == "rightclick" || command == "moverightclick")
            {
                mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
                mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
            }
            if (command == "is-editable")
            {
                Console.Out.Write(IsFocusedEditable() ? "1" : "0");
                Console.Out.Flush();
            }
            if (command == "text")
            {
                if (args.Length < 2) return 3;
                string text = Encoding.UTF8.GetString(Convert.FromBase64String(args[1]));
                if (text.Length == 0) return 0;
                string oldClipboard = null;
                try { if (Clipboard.ContainsText()) oldClipboard = Clipboard.GetText(); } catch { }
                Clipboard.SetText(text);
                Thread.Sleep(30);
                keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                keybd_event(VK_V, 0, 0, UIntPtr.Zero);
                keybd_event(VK_V, 0, 2, UIntPtr.Zero);
                keybd_event(VK_CONTROL, 0, 2, UIntPtr.Zero);
                Thread.Sleep(450);
                for (int i = 0; i < 3; i++)
                {
                    try
                    {
                        if (Clipboard.ContainsText() && Clipboard.GetText() == text && !string.IsNullOrEmpty(oldClipboard))
                        {
                            Clipboard.SetText(oldClipboard);
                            break;
                        }
                    }
                    catch { }
                    Thread.Sleep(120);
                }
            }
            return 0;
        }
        catch (Exception err)
        {
            Console.Error.WriteLine(err.Message);
            return 1;
        }
    }

    static bool IsFocusedEditable()
    {
        try
        {
            var el = AutomationElement.FocusedElement;
            if (el == null) return false;
            var current = el.Current;
            var ct = current.ControlType;
            bool editLike = ct == ControlType.Edit || ct == ControlType.Document || ct == ControlType.ComboBox;
            if (!editLike || !current.IsEnabled || !current.IsKeyboardFocusable) return false;
            try
            {
                var vp = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
                if (vp != null && !vp.Current.IsReadOnly) return true;
            }
            catch { }
            try
            {
                el.GetCurrentPattern(TextPattern.Pattern);
                return true;
            }
            catch { }
            return ct == ControlType.Edit || ct == ControlType.Document;
        }
        catch
        {
            return false;
        }
    }
}
