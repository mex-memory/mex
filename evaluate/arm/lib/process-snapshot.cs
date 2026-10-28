using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

// Toolhelp works without the WMI service or administrative CIM permissions.
public static class EvalProcessSnapshot {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry {
        public uint size, usage, pid;
        public IntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }
    public class Row {
        public uint ProcessId, ParentProcessId;
        public long WorkingSetSize;
        public string CommandLine;
        public bool RssUnavailable;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    public static Row[] Read() {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        var rows = new List<Row>();
        try {
            Entry entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
            if (!Process32FirstW(snapshot, ref entry)) throw new System.ComponentModel.Win32Exception();
            do {
                var row = new Row { ProcessId = entry.pid, ParentProcessId = entry.parent, CommandLine = entry.executable };
                try { using (Process p = Process.GetProcessById((int)entry.pid)) { if (p.HasExited) continue; row.WorkingSetSize = p.WorkingSet64; } }
                catch (ArgumentException) { continue; } // Exited since the Toolhelp snapshot.
                catch (InvalidOperationException) { continue; }
                catch { row.RssUnavailable = true; }
                rows.Add(row);
            } while (Process32NextW(snapshot, ref entry));
        } finally { CloseHandle(snapshot); }
        return rows.ToArray();
    }
}
