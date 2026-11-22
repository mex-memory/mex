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
    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
        public ushort Length, Capacity;
        public IntPtr Buffer;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(
        IntPtr process, int infoClass, IntPtr buffer, int bufferLength, out int length);

    // Distinguish the Node hook fallback from other Node children.
    private static string ReadCommandLine(uint pid, string fallback) {
        const int commandLineInformation = 60;
        const uint queryLimitedInformation = 0x1000;
        IntPtr process = OpenProcess(queryLimitedInformation, false, pid);
        if (process == IntPtr.Zero) return fallback;
        try {
            int length;
            NtQueryInformationProcess(process, commandLineInformation, IntPtr.Zero, 0, out length);
            if (length < Marshal.SizeOf(typeof(UnicodeString)) || length > 128 * 1024) return fallback;
            IntPtr memory = Marshal.AllocHGlobal(length);
            try {
                int returned;
                if (NtQueryInformationProcess(process, commandLineInformation, memory, length, out returned) != 0) return fallback;
                var value = (UnicodeString)Marshal.PtrToStructure(memory, typeof(UnicodeString));
                long offset = value.Buffer.ToInt64() - memory.ToInt64();
                if (value.Length == 0 || offset < 0 || offset + value.Length > length) return fallback;
                return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            } finally { Marshal.FreeHGlobal(memory); }
        } finally { CloseHandle(process); }
    }
    public static Row[] Read() {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        var rows = new List<Row>();
        try {
            Entry entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
            if (!Process32FirstW(snapshot, ref entry)) throw new System.ComponentModel.Win32Exception();
            do {
                var row = new Row { ProcessId = entry.pid, ParentProcessId = entry.parent, CommandLine = ReadCommandLine(entry.pid, entry.executable) };
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
