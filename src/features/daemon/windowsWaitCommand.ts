import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';
import { resolveSystem32ExecutablePathAsync, resolveWindowsPowerShellExecutablePathAsync } from '../../shared/utils/executable-path-async.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import type { WaitCommandExit, WaitCommandProcess, WaitCommandStop } from './waitCommandProcess.js';

// Add-Type の入力は stdin で渡し、Windows のコマンドライン長上限にソースを加算しない。
const bootstrap = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))
  $shell = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
  $command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
  [TaktWaitJob]::Run($shell, $command)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

// Job handle は supervisor だけが保持する。libuv の Job は SILENT_BREAKAWAY_OK を
// 設定するため、stdio を閉じた子孫の所有には使えない。
const jobSource = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class TaktWaitJob {
  const uint CREATE_SUSPENDED = 0x4;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const int JobObjectBasicAccountingInformation = 1;
  const int JobObjectBasicProcessIdList = 3;
  const int JobObjectExtendedLimitInformation = 9;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_TIMEOUT = 258;
  const uint PROCESS_TERMINATE = 1;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint SYNCHRONIZE = 0x00100000;
  const int ERROR_ACCESS_DENIED = 5;
  const int ERROR_INVALID_PARAMETER = 87;
  const int ERROR_MORE_DATA = 234;

  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int Length;
    public IntPtr Descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
    public ushort ShowWindow, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] static extern bool QueryProcessIds(IntPtr job, int infoClass, IntPtr info, int size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool succeeded, string operation) {
    if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static uint ActiveProcesses(IntPtr job) {
    Accounting info;
    Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
    return info.ActiveProcesses;
  }
  sealed class StopEvidence {
    public string Stopped;
    public bool JobAttempted;
    public bool CloseAttempted;
    bool jobCodeObserved;
    uint jobProcessCount;
    // 一致は自然終了でも起こり得るため、停止の証拠には使わない。
    public const uint JobCode = 0xe0000001;
    public readonly HashSet<IntPtr> JobTargets = new HashSet<IntPtr>();

    public void BeforeJobSnapshot(IntPtr job) {
      if (JobAttempted) return;
      Accounting info;
      Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Query Job before stop");
      jobProcessCount = info.TotalProcesses;
    }

    public void RetainLiveTarget(IntPtr target) {
      if (target == IntPtr.Zero) return;
      uint state = WaitForSingleObject(target, 0);
      if (state == 0) return;
      Check(state == WAIT_TIMEOUT, "WaitForSingleObject before Job stop");
      JobTargets.Add(target);
    }

    public void ObserveExit(IntPtr target) {
      if (!JobTargets.Contains(target)) return;
      uint exited;
      Check(GetExitCodeProcess(target, out exited), "Get stopped process exit code");
      if (exited == JobCode) jobCodeObserved = true;
      JobTargets.Remove(target);
    }

    public bool CanComplete(IntPtr job) {
      if (Stopped != null) return true;
      if (CloseAttempted || jobCodeObserved) return false;
      if (!JobAttempted) return true;
      Accounting info;
      Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Query completed Job accounting");
      // 停止時の列挙から漏れた子孫の終了原因も、自然終了と推測しない。
      return jobProcessCount == info.TotalProcesses;
    }
  }
  static void ReadLeaderExit(ref ProcessInformation process, ref uint? code, bool wait, StopEvidence evidence) {
    if (process.Process == IntPtr.Zero) return;
    uint result = WaitForSingleObject(process.Process, wait ? INFINITE : 0);
    if (!wait && result == WAIT_TIMEOUT) return;
    Check(result == 0, "WaitForSingleObject");
    uint exited;
    Check(GetExitCodeProcess(process.Process, out exited), "GetExitCodeProcess");
    code = exited;
    evidence.ObserveExit(process.Process);
    // 終了コードを保存して参照を解放し、Job の終了集計を妨げない。
    Check(CloseHandle(process.Process), "Close leader process");
    process.Process = IntPtr.Zero;
  }

  static uint[] ProcessIds(IntPtr job) {
    int capacity = 16;
    while (true) {
      int size = checked(8 + IntPtr.Size * capacity);
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        bool success = QueryProcessIds(job, JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero);
        int error = Marshal.GetLastWin32Error();
        if (!success) {
          if (error != ERROR_MORE_DATA) throw new Win32Exception(error, "QueryProcessIds");
          capacity = checked(capacity * 2);
          continue;
        }
        int assigned = Marshal.ReadInt32(buffer);
        int count = Marshal.ReadInt32(buffer, 4);
        if (count < assigned) { capacity = assigned; continue; }
        uint[] ids = new uint[count];
        for (int i = 0; i < count; i++) ids[i] = unchecked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
        return ids;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }

  static bool StopProcess(IntPtr target) {
    uint state = WaitForSingleObject(target, 0);
    if (state == 0) return false;
    Check(state == WAIT_TIMEOUT, "WaitForSingleObject before stop");
    // TerminateJobObject の成功は空の Job でも返る。プロセス単位の停止なら、
    // 自然終了が先行した場合は ERROR_ACCESS_DENIED となり停止成功と区別できる。
    bool terminated = TerminateProcess(target, 1);
    if (!terminated) {
      int error = Marshal.GetLastWin32Error();
      if (error != ERROR_ACCESS_DENIED || WaitForSingleObject(target, 0) != 0) throw new Win32Exception(error, "TerminateProcess");
    }
    return terminated;
  }

  static bool RetainMember(IntPtr job, uint id, uint leader, Dictionary<uint, IntPtr> members) {
    if (id == leader || (members.ContainsKey(id) && members[id] != IntPtr.Zero)) return true;
    // 取得失敗後に列挙から消えても、未確認の PID を忘れず再試行する。
    members[id] = IntPtr.Zero;
    // 停止権限が拒否されても、Job fallback 後の終了待機は必要。
    IntPtr target = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, id);
    if (target == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == ERROR_INVALID_PARAMETER) { members.Remove(id); return false; } // process object は既に消滅した。
      throw new Win32Exception(error, "Open member process");
    }
    try {
      bool belongs;
      Check(IsProcessInJob(target, job, out belongs), "IsProcessInJob member");
      if (!belongs) { members.Remove(id); return false; }
      members[id] = target;
      target = IntPtr.Zero;
      return true;
    } finally { if (target != IntPtr.Zero) CloseHandle(target); }
  }

  static void RetainMembers(IntPtr job, uint leader, Dictionary<uint, IntPtr> members) {
    foreach (uint id in ProcessIds(job)) RetainMember(job, id, leader, members);
  }

  static bool TreeExited(IntPtr job, Dictionary<uint, IntPtr> members,
      ref ProcessInformation process, ref uint? code, StopEvidence evidence) {
    RetainMembers(job, process.Process == IntPtr.Zero ? 0 : process.ProcessId, members);
    ReadLeaderExit(ref process, ref code, false, evidence);
    foreach (uint id in new List<uint>(members.Keys)) {
      if (members[id] == IntPtr.Zero && !RetainMember(job, id, 0, members)) continue;
      uint state = WaitForSingleObject(members[id], 0);
      if (state == WAIT_TIMEOUT) continue;
      Check(state == 0, "WaitForSingleObject member");
      evidence.ObserveExit(members[id]);
      // 終了を確認した参照は先に解放する。参照が Job の集計を遅らせる場合もある。
      Check(CloseHandle(members[id]), "Close member process");
      members.Remove(id);
    }
    // ActiveProcesses == 0 と process handle の終了シグナルは別の条件。
    return ActiveProcesses(job) == 0 && members.Count == 0 && process.Process == IntPtr.Zero;
  }

  static void StopProcesses(IntPtr job, uint leader, Dictionary<uint, IntPtr> members, string reason, StopEvidence evidence) {
    foreach (uint id in ProcessIds(job)) {
      // この列挙で初めて見えた子孫も、停止する前に待機用 handle を固定する。
      if (!RetainMember(job, id, leader, members)) continue;
      // PID の再利用で別のプロセスを止めないよう、handle を固定して所属を確認する。
      IntPtr target = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, false, id);
      if (target == IntPtr.Zero) {
        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_INVALID_PARAMETER) continue; // 列挙後に自然終了して消滅した。
        throw new Win32Exception(error, "OpenProcess");
      }
      try {
        bool belongs;
        Check(IsProcessInJob(target, job, out belongs), "IsProcessInJob");
        if (!belongs) continue;
        if (StopProcess(target)) evidence.Stopped = reason;
      } finally { CloseHandle(target); }
    }
  }

  static void StopOwnedJob(IntPtr observer, ref IntPtr terminationJob, ProcessInformation process, Dictionary<uint, IntPtr> members, string reason,
      StopEvidence evidence, ref int failures, DateTime requestedAt) {
    if (ActiveProcesses(observer) == 0) return;
    try {
      if (failures < 3 && (DateTime.UtcNow - requestedAt).TotalMilliseconds < 1000) {
        StopProcesses(observer, process.Process == IntPtr.Zero ? 0 : process.ProcessId, members, reason, evidence);
        return;
      }
      if (terminationJob == IntPtr.Zero) return;
      evidence.BeforeJobSnapshot(observer);
      RetainMembers(observer, process.Process == IntPtr.Zero ? 0 : process.ProcessId, members);
      // 個別 handle の権限エラーが続いた場合は、Job 全体の停止へ進む。
      if ((DateTime.UtcNow - requestedAt).TotalMilliseconds < 2000) {
        evidence.RetainLiveTarget(process.Process);
        foreach (IntPtr target in members.Values) evidence.RetainLiveTarget(target);
        evidence.JobAttempted = true;
        if (TerminateJobObject(terminationJob, StopEvidence.JobCode)) return;
      }
      // 最後の手段でも監視用の親 Job は残す。空状態を確認する前に完了させない。
      evidence.CloseAttempted = true;
      Check(CloseHandle(terminationJob), "Close termination job");
      terminationJob = IntPtr.Zero;
    } catch (Win32Exception error) {
      failures++;
      Console.WriteLine("{\"stopError\":" + error.NativeErrorCode + "}");
      Thread.Sleep(100);
    }
  }

  public static void Run(string shell, string command) {
    IntPtr job = IntPtr.Zero, terminationJob = IntPtr.Zero, read = IntPtr.Zero, write = IntPtr.Zero, input = new IntPtr(-1);
    ProcessInformation process = new ProcessInformation();
    Dictionary<uint, IntPtr> members = new Dictionary<uint, IntPtr>();
    StopEvidence evidence = new StopEvidence();
    bool assigned = false;
    Task<string> stop = null;
    uint? code = null;
    int stopFailures = 0;
    DateTime requestedAt = DateTime.UtcNow;
    try {
      job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
      Check(job != IntPtr.Zero, "CreateJobObject");
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
      terminationJob = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
      Check(terminationJob != IntPtr.Zero, "Create termination job");
      Check(SetInformationJobObject(terminationJob, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "Set termination job limits");
      SecurityAttributes attributes = new SecurityAttributes();
      attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
      attributes.Inherit = true;
      Check(CreatePipe(out read, out write, ref attributes, 4096), "CreatePipe");
      Check(SetHandleInformation(read, 1, 0), "SetHandleInformation");
      input = CreateFileW("NUL", 0x80000000, 3, ref attributes, 3, 0, IntPtr.Zero);
      Check(input != new IntPtr(-1), "CreateFile NUL");
      StartupInfo startup = new StartupInfo();
      startup.Size = Marshal.SizeOf(typeof(StartupInfo));
      startup.Flags = STARTF_USESTDHANDLES;
      startup.Input = input;
      startup.Output = startup.Error = write;
      // Suspend -> assign -> resume で、所属前に子孫が生まれる競合をなくす。
      Check(CreateProcessW(shell, new StringBuilder("\"" + shell + "\" /d /s /c \"" + command + "\""), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process), "CreateProcess");
      Check(AssignProcessToJobObject(job, process.Process), "AssignProcessToJobObject");
      assigned = true;
      Check(AssignProcessToJobObject(terminationJob, process.Process), "Assign termination job");
      Check(ResumeThread(process.Thread) != INFINITE, "ResumeThread");
      CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
      CloseHandle(write); write = IntPtr.Zero;
      CloseHandle(input); input = new IntPtr(-1);
      using (FileStream output = new FileStream(new SafeFileHandle(read, true), FileAccess.Read, 4096, false)) {
        read = IntPtr.Zero;
        // stderr は出力専用、stdout は結果専用。コマンド出力で結果を偽装させない。
        Task copy = Task.Run(() => output.CopyTo(Console.OpenStandardError(), 4096));
        stop = Task.Run(() => Console.ReadLine());
        string requested = null;
        bool unconfirmedReported = false;
        while (true) {
          bool exited = TreeExited(job, members, ref process, ref code, evidence);
          if (exited && evidence.CanComplete(job)) break;
          if (copy.IsFaulted) copy.GetAwaiter().GetResult();
          if (stop != null && stop.IsCompleted) {
            string reason = stop.GetAwaiter().GetResult();
            if (reason != null && reason != "cancelled" && reason != "timed_out") throw new InvalidDataException("Invalid stop reason");
            if (requested == null) {
              requested = reason ?? "cancelled";
              requestedAt = DateTime.UtcNow;
            }
            stop = reason == null ? null : Task.Run(() => Console.ReadLine());
            unconfirmedReported = false;
          }
          if (exited) {
            // Job が空でも原因不明なら結果を発行せず、所有権と再停止の受付を保つ。
            if (!unconfirmedReported) Console.WriteLine("{\"stopError\":\"unconfirmed_exit\"}");
            unconfirmedReported = true;
          } else if (requested != null) {
            StopOwnedJob(job, ref terminationJob, process, members, requested, evidence, ref stopFailures, requestedAt);
          }
          Thread.Sleep(25);
        }
        ReadLeaderExit(ref process, ref code, true, evidence);
        copy.GetAwaiter().GetResult();
        Console.WriteLine("{\"code\":" + code.Value + ",\"stopped\":" + (evidence.Stopped == null ? "null" : "\"" + evidence.Stopped + "\"") + "}");
      }
    } finally {
      requestedAt = DateTime.UtcNow;
      if (assigned) {
        // 異常終了時も Job が空になる前に supervisor の所有権を手放さない。
        while (true) {
          try {
            if (TreeExited(job, members, ref process, ref code, evidence)) break;
            StopOwnedJob(job, ref terminationJob, process, members, "cancelled", evidence, ref stopFailures, requestedAt);
          } catch (Win32Exception error) {
            Console.WriteLine("{\"stopError\":" + error.NativeErrorCode + "}");
            // 監視の失敗時も停止用 Job を閉じ、監視用 Job の再照会を続ける。
            if (terminationJob != IntPtr.Zero && CloseHandle(terminationJob)) terminationJob = IntPtr.Zero;
            Thread.Sleep(100);
          }
          Thread.Sleep(25);
        }
      }
      if (!assigned && process.Process != IntPtr.Zero) {
        while (true) {
          try {
            StopProcess(process.Process);
            if (WaitForSingleObject(process.Process, 0) == 0) break;
          }
          catch (Win32Exception error) {
            Console.WriteLine("{\"stopError\":" + error.NativeErrorCode + "}");
            Thread.Sleep(100);
          }
          Thread.Sleep(25);
        }
      }
      if (terminationJob != IntPtr.Zero) CloseHandle(terminationJob);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (read != IntPtr.Zero) CloseHandle(read);
      if (write != IntPtr.Zero) CloseHandle(write);
      if (input != new IntPtr(-1)) CloseHandle(input);
    }
  }
}
`;

const ResultSchema = z.object({ code: z.number().int(), stopped: z.enum(['timed_out', 'cancelled']).nullable() }).strict();
const ReportSchema = z.union([ResultSchema, z.object({ stopError: z.union([z.number().int(), z.literal('unconfirmed_exit')]) }).strict()]);
const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

export function startWindowsWaitCommand(command: string, cwd: string, collect: (chunk: Buffer) => void): WaitCommandProcess {
  const starting = (async () => {
    const [powershell, shell] = await Promise.all([
      resolveWindowsPowerShellExecutablePathAsync(), resolveSystem32ExecutablePathAsync('cmd.exe'),
    ]);
    const managed = spawnManagedProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    }, undefined);
    let report = Buffer.alloc(0);
    let result: z.infer<typeof ResultSchema> | undefined;
    let protocolError: unknown;
    const stopFailures = new Set<(error: Error) => void>();
    managed.child.stdout!.on('data', (chunk: Buffer) => {
      if (report.length + chunk.length > 1024) { protocolError = new Error('Windows wait command result exceeds capacity'); return; }
      report = Buffer.concat([report, chunk]);
      let newline: number;
      while ((newline = report.indexOf(10)) !== -1) {
        const line = report.subarray(0, newline).toString('utf8');
        report = report.subarray(newline + 1);
        try {
          const message = ReportSchema.parse(JSON.parse(line));
          if ('stopError' in message) {
            const error = message.stopError === 'unconfirmed_exit'
              ? Object.assign(new Error('Windows wait command exit cause is unconfirmed; ownership retained for retry'), { code: 'WAIT_COMMAND_EXIT_UNCONFIRMED' })
              : new Error(`Windows wait command stop failed (${message.stopError})`);
            for (const reject of stopFailures) reject(error);
          } else result = message;
        } catch (error) { protocolError = error; }
      }
    });
    managed.child.stderr!.on('data', collect);
    // 自然終了と stop の書き込みが競合すると stdin が先に閉じる。
    managed.child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') protocolError = error;
    });
    managed.child.stdin!.write([encode(jobSource), encode(shell), encode(command), ''].join('\n'));
    // 汎用 wait() は停止失敗でも reject する。所有権は supervisor の close まで保持する。
    const closed = new Promise<void>((resolve) => { managed.child.once('close', () => resolve()); });
    const completion: Promise<WaitCommandExit> = closed.then(async () => {
      const exit = await managed.waitForExit();
      if (protocolError !== undefined) throw protocolError;
      if (exit.code !== 0) throw new Error('Windows wait command supervisor failed');
      if (result === undefined) throw new Error('Windows wait command supervisor exited without a result');
      return { code: result.code, signal: null, stopped: result.stopped ?? undefined };
    }).finally(() => { managed.child.stdin!.destroy(); });
    return { managed, completion, stopFailures };
  })();
  let stopping: Promise<void> | undefined;
  return {
    async wait() { return (await starting).completion; },
    stop(reason: WaitCommandStop) {
      return stopping ??= (async () => {
        const { managed, completion, stopFailures } = await starting;
        const deadline = new AbortController();
        let rejectStop!: (error: Error) => void;
        const failure = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
        stopFailures.add(rejectStop);
        try {
          managed.child.stdin!.write(`${reason}\n`);
          const settled = await Promise.race([
            completion.then(() => true),
            failure,
            delay(5000, false, { signal: deadline.signal }),
          ]);
          // supervisor を強制終了すると Job の消滅を確認する所有者を失う。
          if (!settled) throw new Error('Windows wait command job termination deadline exceeded');
        } finally { stopFailures.delete(rejectStop); deadline.abort(); }
      })().finally(() => { stopping = undefined; });
    },
  };
}
