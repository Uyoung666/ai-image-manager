$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class StandardReleaseUser {
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAttributes {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr Process, Thread;
        public int Pid, ThreadId;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existing, uint flags, uint count, ref SidAttributes disabled,
        uint deleteCount, IntPtr deleted, uint restrictCount, IntPtr restrictions,
        out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(
        IntPtr token, int kind, ref SidAttributes value, int length);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token, int kind, IntPtr value, int size, out int length);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string system, string name, out long privilege);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(
        IntPtr token, string file, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string cwd, ref StartupInfo startup, out ProcessInfo process);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithTokenW(
        IntPtr token, uint logonFlags, string file, StringBuilder command,
        uint flags, IntPtr environment, string cwd, ref StartupInfo startup,
        out ProcessInfo process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetEnvironmentStringsW();

    [DllImport("kernel32.dll")]
    private static extern bool FreeEnvironmentStringsW(IntPtr environment);

    private const int Integrity = 25;
    private const int Privileges = 3;

    private static void Require(bool result) {
        if (!result) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static void Require(bool result, string operation) {
        if (!result) {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, operation + ": " + new Win32Exception(error).Message);
        }
    }

    private static byte[] BinarySid(string value) {
        SecurityIdentifier sid = new SecurityIdentifier(value);
        byte[] bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static void VerifyToken(IntPtr token) {
        using (WindowsIdentity identity = new WindowsIdentity(token)) {
            WindowsPrincipal principal = new WindowsPrincipal(identity);
            if (principal.IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("Effective administrator SID is enabled");
        }
        int size;
        GetTokenInformation(token, Integrity, IntPtr.Zero, 0, out size);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Require(GetTokenInformation(token, Integrity, buffer, size, out size), "Read token integrity");
            if (new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value != "S-1-16-8192")
                throw new InvalidOperationException("Expected Medium integrity");
        } finally { Marshal.FreeHGlobal(buffer); }
        // UAC can still report an elevated origin for a filtered runner token.
        // Validate its actual privileges, groups, integrity and write access.
        VerifyPrivileges(token);
    }

    private static void VerifyPrivileges(IntPtr token) {
        long traverse;
        Require(LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out traverse), "Look up traverse privilege");
        int size;
        GetTokenInformation(token, Privileges, IntPtr.Zero, 0, out size);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Require(GetTokenInformation(token, Privileges, buffer, size, out size), "Read token privileges");
            int count = Marshal.ReadInt32(buffer);
            if (count > 1 || (count == 1 && Marshal.ReadInt64(buffer, sizeof(int)) != traverse))
                throw new InvalidOperationException("Unexpected effective privileges on application token");
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    public static void VerifyProcess(int pid) {
        using (Process process = Process.GetProcessById(pid)) {
            IntPtr token;
            Require(OpenProcessToken(process.Handle, 8, out token));
            try { VerifyToken(token); } finally { CloseHandle(token); }
        }
    }

    private static void ProbeWrite(string directory) {
        string probe = Path.Combine(directory, ".aim-release-probe-" + Guid.NewGuid());
        using (File.Create(probe, 1, FileOptions.DeleteOnClose)) {}
    }

    private static void VerifyMsiAccess(IntPtr token, string root) {
        using (WindowsImpersonationContext standard = WindowsIdentity.Impersonate(token)) {
            ProbeWrite(root);
            try { ProbeWrite(Path.GetDirectoryName(root)); }
            catch (UnauthorizedAccessException) { return; }
            throw new InvalidOperationException("MSI parent is writable by the test user");
        }
    }

    public static int Start(string file, string arguments, string msiRoot) {
        GCHandle admin = GCHandle.Alloc(BinarySid("S-1-5-32-544"), GCHandleType.Pinned);
        byte[] mediumSid = BinarySid("S-1-16-8192");
        GCHandle medium = GCHandle.Alloc(mediumSid, GCHandleType.Pinned);
        IntPtr token = IntPtr.Zero;
        try {
            using (WindowsIdentity runner = WindowsIdentity.GetCurrent()) {
                SidAttributes disabled = new SidAttributes { Sid = admin.AddrOfPinnedObject() };
                Require(CreateRestrictedToken(runner.Token, 1, 1, ref disabled,
                    0, IntPtr.Zero, 0, IntPtr.Zero, out token), "CreateRestrictedToken");
            }
            SidAttributes label = new SidAttributes { Sid = medium.AddrOfPinnedObject(), Attributes = 0x20 };
            Require(SetTokenInformation(token, Integrity, ref label,
                Marshal.SizeOf(typeof(SidAttributes)) + mediumSid.Length), "SetTokenInformation");
            VerifyToken(token);
            if (!String.IsNullOrEmpty(msiRoot)) VerifyMsiAccess(token, msiRoot);
            StartupInfo startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)) };
            ProcessInfo process;
            string command = "\"" + file + "\" " + arguments;
            bool started = CreateProcessAsUser(token, file, new StringBuilder(command),
                IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Path.GetDirectoryName(file),
                ref startup, out process);
            if (!started && Marshal.GetLastWin32Error() == 1314) {
                // Both APIs receive the same restricted token. This fallback covers
                // runners with impersonation rights but no process quota privilege.
                IntPtr environment = GetEnvironmentStringsW();
                if (environment == IntPtr.Zero)
                    throw new InvalidOperationException("Could not keep the isolated test environment");
                try {
                    Require(CreateProcessWithTokenW(token, 0, file, new StringBuilder(command),
                        0x400, environment, Path.GetDirectoryName(file), ref startup, out process),
                        "CreateProcessWithTokenW");
                } finally {
                    FreeEnvironmentStringsW(environment);
                }
            } else {
                Require(started, "CreateProcessAsUser");
            }
            CloseHandle(process.Thread);
            CloseHandle(process.Process);
            return process.Pid;
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token);
            medium.Free();
            admin.Free();
        }
    }
}
'@

if ($env:AIM_STANDARD_VERIFY_PID) {
    [StandardReleaseUser]::VerifyProcess([int]$env:AIM_STANDARD_VERIFY_PID)
} else {
    $processId = [StandardReleaseUser]::Start(
        $env:AIM_STANDARD_EXECUTABLE,
        $env:AIM_STANDARD_ARGUMENTS,
        $env:AIM_STANDARD_MSI_ROOT
    )
    Write-Output $processId
    $process = [Diagnostics.Process]::GetProcessById($processId)
    try {
        $process.WaitForExit()
        exit $process.ExitCode
    } finally {
        $process.Dispose()
    }
}
