using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class CastCap
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    static void Main(string[] args)
    {
        // Per-Monitor V2：让 Screen.Bounds 返回物理像素，避免 DPI 虚拟化只抓到左上角/缩放不完整
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        int width = args.Length > 0 ? int.Parse(args[0]) : 1280;
        int fps = args.Length > 1 ? int.Parse(args[1]) : 24;
        int quality = args.Length > 2 ? int.Parse(args[2]) : 65;
        int seconds = args.Length > 3 ? int.Parse(args[3]) : 5;
        int displayIndex = args.Length > 4 ? int.Parse(args[4]) : 1;
        try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.AboveNormal; } catch { }
        var screens = System.Windows.Forms.Screen.AllScreens;
        var screen = (displayIndex >= 1 && displayIndex <= screens.Length) ? screens[displayIndex - 1] : System.Windows.Forms.Screen.PrimaryScreen;
        Rectangle bounds = screen.Bounds;
        int srcW = bounds.Width;
        int srcH = bounds.Height;
        int outH = (int)Math.Round(srcH * (width / (double)srcW));
        using (var full = new Bitmap(srcW, srcH))
        using (var fullG = Graphics.FromImage(full))
        using (var output = new Bitmap(width, outH))
        using (var outG = Graphics.FromImage(output))
        using (var stream = Console.OpenStandardOutput())
        using (var ms = new MemoryStream(512 * 1024))
        {
            outG.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Low;
            outG.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
            var codec = FindJpegCodec();
            var encParams = new EncoderParameters(1);
            encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            var sw = Stopwatch.StartNew();
            double frameMs = 1000.0 / fps;
            int count = 0;
            while (sw.Elapsed.TotalSeconds < seconds)
            {
                double frameStart = sw.Elapsed.TotalMilliseconds;
                fullG.CopyFromScreen(bounds.X, bounds.Y, 0, 0, new Size(srcW, srcH));
                outG.DrawImage(full, 0, 0, width, outH);
                ms.SetLength(0);
                output.Save(ms, codec, encParams);
                int length = (int)ms.Length;
                byte[] len = BitConverter.GetBytes(length);
                stream.Write(len, 0, 4);
                stream.Write(ms.GetBuffer(), 0, length);
                stream.Flush();
                count++;
                double cost = sw.Elapsed.TotalMilliseconds - frameStart;
                double wait = frameMs - cost;
                if (wait > 0) Thread.Sleep((int)wait);
            }
            Console.Error.WriteLine("frames=" + count + " elapsed=" + sw.Elapsed.TotalSeconds.ToString("F2") + " fps=" + (count / sw.Elapsed.TotalSeconds).ToString("F1") + " src=" + srcW + "x" + srcH + " out=" + width + "x" + outH + " display=" + displayIndex);
        }
    }

    static ImageCodecInfo FindJpegCodec()
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") return c;
        throw new Exception("no jpeg codec");
    }
}
